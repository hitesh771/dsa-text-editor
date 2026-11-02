import http from 'node:http';
import fs from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { Rope } from './rope.ts';
import { transform, applyOpToRope, getOpLength } from './transform.ts';
import { IntervalTree, type IntervalData } from './intervalTree.ts';
import { AssetManager } from './assetManager.ts';
import { PersistenceManager } from './persistence.ts';
import type {
  Operation,
  Message,
  JoinMessage,
  OperationMessage,
  OpMessage,
  HistoryRequestMessage,
  SnapshotRequestMessage,
  PresenceUpdateMessage,
  PresenceRecord,
  ClientInfo,
  CommittedOperation,
} from './types.ts';

/**
 * Authoritative document session state on the collaboration server
 */
export interface DocumentSession {
  documentId: string;
  masterRope: Rope;
  globalRevision: number;
  history: CommittedOperation[];
  clients: Map<string, { ws: WebSocket; info: ClientInfo }>;
  processedOperationIds: Set<string>;
  intervalTree: IntervalTree<IntervalData>;
  presenceMap: Map<string, PresenceRecord>;
}

/**
 * Authoritative Collaborative Text Editor Server with persistent asset management
 * and interval-indexed collaborator presence
 */
export class CollabServer {
  public httpServer: http.Server;
  public wss: WebSocketServer;
  public docs: Map<string, DocumentSession>;
  public assetManager: AssetManager;
  public persistence: PersistenceManager;

  constructor(port: number, storageDir?: string, dbDir?: string) {
    this.docs = new Map();
    this.assetManager = new AssetManager(storageDir);
    this.persistence = new PersistenceManager(dbDir);

    // Initialize HTTP server for REST endpoints (asset uploads & downloads)
    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    // Attach WebSocket server to the same HTTP server instance
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    this.httpServer.listen(port, () => {
      console.log(`Authoritative Collaborative Server started on port ${port} (HTTP & WebSockets)`);
    });

    // Periodic stale presence cleanup every 30 seconds
    const staleTimer = setInterval(() => {
      this.cleanupStalePresence();
    }, 30000);
    staleTimer.unref();
  }

  /**
   * Retrieves or initializes a document session
   */
  public getOrCreateDocument(documentId: string): DocumentSession {
    let doc = this.docs.get(documentId);
    if (!doc) {
      const persisted = this.persistence.loadOrInitDocument(documentId);
      doc = {
        documentId,
        masterRope: persisted.masterRope,
        globalRevision: persisted.globalRevision,
        history: persisted.history,
        clients: new Map(),
        processedOperationIds: persisted.processedOperationIds,
        intervalTree: new IntervalTree<IntervalData>(),
        presenceMap: new Map(),
      };
      this.docs.set(documentId, doc);
    }
    return doc;
  }

  public getDocument(documentId: string): DocumentSession | undefined {
    return this.docs.get(documentId);
  }

  /**
   * Cleans up stale presence entries across all active documents
   */
  public cleanupStalePresence(ttlMs: number = 60000): void {
    const now = Date.now();
    for (const [docId, doc] of this.docs.entries()) {
      const removed = doc.intervalTree.cleanupStale(ttlMs, now);
      for (const clientId of removed) {
        doc.presenceMap.delete(clientId);
        this.broadcast(docId, {
          type: 'presence_broadcast',
          docId,
          clientId,
          action: 'stale_removed',
        });
      }
    }
  }

  /**
   * Handles incoming HTTP requests for asset upload and retrieval
   */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS headers for multi-client development origins
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Document-Id, X-Filename');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 1. POST /api/documents/:docId/assets or POST /api/assets
    if (req.method === 'POST' && (pathname.startsWith('/api/documents/') || pathname === '/api/assets')) {
      let docId = 'default';
      const docMatch = pathname.match(/^\/api\/documents\/([^/]+)\/assets/);
      if (docMatch) {
        docId = docMatch[1];
      } else if (req.headers['x-document-id']) {
        docId = String(req.headers['x-document-id']);
      }

      const fileName = (req.headers['x-filename'] as string) || `upload_${Date.now()}`;
      const contentType = req.headers['content-type'] || 'application/octet-stream';

      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          const metadata = await this.assetManager.saveAsset(docId, fileName, contentType, buffer);

          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, asset: metadata }));
        } catch (error: any) {
          console.error('Asset upload failed:', error);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: error.message || 'Upload failed' }));
        }
      });
      return;
    }

    // 2. GET /api/assets/:assetId/metadata
    const metaMatch = pathname.match(/^\/api\/assets\/([^/]+)\/metadata$/);
    if (req.method === 'GET' && metaMatch) {
      try {
        const assetId = metaMatch[1];
        const { metadata } = this.assetManager.getAsset(assetId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metadata));
      } catch (err: any) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Not found' }));
      }
      return;
    }

    // 3. GET /api/assets/:assetId (Download binary content)
    const assetMatch = pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (req.method === 'GET' && assetMatch) {
      try {
        const assetId = assetMatch[1];
        const { metadata, filePath } = this.assetManager.getAsset(assetId);

        res.writeHead(200, {
          'Content-Type': metadata.mimeType,
          'Content-Length': metadata.sizeBytes,
          'Content-Disposition': `inline; filename="${encodeURIComponent(metadata.originalFileName)}"`,
          'Cache-Control': 'public, max-age=86400',
        });

        fs.createReadStream(filePath).pipe(res);
      } catch (err: any) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Not found' }));
      }
      return;
    }

    // 4. GET /api/documents/:docId/assets
    const listMatch = pathname.match(/^\/api\/documents\/([^/]+)\/assets$/);
    if (req.method === 'GET' && listMatch) {
      const docId = listMatch[1];
      const assets = this.assetManager.getAssetsForDocument(docId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(assets));
      return;
    }

    // Health check
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', documents: this.docs.size }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }

  /**
   * Handles incoming WebSocket connection
   */
  private handleConnection(ws: WebSocket): void {
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(ws, message);
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
        ws.send(JSON.stringify({ type: 'error', code: 'INVALID_FORMAT', message: 'Invalid message JSON' }));
      }
    });

    ws.on('close', () => {
      this.handleDisconnect(ws);
    });

    ws.on('error', (error: Error) => {
      console.error('WebSocket connection error:', error);
    });
  }

  /**
   * Dispatches incoming client messages to appropriate handlers
   */
  public handleMessage(ws: WebSocket, message: any): void {
    switch (message.type) {
      case 'join':
        this.handleJoin(ws, message as JoinMessage);
        break;
      case 'operation':
      case 'op':
        this.handleOperation(ws, message);
        break;
      case 'history_request':
        this.handleHistoryRequest(ws, message as HistoryRequestMessage);
        break;
      case 'snapshot_request':
        this.handleSnapshotRequest(ws, message as SnapshotRequestMessage);
        break;
      case 'presence_update':
      case 'cursor':
        this.handlePresence(ws, message);
        break;
      case 'disconnect':
        this.handleDisconnect(ws);
        break;
      default:
        console.warn('Unknown message type:', message.type);
        ws.send(JSON.stringify({ type: 'error', code: 'UNKNOWN_TYPE', message: `Unknown type ${message.type}` }));
    }
  }

  /**
   * Handles client joining a document session room
   */
  private handleJoin(ws: WebSocket, message: JoinMessage): void {
    const docId = message.docId || 'default';
    const clientId = message.clientId || this.generateClientId();
    const clientName = message.clientName || `User ${clientId.slice(0, 6)}`;

    const doc = this.getOrCreateDocument(docId);

    // Evict any existing socket for the same clientId
    if (doc.clients.has(clientId)) {
      this.broadcast(docId, { type: 'disconnect', clientId }, clientId);
      doc.clients.delete(clientId);
      doc.intervalTree.delete(clientId);
      doc.presenceMap.delete(clientId);
    }

    const color = this.generateColor(clientId);
    const clientInfo: ClientInfo = {
      id: clientId,
      name: clientName,
      color,
      cursorX: 0,
      cursorY: 0,
    };

    doc.clients.set(clientId, { ws, info: clientInfo });

    // Send joined confirmation with authoritative snapshot and globalRevision
    ws.send(
      JSON.stringify({
        type: 'joined',
        docId,
        clientId,
        globalRevision: doc.globalRevision,
        doc: doc.masterRope.toString(),
        pieces: doc.masterRope.getPieces(),
        clients: Array.from(doc.clients.values()).map((c) => c.info),
        selections: doc.intervalTree.getAll(),
      })
    );

    // Broadcast presence update of the new participant
    this.broadcast(
      docId,
      {
        type: 'presence_broadcast',
        docId,
        clientId,
        presence: {
          documentId: docId,
          clientId,
          userName: clientName,
          color,
          cursor: 0,
          selectionStart: 0,
          selectionEnd: 0,
          lastUpdated: Date.now(),
        },
      },
      clientId
    );
  }

  /**
   * Handles client submission of a document edit operation
   */
  private handleOperation(ws: WebSocket, message: any): void {
    const docId = message.docId || message.documentId || 'default';
    const clientId = message.clientId;
    const operationId = message.operationId;
    const baseRevision = message.baseRevision;
    const op: Operation = message.op || message.operation;

    if (!clientId || !operationId || baseRevision === undefined || !op) {
      ws.send(JSON.stringify({ type: 'error', code: 'INVALID_OPERATION_PAYLOAD', message: 'Missing fields', operationId }));
      return;
    }

    const doc = this.getOrCreateDocument(docId);

    // Verify sender membership
    if (!doc.clients.has(clientId)) {
      ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED_SENDER', message: 'Join room first', operationId }));
      return;
    }

    // Atomic SQLite commit: handles duplicate check, revision validation, OT transform, durable log, and snapshotting
    const commitRes = this.persistence.commitOperationAtomic(
      docId,
      clientId,
      operationId,
      baseRevision,
      op,
      doc.masterRope
    );

    if (!commitRes.success) {
      const code = commitRes.error?.includes('INVALID_BASE_REVISION')
        ? 'INVALID_BASE_REVISION'
        : 'OPERATION_FAILED';
      ws.send(
        JSON.stringify({
          type: 'error',
          code,
          message: commitRes.error,
          operationId,
        })
      );
      return;
    }

    // Idempotent ACK on duplicate (lost ACK recovery)
    if (commitRes.isDuplicate) {
      ws.send(
        JSON.stringify({
          type: 'ack',
          docId,
          operationId,
          serverRevision: commitRes.committedOp!.serverRevision,
          clientSeq: op.clientSeq,
        })
      );
      return;
    }

    const committedOp = commitRes.committedOp!;
    doc.globalRevision = commitRes.newGlobalRevision!;
    doc.history.push(committedOp);
    doc.processedOperationIds.add(operationId);

    // Position maintenance: Shift all active selections in Interval Tree
    let delta = 0;
    if (committedOp.op.type === 'insert') {
      delta = committedOp.op.text?.length || 0;
    } else if (committedOp.op.type === 'insert_embed') {
      delta = 1;
    } else if (committedOp.op.type === 'delete') {
      delta = -(committedOp.op.len || 0);
    } else if (committedOp.op.type === 'composite' && committedOp.op.ops) {
      for (const sub of committedOp.op.ops) {
        if (sub.type === 'insert') delta += sub.text?.length || 0;
        else if (sub.type === 'delete') delta -= sub.len || 0;
      }
    }

    if (delta !== 0) {
      doc.intervalTree.shiftAll(committedOp.op.pos, delta);
    }

    // ACK sender unicast
    ws.send(
      JSON.stringify({
        type: 'ack',
        docId,
        operationId,
        serverRevision: doc.globalRevision,
        clientSeq: op.clientSeq,
      })
    );

    // Peer broadcast authoritative committed operation
    this.broadcast(
      docId,
      {
        type: 'operation_committed',
        docId,
        documentId: docId,
        operationId,
        clientId,
        serverRevision: doc.globalRevision,
        op: committedOp.op,
      },
      clientId
    );
  }

  private handleHistoryRequest(ws: WebSocket, message: HistoryRequestMessage): void {
    const docId = message.docId || message.documentId || 'default';
    const doc = this.docs.get(docId);
    if (!doc) {
      ws.send(JSON.stringify({ type: 'error', code: 'DOC_NOT_FOUND', message: 'Document not found' }));
      return;
    }

    const fromRev = Math.max(0, message.fromRevision || 0);
    const toRev = message.toRevision !== undefined ? Math.min(message.toRevision, doc.globalRevision) : doc.globalRevision;

    // Retrieve operations from persistent storage
    const ops = this.persistence.getOperationsRange(docId, fromRev + 1, toRev);

    ws.send(
      JSON.stringify({
        type: 'history_response',
        docId,
        documentId: docId,
        fromRevision: fromRev,
        toRevision: toRev,
        operations: ops,
      })
    );
  }

  private handleSnapshotRequest(ws: WebSocket, message: SnapshotRequestMessage): void {
    const docId = message.docId || message.documentId || 'default';
    const doc = this.docs.get(docId);
    if (!doc) {
      ws.send(JSON.stringify({ type: 'error', code: 'DOC_NOT_FOUND', message: 'Document not found' }));
      return;
    }

    ws.send(
      JSON.stringify({
        type: 'snapshot_response',
        docId,
        revision: doc.globalRevision,
        doc: doc.masterRope.toString(),
        pieces: doc.masterRope.getPieces(),
      })
    );
  }

  /**
   * Handles collaborator presence updates and detects overlapping text selections
   */
  private handlePresence(ws: WebSocket, message: any): void {
    const docId = message.docId || message.documentId || 'default';
    const clientId = message.clientId;

    const doc = this.docs.get(docId);
    if (!doc || !clientId) return;

    const client = doc.clients.get(clientId);
    const userName = message.userName || client?.info.name || clientId.slice(0, 8);
    const color = message.color || client?.info.color || '#3b82f6';

    const selStart = message.selectionStart !== undefined ? Math.max(0, message.selectionStart) : 0;
    const selEnd = message.selectionEnd !== undefined ? Math.max(selStart, message.selectionEnd) : selStart;
    const cursor = message.cursor !== undefined ? message.cursor : selStart;

    const presenceData: IntervalData = {
      clientId,
      userName,
      color,
      cursor,
      lastUpdated: Date.now(),
    };

    // Update interval tree
    doc.intervalTree.update(clientId, selStart, selEnd, presenceData);

    const presenceRecord: PresenceRecord = {
      documentId: docId,
      clientId,
      userName,
      color,
      cursor,
      selectionStart: selStart,
      selectionEnd: selEnd,
      cursorX: message.cursorX,
      cursorY: message.cursorY,
      lastUpdated: Date.now(),
      revision: doc.globalRevision,
    };

    doc.presenceMap.set(clientId, presenceRecord);

    // Query overlapping selections among other collaborators
    const overlapping = doc.intervalTree
      .findOverlapping(selStart, selEnd)
      .filter((i) => i.data.clientId !== clientId);

    const overlappingClientIds = overlapping.map((i) => i.data.clientId);

    // Broadcast presence update with overlap detection to room peers
    this.broadcast(
      docId,
      {
        type: 'presence_broadcast',
        docId,
        documentId: docId,
        clientId,
        presence: presenceRecord,
        selectionStart: selStart,
        selectionEnd: selEnd,
        cursor,
        cursorX: message.cursorX,
        cursorY: message.cursorY,
        overlappingClientIds,
      },
      clientId
    );
  }

  private handleDisconnect(ws: WebSocket): void {
    for (const [docId, doc] of this.docs.entries()) {
      for (const [clientId, client] of doc.clients.entries()) {
        if (client.ws === ws) {
          doc.clients.delete(clientId);
          doc.intervalTree.delete(clientId);
          doc.presenceMap.delete(clientId);

          this.broadcast(docId, {
            type: 'presence_broadcast',
            docId,
            clientId,
            action: 'disconnect',
          });
          return;
        }
      }
    }
  }

  public broadcast(docId: string, message: any, excludeClientId?: string): void {
    const doc = this.docs.get(docId);
    if (!doc) return;

    const serialized = JSON.stringify(message);
    for (const [clientId, client] of doc.clients.entries()) {
      if (clientId !== excludeClientId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(serialized);
      }
    }
  }

  public getStats(): { docs: number; clients: number } {
    let clientCount = 0;
    for (const doc of this.docs.values()) {
      clientCount += doc.clients.size;
    }
    return { docs: this.docs.size, clients: clientCount };
  }

  public close(): Promise<void> {
    return new Promise((resolve) => {
      try {
        this.persistence.close();
      } catch {}
      this.wss.close(() => {
        this.httpServer.close(() => {
          resolve();
        });
      });
    });
  }

  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  }

  private generateColor(id: string): string {
    const palette = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#ea580c'];
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash << 5) - hash + id.charCodeAt(i);
      hash |= 0;
    }
    return palette[Math.abs(hash) % palette.length];
  }
}
