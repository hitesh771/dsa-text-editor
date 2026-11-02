import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { Rope, type RopePiece } from './rope.ts';
import { transform, applyOpToRope } from './transform.ts';
import type { Operation, CommittedOperation, AssetMetadata } from './types.ts';

export interface DocumentRow {
  documentId: string;
  globalRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SnapshotRecord {
  id: number;
  documentId: string;
  revision: number;
  content: string;
  pieces: RopePiece[];
  timestamp: number;
}

export class PersistenceManager {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(dbDir: string = path.join(process.cwd(), 'server', 'data')) {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this.dbPath = path.join(dbDir, 'collab.sqlite');
    this.db = new DatabaseSync(this.dbPath);

    this.initSchema();
  }

  private initSchema(): void {
    // Enable Write-Ahead Logging for high concurrency and atomic commits
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        document_id TEXT PRIMARY KEY,
        global_revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operations (
        document_id TEXT NOT NULL,
        server_revision INTEGER NOT NULL,
        base_revision INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        op_type TEXT NOT NULL,
        op_json TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (document_id, server_revision),
        UNIQUE (document_id, operation_id)
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        pieces_json TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_doc_rev 
        ON snapshots (document_id, revision DESC);

      CREATE TABLE IF NOT EXISTS assets (
        asset_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        type TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        original_file_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        checksum TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        upload_status TEXT NOT NULL
      );
    `);
  }

  /**
   * Loads an existing document from persistent storage or initializes a new one.
   * Reconstructs the master Rope by loading the latest snapshot and replaying later committed operations.
   */
  public loadOrInitDocument(documentId: string): {
    masterRope: Rope;
    globalRevision: number;
    history: CommittedOperation[];
    processedOperationIds: Set<string>;
  } {
    // 1. Ensure document record exists
    const docQuery = this.db.prepare(
      'SELECT document_id, global_revision, created_at, updated_at FROM documents WHERE document_id = ?'
    );
    let docRow = docQuery.get(documentId) as any;

    if (!docRow) {
      const now = Date.now();
      this.db
        .prepare('INSERT INTO documents (document_id, global_revision, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(documentId, 0, now, now);
      docRow = { document_id: documentId, global_revision: 0 };
    }

    // 2. Load latest snapshot if present
    const snapshotQuery = this.db.prepare(
      'SELECT id, document_id, revision, content, pieces_json, timestamp FROM snapshots WHERE document_id = ? ORDER BY revision DESC LIMIT 1'
    );
    const latestSnapshot = snapshotQuery.get(documentId) as any;

    const masterRope = new Rope('');
    let replayStartRev = 0;

    if (latestSnapshot) {
      replayStartRev = latestSnapshot.revision;
      try {
        const pieces: RopePiece[] = JSON.parse(latestSnapshot.pieces_json);
        masterRope.reconstructFromPieces(pieces);
      } catch (err) {
        console.error(`Failed to parse snapshot pieces for ${documentId}, falling back to content string`, err);
        masterRope.insert(0, latestSnapshot.content);
      }
    }

    // 3. Replay subsequent committed operations from replayStartRev onwards
    const opsQuery = this.db.prepare(
      'SELECT document_id, server_revision, base_revision, client_id, operation_id, op_type, op_json, timestamp FROM operations WHERE document_id = ? AND server_revision > ? ORDER BY server_revision ASC'
    );
    const subsequentRows = opsQuery.all(documentId, replayStartRev) as any[];

    for (const row of subsequentRows) {
      const op: Operation = JSON.parse(row.op_json);
      applyOpToRope(masterRope, op);
    }

    // 4. Load full operation history and processed operation IDs
    const allOpsQuery = this.db.prepare(
      'SELECT document_id, server_revision, base_revision, client_id, operation_id, op_type, op_json, timestamp FROM operations WHERE document_id = ? ORDER BY server_revision ASC'
    );
    const allRows = allOpsQuery.all(documentId) as any[];

    const history: CommittedOperation[] = [];
    const processedOperationIds = new Set<string>();

    for (const row of allRows) {
      const op: Operation = JSON.parse(row.op_json);
      history.push({
        operationId: row.operation_id,
        clientId: row.client_id,
        serverRevision: row.server_revision,
        baseRevision: row.base_revision,
        op,
        timestamp: row.timestamp,
      });
      processedOperationIds.add(row.operation_id);
    }

    const currentGlobalRev = docRow.global_revision;

    return {
      masterRope,
      globalRevision: currentGlobalRev,
      history,
      processedOperationIds,
    };
  }

  /**
   * Commits an incoming operation atomically inside a SQLite transaction.
   * Guarantees that globalRevision, masterRope, operation log, and processedOperationIds remain consistent.
   */
  public commitOperationAtomic(
    documentId: string,
    clientId: string,
    operationId: string,
    baseRevision: number,
    op: Operation,
    masterRope: Rope
  ): {
    success: boolean;
    isDuplicate: boolean;
    committedOp?: CommittedOperation;
    newGlobalRevision?: number;
    error?: string;
  } {
    this.db.exec('BEGIN IMMEDIATE');

    try {
      // 1. Check for duplicate operationId (Lost ACK recovery)
      const dupQuery = this.db.prepare(
        'SELECT server_revision, base_revision, client_id, operation_id, op_json, timestamp FROM operations WHERE document_id = ? AND operation_id = ?'
      );
      const existing = dupQuery.get(documentId, operationId) as any;

      if (existing) {
        this.db.exec('COMMIT');
        const existingOp: Operation = JSON.parse(existing.op_json);
        return {
          success: true,
          isDuplicate: true,
          committedOp: {
            operationId: existing.operation_id,
            clientId: existing.client_id,
            serverRevision: existing.server_revision,
            baseRevision: existing.base_revision,
            op: existingOp,
            timestamp: existing.timestamp,
          },
          newGlobalRevision: existing.server_revision,
        };
      }

      // 2. Read current authoritative global revision
      const docQuery = this.db.prepare('SELECT global_revision FROM documents WHERE document_id = ?');
      const docRow = docQuery.get(documentId) as any;
      if (!docRow) {
        this.db.exec('ROLLBACK');
        return { success: false, isDuplicate: false, error: 'DOCUMENT_NOT_FOUND' };
      }

      const currentGlobalRev: number = docRow.global_revision;

      // 3. Validate baseRevision
      if (baseRevision > currentGlobalRev || baseRevision < 0) {
        this.db.exec('ROLLBACK');
        return {
          success: false,
          isDuplicate: false,
          error: `INVALID_BASE_REVISION: base ${baseRevision} > global ${currentGlobalRev}`,
        };
      }

      // 4. Retrieve intervening operations for OT transformation
      const interveningQuery = this.db.prepare(
        'SELECT op_json FROM operations WHERE document_id = ? AND server_revision > ? ORDER BY server_revision ASC'
      );
      const interveningRows = interveningQuery.all(documentId, baseRevision) as any[];

      let transformedOp: Operation = { ...op };
      for (const row of interveningRows) {
        const committedOp: Operation = JSON.parse(row.op_json);
        transformedOp = transform(transformedOp, committedOp);
      }

      // 5. Apply transformed operation to the in-memory master Rope
      applyOpToRope(masterRope, transformedOp);

      // 6. Advance global revision and insert committed operation
      const newGlobalRev = currentGlobalRev + 1;
      const now = Date.now();

      const insertOp = this.db.prepare(`
        INSERT INTO operations (
          document_id, server_revision, base_revision, client_id, operation_id, op_type, op_json, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertOp.run(
        documentId,
        newGlobalRev,
        baseRevision,
        clientId,
        operationId,
        transformedOp.type,
        JSON.stringify(transformedOp),
        now
      );

      // 7. Update document revision
      const updateDoc = this.db.prepare(
        'UPDATE documents SET global_revision = ?, updated_at = ? WHERE document_id = ?'
      );
      updateDoc.run(newGlobalRev, now, documentId);

      // 8. Periodic Snapshot: create durable snapshot every 10 revisions
      if (newGlobalRev % 10 === 0) {
        this.createSnapshotInternal(documentId, newGlobalRev, masterRope, now);
      }

      this.db.exec('COMMIT');

      const committed: CommittedOperation = {
        operationId,
        clientId,
        serverRevision: newGlobalRev,
        baseRevision,
        op: transformedOp,
        timestamp: now,
      };

      return {
        success: true,
        isDuplicate: false,
        committedOp: committed,
        newGlobalRevision: newGlobalRev,
      };
    } catch (err: any) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      return { success: false, isDuplicate: false, error: err.message };
    }
  }

  /**
   * Internal helper to persist a snapshot
   */
  private createSnapshotInternal(documentId: string, revision: number, rope: Rope, timestamp: number): void {
    const content = rope.toString();
    const pieces = rope.getPieces();
    const insertSnapshot = this.db.prepare(`
      INSERT INTO snapshots (document_id, revision, content, pieces_json, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertSnapshot.run(documentId, revision, content, JSON.stringify(pieces), timestamp);
  }

  /**
   * Manually creates an authoritative snapshot at the current revision
   */
  public createSnapshot(documentId: string, revision: number, rope: Rope): void {
    this.createSnapshotInternal(documentId, revision, rope, Date.now());
  }

  /**
   * Retrieves the latest snapshot for a document
   */
  public getLatestSnapshot(documentId: string): SnapshotRecord | null {
    const query = this.db.prepare(
      'SELECT id, document_id, revision, content, pieces_json, timestamp FROM snapshots WHERE document_id = ? ORDER BY revision DESC LIMIT 1'
    );
    const row = query.get(documentId) as any;
    if (!row) return null;

    return {
      id: row.id,
      documentId: row.document_id,
      revision: row.revision,
      content: row.content,
      pieces: JSON.parse(row.pieces_json),
      timestamp: row.timestamp,
    };
  }

  /**
   * Retrieves ordered operations between fromRevision and toRevision (inclusive)
   */
  public getOperationsRange(documentId: string, fromRevision: number, toRevision: number): CommittedOperation[] {
    const query = this.db.prepare(`
      SELECT document_id, server_revision, base_revision, client_id, operation_id, op_type, op_json, timestamp
      FROM operations
      WHERE document_id = ? AND server_revision >= ? AND server_revision <= ?
      ORDER BY server_revision ASC
    `);
    const rows = query.all(documentId, fromRevision, toRevision) as any[];

    return rows.map((r) => ({
      operationId: r.operation_id,
      clientId: r.client_id,
      serverRevision: r.server_revision,
      baseRevision: r.base_revision,
      op: JSON.parse(r.op_json),
      timestamp: r.timestamp,
    }));
  }

  /**
   * Saves asset metadata persistently
   */
  public saveAssetMetadata(meta: AssetMetadata): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO assets (
        asset_id, document_id, type, mime_type, original_file_name, size_bytes, width, height, checksum, storage_key, created_at, upload_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      meta.assetId,
      meta.documentId,
      meta.type,
      meta.mimeType,
      meta.originalFileName,
      meta.sizeBytes,
      meta.width ?? null,
      meta.height ?? null,
      meta.checksum,
      meta.storageKey,
      meta.createdAt,
      meta.uploadStatus
    );
  }

  /**
   * Retrieves asset metadata by ID
   */
  public getAssetMetadata(assetId: string): AssetMetadata | null {
    const query = this.db.prepare('SELECT * FROM assets WHERE asset_id = ?');
    const row = query.get(assetId) as any;
    if (!row) return null;

    return {
      assetId: row.asset_id,
      documentId: row.document_id,
      type: row.type,
      mimeType: row.mime_type,
      originalFileName: row.original_file_name,
      sizeBytes: row.size_bytes,
      width: row.width ?? undefined,
      height: row.height ?? undefined,
      checksum: row.checksum,
      storageKey: row.storage_key,
      createdAt: row.created_at,
      uploadStatus: row.upload_status,
    };
  }

  public close(): void {
    this.db.close();
  }
}

