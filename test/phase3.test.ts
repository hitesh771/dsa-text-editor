import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { CollabServer } from '../server/src/server.ts';
import { AssetManager } from '../server/src/assetManager.ts';
import { IntervalTree } from '../shared/intervalTree.ts';
import { Rope } from '../shared/rope.ts';
import { transform, applyOpToRope } from '../shared/transform.ts';
import { OTClient } from '../client/src/otClient.ts';
import type { Operation, EmbedRef } from '../shared/types.ts';

const TEST_STORAGE_DIR = path.join(process.cwd(), 'tmp_test_uploads');

describe('Phase 3: Asset Management, Embeds, Interval Tree & Presence', () => {
  let server: CollabServer;
  const SERVER_PORT = 8990;

  before(async () => {
    // Clean test upload directory
    if (fs.existsSync(TEST_STORAGE_DIR)) {
      fs.rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
    }
    server = new CollabServer(SERVER_PORT, TEST_STORAGE_DIR);
  });

  after(async () => {
    await server.close();
    if (fs.existsSync(TEST_STORAGE_DIR)) {
      fs.rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. ASSET MANAGEMENT & VALIDATION TESTS
  // =========================================================================
  describe('1. Asset Storage, Validation & Metadata', () => {
    const assetManager = new AssetManager(TEST_STORAGE_DIR);

    it('A. PNG upload, magic byte validation, dimensions, and SHA-256 checksum', async () => {
      // 1x1 valid PNG binary buffer
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG Signature
        0x00, 0x00, 0x00, 0x0d, // IHDR chunk length (13)
        0x49, 0x48, 0x44, 0x52, // IHDR
        0x00, 0x00, 0x01, 0x2c, // Width = 300
        0x00, 0x00, 0x00, 0xc8, // Height = 200
        0x08, 0x06, 0x00, 0x00, 0x00, // bit depth, color type, etc.
        0x57, 0x0b, 0x65, 0x55, // CRC
      ]);

      const metadata = await assetManager.saveAsset('doc_asset_1', 'diagram.png', 'image/png', pngBuffer);

      assert.strictEqual(metadata.documentId, 'doc_asset_1');
      assert.strictEqual(metadata.type, 'image');
      assert.strictEqual(metadata.mimeType, 'image/png');
      assert.strictEqual(metadata.originalFileName, 'diagram.png');
      assert.strictEqual(metadata.width, 300);
      assert.strictEqual(metadata.height, 200);
      assert.strictEqual(metadata.sizeBytes, pngBuffer.length);
      assert.ok(metadata.checksum.length === 64); // SHA-256 hex string

      // Verify retrieval
      const retrieved = assetManager.getAsset(metadata.assetId);
      assert.strictEqual(retrieved.metadata.assetId, metadata.assetId);
      assert.ok(fs.existsSync(retrieved.filePath));
      const readBytes = fs.readFileSync(retrieved.filePath);
      assert.strictEqual(readBytes.length, pngBuffer.length);
    });

    it('B. PDF upload and content validation', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
      const metadata = await assetManager.saveAsset('doc_asset_1', 'spec.pdf', 'application/pdf', pdfBuffer);

      assert.strictEqual(metadata.type, 'pdf');
      assert.strictEqual(metadata.mimeType, 'application/pdf');
      assert.strictEqual(metadata.originalFileName, 'spec.pdf');
    });

    it('C. Rejects spoofed MIME types and corrupted files', async () => {
      // Fake PNG (actually text/plain)
      const fakePng = Buffer.from('NOT A REAL PNG FILE AT ALL');
      await assert.rejects(
        async () => {
          await assetManager.saveAsset('doc_asset_1', 'fake.png', 'image/png', fakePng);
        },
        (err: Error) => {
          assert.ok(err.message.includes('INVALID_FILE_SIGNATURE'));
          return true;
        }
      );
    });

    it('D. Prevents directory traversal during asset retrieval', () => {
      assert.throws(
        () => {
          assetManager.getAsset('../../../etc/passwd');
        },
        (err: Error) => {
          assert.ok(err.message.includes('INVALID_ASSET_ID'));
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 2. CSV BEHAVIOR: PASTED TEXT VS. UPLOADED ASSET
  // =========================================================================
  describe('2. CSV Distinct Workflows: Pasted Text vs Uploaded File', () => {
    it('A. Pasted CSV is treated as ordinary text and participates in OT', () => {
      const client = new OTClient('doc_csv', 'Alice', '', 0);
      const csvText = 'Name,Age,Role\nAlice,28,Engineer\nBob,32,Designer\n';

      const res = client.applyLocalEdit('insert', 0, csvText);
      assert.strictEqual(res.shouldSend, true);
      assert.strictEqual(client.getLocalRope().toString(), csvText);
      assert.strictEqual(client.getLocalRope().length(), csvText.length);
      assert.strictEqual(res.opMessageToSend?.op.type, 'insert');
      assert.strictEqual(res.opMessageToSend?.op.text, csvText);
    });

    it('B. Uploaded CSV is stored as external asset and referenced by atomic EmbedRef', async () => {
      const assetManager = new AssetManager(TEST_STORAGE_DIR);
      const csvBuffer = Buffer.from('Product,Price,Quantity\nApple,1.5,10\nOrange,2.0,5\n');
      const meta = await assetManager.saveAsset('doc_csv', 'inventory.csv', 'text/csv', csvBuffer);

      assert.strictEqual(meta.type, 'csv');
      assert.strictEqual(meta.originalFileName, 'inventory.csv');

      // Insert embed reference into Rope
      const client = new OTClient('doc_csv', 'Alice', 'Header: ', 0);
      const embed: EmbedRef = {
        id: meta.assetId,
        type: 'csv',
        name: meta.originalFileName,
        mimeType: meta.mimeType,
        size: meta.sizeBytes,
      };

      const res = client.applyLocalEdit('insert_embed', 8, undefined, undefined, embed);
      assert.strictEqual(res.shouldSend, true);
      assert.strictEqual(res.opMessageToSend?.op.type, 'insert_embed');
      assert.strictEqual(res.opMessageToSend?.op.embed?.id, meta.assetId);

      // Embed occupies exactly 1 logical unit in Rope
      assert.strictEqual(client.getLocalRope().length(), 9);
      assert.strictEqual(client.getLocalRope().get(8).type, 'embed');
    });
  });

  // =========================================================================
  // 3. INTERVAL TREE: BALANCING, DELETION, AND OVERLAP QUERIES
  // =========================================================================
  describe('3. Interval Tree Implementation & Overlap Detection', () => {
    it('A. Inserts, maintains subtree max, and preserves AVL balance', () => {
      const tree = new IntervalTree();

      // Insert multiple intervals
      tree.insert(10, 20, { clientId: 'c1', lastUpdated: Date.now() });
      tree.insert(5, 15, { clientId: 'c2', lastUpdated: Date.now() });
      tree.insert(25, 30, { clientId: 'c3', lastUpdated: Date.now() });
      tree.insert(2, 8, { clientId: 'c4', lastUpdated: Date.now() });
      tree.insert(12, 22, { clientId: 'c5', lastUpdated: Date.now() });

      assert.strictEqual(tree.checkInvariants().valid, true);
      assert.strictEqual(tree.getAll().length, 5);
      // Root subtree max must encompass all intervals (max is 30)
      assert.strictEqual(tree.root?.max, 30);
    });

    it('B. Detects overlapping selections using half-open [start, end) convention', () => {
      const tree = new IntervalTree();
      tree.insert(5, 12, { clientId: 'Alice', lastUpdated: Date.now() });
      tree.insert(8, 15, { clientId: 'Bob', lastUpdated: Date.now() });
      tree.insert(20, 25, { clientId: 'Charlie', lastUpdated: Date.now() });

      // Alice [5, 12) and Bob [8, 15) overlap over [8, 12)
      const queryAlice = tree.findOverlapping(5, 12);
      const clientIdsAlice = queryAlice.map((i) => i.data.clientId).sort();
      assert.deepStrictEqual(clientIdsAlice, ['Alice', 'Bob']);

      // Charlie [20, 25) does not overlap Alice or Bob
      const queryCharlie = tree.findOverlapping(20, 25);
      assert.strictEqual(queryCharlie.length, 1);
      assert.strictEqual(queryCharlie[0].data.clientId, 'Charlie');

      // Half-open boundary test: [12, 18) touches Alice [5, 12) at endpoint 12 -> must NOT overlap Alice
      const queryTouch = tree.findOverlapping(12, 18);
      const touchIds = queryTouch.map((i) => i.data.clientId);
      assert.ok(!touchIds.includes('Alice'), 'Half-open boundary should not overlap at endpoint');
      assert.ok(touchIds.includes('Bob')); // Bob is [8, 15), which overlaps [12, 18)
    });

    it('C. Updates and complete AVL deletion with invariant checks', () => {
      const tree = new IntervalTree();
      tree.insert(10, 20, { clientId: 'c1', lastUpdated: Date.now() });
      tree.insert(30, 40, { clientId: 'c2', lastUpdated: Date.now() });
      tree.insert(5, 15, { clientId: 'c3', lastUpdated: Date.now() });

      // Update c1 to [12, 28)
      tree.update('c1', 12, 28, { clientId: 'c1', lastUpdated: Date.now() });
      assert.strictEqual(tree.checkInvariants().valid, true);
      const updated = tree.findOverlapping(12, 28).find((i) => i.data.clientId === 'c1');
      assert.strictEqual(updated?.start, 12);
      assert.strictEqual(updated?.end, 28);

      // Delete root or intermediate node
      const deleted = tree.delete('c1');
      assert.strictEqual(deleted, true);
      assert.strictEqual(tree.checkInvariants().valid, true);
      assert.strictEqual(tree.getAll().length, 2);

      // Delete remaining
      tree.delete('c2');
      tree.delete('c3');
      assert.strictEqual(tree.getAll().length, 0);
      assert.strictEqual(tree.checkInvariants().valid, true);
    });

    it('D. Position maintenance: shiftAll shifts intervals accurately after edits', () => {
      const tree = new IntervalTree();
      tree.insert(10, 20, { clientId: 'Alice', lastUpdated: Date.now() });
      tree.insert(30, 40, { clientId: 'Bob', lastUpdated: Date.now() });

      // 1. Text insertion of length 5 at pos 15 (inside Alice's selection)
      tree.shiftAll(15, 5);
      assert.strictEqual(tree.checkInvariants().valid, true);
      const aliceAfterInsert = tree.findByClientId('Alice');
      assert.strictEqual(aliceAfterInsert?.start, 10);
      assert.strictEqual(aliceAfterInsert?.end, 25); // Expanded by 5
      const bobAfterInsert = tree.findByClientId('Bob');
      assert.strictEqual(bobAfterInsert?.start, 35); // Shifted right by 5
      assert.strictEqual(bobAfterInsert?.end, 45);

      // 2. Text deletion of length 10 at pos 5
      tree.shiftAll(5, -10);
      assert.strictEqual(tree.checkInvariants().valid, true);
      const aliceAfterDelete = tree.findByClientId('Alice');
      assert.strictEqual(aliceAfterDelete?.start, 5);
      assert.strictEqual(aliceAfterDelete?.end, 15);
    });

    it('E. Cleans up stale collaborator presence based on TTL', () => {
      const tree = new IntervalTree();
      const now = Date.now();
      tree.insert(10, 20, { clientId: 'ActiveUser', lastUpdated: now });
      tree.insert(30, 40, { clientId: 'StaleUser', lastUpdated: now - 100000 }); // 100s ago

      const removed = tree.cleanupStale(60000, now); // 60s TTL
      assert.deepStrictEqual(removed, ['StaleUser']);
      assert.strictEqual(tree.getAll().length, 1);
      assert.strictEqual(tree.getAll()[0].data.clientId, 'ActiveUser');
      assert.strictEqual(tree.checkInvariants().valid, true);
    });
  });

  // =========================================================================
  // 4. NON-SUBSUMING SPLIT DELETION CONVERGENCE TESTS
  // =========================================================================
  describe('4. Non-Subsuming Split Deletion OT Algorithm', () => {
    it('A. Concurrent delete spanning an insert splits around the insert and preserves both', () => {
      // Document: "0123456789"
      // Alice concurrently deletes [2, 8) ("234567")
      // Bob concurrently inserts "XX" at pos 4
      const aliceDelete: Operation = {
        type: 'delete',
        pos: 2,
        len: 6,
        clientId: 'Alice',
        clientSeq: 1,
      };

      const bobInsert: Operation = {
        type: 'insert',
        pos: 4,
        text: 'XX',
        clientId: 'Bob',
        clientSeq: 1,
      };

      // Path 1: Bob applied first, then Alice transformed against Bob
      const rope1 = new Rope('0123456789');
      applyOpToRope(rope1, bobInsert); // "0123XX456789"
      const aliceTransformed = transform(aliceDelete, bobInsert);

      // Alice's delete must be split into a composite operation around "XX"
      assert.strictEqual(aliceTransformed.type, 'composite');
      assert.ok(aliceTransformed.ops && aliceTransformed.ops.length === 2);
      applyOpToRope(rope1, aliceTransformed);
      const resultPath1 = rope1.toString();

      // Path 2: Alice applied first, then Bob transformed against Alice
      const rope2 = new Rope('0123456789');
      applyOpToRope(rope2, aliceDelete); // "0189"
      const bobTransformed = transform(bobInsert, aliceDelete);

      // Bob's insert must NOT be subsumed (len 0); it lands at pos 2
      assert.strictEqual(bobTransformed.type, 'insert');
      assert.strictEqual(bobTransformed.pos, 2);
      assert.strictEqual(bobTransformed.text, 'XX');
      applyOpToRope(rope2, bobTransformed);
      const resultPath2 = rope2.toString();

      // VERIFICATION:
      // Both paths must converge to "01XX89" with the inserted text intact!
      assert.strictEqual(resultPath1, '01XX89');
      assert.strictEqual(resultPath2, '01XX89');
      assert.strictEqual(resultPath1, resultPath2, 'Both transformation paths achieve 100% convergence');
    });

    it('B. User prompt case: delete [10, 50) and concurrent insert at 25 preserves insertion', () => {
      const initialText = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz';
      const deleteOp: Operation = {
        type: 'delete',
        pos: 10,
        len: 40,
        clientId: 'Alice',
        clientSeq: 1,
      };
      const insertOp: Operation = {
        type: 'insert',
        pos: 25,
        text: '---INSERTED---',
        clientId: 'Bob',
        clientSeq: 1,
      };

      // Path 1
      const r1 = new Rope(initialText);
      applyOpToRope(r1, insertOp);
      const delTransformed = transform(deleteOp, insertOp);
      applyOpToRope(r1, delTransformed);

      // Path 2
      const r2 = new Rope(initialText);
      applyOpToRope(r2, deleteOp);
      const insTransformed = transform(insertOp, deleteOp);
      applyOpToRope(r2, insTransformed);

      assert.strictEqual(r1.toString(), r2.toString());
      assert.ok(r1.toString().includes('---INSERTED---'), 'Inserted text is preserved and not subsumed');
    });
  });

  // =========================================================================
  // 5. HTTP REST API INTEGRATION TESTS
  // =========================================================================
  describe('5. HTTP Asset Upload & Retrieval Endpoints', () => {
    it('A. Uploads image via HTTP POST and retrieves it via HTTP GET', async () => {
      const pngPayload = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x91, 0x68,
      ]);

      // 1. POST upload
      const uploadRes: any = await new Promise((resolve, reject) => {
        const req = http.request(
          `http://localhost:${SERVER_PORT}/api/documents/doc_http_test/assets`,
          {
            method: 'POST',
            headers: {
              'x-document-id': 'doc_http_test',
              'x-filename': 'avatar.png',
              'content-type': 'image/png',
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const body = JSON.parse(Buffer.concat(chunks).toString());
              resolve({ statusCode: res.statusCode, body });
            });
          }
        );
        req.on('error', reject);
        req.write(pngPayload);
        req.end();
      });

      assert.strictEqual(uploadRes.statusCode, 201);
      assert.strictEqual(uploadRes.body.success, true);
      const asset = uploadRes.body.asset;
      assert.ok(asset.assetId);

      // 2. GET download binary
      const getRes: any = await new Promise((resolve, reject) => {
        http.get(`http://localhost:${SERVER_PORT}/api/assets/${asset.assetId}`, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              buffer: Buffer.concat(chunks),
            });
          });
        }).on('error', reject);
      });

      assert.strictEqual(getRes.statusCode, 200);
      assert.strictEqual(getRes.headers['content-type'], 'image/png');
      assert.strictEqual(getRes.buffer.length, pngPayload.length);
    });
  });
});

