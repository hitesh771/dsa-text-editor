import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { PersistenceManager } from '../server/src/persistence.ts';
import { CollabServer } from '../server/src/server.ts';
import { Rope } from '../shared/rope.ts';
import { transform, applyOpToRope } from '../shared/transform.ts';
import { OTClient } from '../client/src/otClient.ts';
import type { Operation, EmbedRef } from '../shared/types.ts';

const TEST_DB_DIR = path.join(process.cwd(), 'tmp_test_db');
const TEST_STORAGE_DIR = path.join(process.cwd(), 'tmp_test_storage_phase4');

describe('Phase 4: Persistence, Snapshots, Gap Recovery & Multi-Client Execution', () => {
  before(() => {
    if (fs.existsSync(TEST_DB_DIR)) {
      fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
    if (fs.existsSync(TEST_STORAGE_DIR)) {
      fs.rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
    }
  });

  after(() => {
    if (fs.existsSync(TEST_DB_DIR)) {
      fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
    if (fs.existsSync(TEST_STORAGE_DIR)) {
      fs.rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. DURABLE SQLITE PERSISTENCE & ATOMIC COMMITS
  // =========================================================================
  describe('1. SQLite Persistence & Atomic Commits', () => {
    it('A. Commits operations atomically to SQLite and updates global revision', () => {
      const pm = new PersistenceManager(TEST_DB_DIR);
      const docId = 'doc_atomic_1';
      const rope = new Rope('');

      // Initialize doc
      pm.loadOrInitDocument(docId);

      const op1: Operation = {
        type: 'insert',
        pos: 0,
        text: 'Hello',
        clientId: 'Alice',
        clientSeq: 1,
      };

      const res = pm.commitOperationAtomic(docId, 'Alice', 'op_1', 0, op1, rope);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.isDuplicate, false);
      assert.strictEqual(res.newGlobalRevision, 1);
      assert.strictEqual(rope.toString(), 'Hello');

      pm.close();
    });

    it('B. Detects duplicate operationId on lost ACK and idempotently returns original commit', () => {
      const pm = new PersistenceManager(TEST_DB_DIR);
      const docId = 'doc_atomic_1';
      const { masterRope } = pm.loadOrInitDocument(docId);

      const opDup: Operation = {
        type: 'insert',
        pos: 0,
        text: 'Hello',
        clientId: 'Alice',
        clientSeq: 1,
      };

      // Resend exact same operationId 'op_1'
      const dupRes = pm.commitOperationAtomic(docId, 'Alice', 'op_1', 0, opDup, masterRope);
      assert.strictEqual(dupRes.success, true);
      assert.strictEqual(dupRes.isDuplicate, true);
      assert.strictEqual(dupRes.committedOp?.serverRevision, 1);
      // Master rope must NOT have double 'Hello'
      assert.strictEqual(masterRope.toString(), 'Hello');

      pm.close();
    });

    it('C. Rolls back transaction on invalid base revision and keeps state pristine', () => {
      const pm = new PersistenceManager(TEST_DB_DIR);
      const docId = 'doc_atomic_1';
      const { masterRope, globalRevision } = pm.loadOrInitDocument(docId);

      const invalidOp: Operation = {
        type: 'insert',
        pos: 0,
        text: 'Corrupted',
        clientId: 'Alice',
        clientSeq: 2,
      };

      // Claim impossible base revision 999
      const failRes = pm.commitOperationAtomic(docId, 'Alice', 'op_bad', 999, invalidOp, masterRope);
      assert.strictEqual(failRes.success, false);
      assert.ok(failRes.error?.includes('INVALID_BASE_REVISION'));

      // Verify no changes were committed
      const reload = pm.loadOrInitDocument(docId);
      assert.strictEqual(reload.globalRevision, globalRevision);
      assert.strictEqual(reload.masterRope.toString(), 'Hello');

      pm.close();
    });
  });

  // =========================================================================
  // 2. PERIODIC SNAPSHOTS & RESTART RECOVERY
  // =========================================================================
  describe('2. Periodic Snapshots & Server Restart Reconstruction', () => {
    it('A. Generates periodic snapshots and survives complete backend process restart', () => {
      const pm1 = new PersistenceManager(TEST_DB_DIR);
      const docId = 'doc_restart_test';
      const rope = new Rope('');
      pm1.loadOrInitDocument(docId);

      // Perform 15 sequential operations to trigger periodic snapshot at rev 10
      for (let i = 1; i <= 15; i++) {
        const op: Operation = {
          type: 'insert',
          pos: rope.length(),
          text: `[${i}]`,
          clientId: 'Writer',
          clientSeq: i,
        };
        pm1.commitOperationAtomic(docId, 'Writer', `op_seq_${i}`, i - 1, op, rope);
      }

      // Insert an embed reference at rev 16
      const embed: EmbedRef = { id: 'img_test_123', type: 'image', name: 'photo.png' };
      const embedOp: Operation = {
        type: 'insert_embed',
        pos: 0,
        embed,
        clientId: 'Writer',
        clientSeq: 16,
      };
      pm1.commitOperationAtomic(docId, 'Writer', 'op_seq_16', 15, embedOp, rope);

      const stateBeforeRestart = rope.toString();
      const piecesBeforeRestart = rope.getPieces();
      const revBeforeRestart = 16;

      // Verify periodic snapshot was created
      const snap = pm1.getLatestSnapshot(docId);
      assert.ok(snap !== null, 'Periodic snapshot must exist');
      assert.strictEqual(snap?.revision, 10); // created at rev 10

      // SIMULATE SHUTDOWN / CRASH
      pm1.close();

      // SIMULATE BACKEND RESTART: brand new PersistenceManager instance
      const pm2 = new PersistenceManager(TEST_DB_DIR);
      const reconstructed = pm2.loadOrInitDocument(docId);

      // VERIFY FULL RECONSTRUCTION:
      // Loaded snapshot at rev 10 + replayed ops 11..16
      assert.strictEqual(reconstructed.globalRevision, revBeforeRestart);
      assert.strictEqual(reconstructed.masterRope.toString(), stateBeforeRestart);
      assert.strictEqual(reconstructed.masterRope.length(), rope.length());

      // Verify the embed is properly restored in logical order
      const reconstructedPieces = reconstructed.masterRope.getPieces();
      assert.strictEqual(reconstructedPieces[0].type, 'embed');
      assert.strictEqual((reconstructedPieces[0] as any).embed.id, 'img_test_123');

      pm2.close();
    });
  });

  // =========================================================================
  // 3. HISTORY GAP RECOVERY & SYNCHRONIZATION BARRIER
  // =========================================================================
  describe('3. History Gap Recovery & Synchronization Barrier', () => {
    it('A. Recovers missing operations tail after client disconnect and reconnect', () => {
      const pm = new PersistenceManager(TEST_DB_DIR);
      const docId = 'doc_gap_test';
      const serverRope = new Rope('');
      pm.loadOrInitDocument(docId);

      // Client A and B start at revision 0
      const clientB = new OTClient(docId, 'Bob', '', 0);

      // Server commits 5 operations while Bob is disconnected
      for (let i = 1; i <= 5; i++) {
        const op: Operation = {
          type: 'insert',
          pos: serverRope.length(),
          text: String(i),
          clientId: 'Alice',
          clientSeq: i,
        };
        pm.commitOperationAtomic(docId, 'Alice', `op_gap_${i}`, i - 1, op, serverRope);
      }

      // Bob reconnects knowing only revision 0
      assert.strictEqual(clientB.getServerRevision(), 0);

      // Bob requests history gap [1..5]
      const missingOps = pm.getOperationsRange(docId, 1, 5);
      assert.strictEqual(missingOps.length, 5);

      // Bob catches up
      clientB.catchUpHistory(missingOps);

      // Bob and Server must be identical
      assert.strictEqual(clientB.getServerRevision(), 5);
      assert.strictEqual(clientB.getLocalRope().toString(), serverRope.toString());
      assert.strictEqual(clientB.getLocalRope().toString(), '12345');

      pm.close();
    });

    it('B. Synchronization barrier: client reconciles snapshot while concurrent edits arrive', () => {
      const docId = 'doc_barrier_test';
      const initialText = 'BASE';
      const clientA = new OTClient(docId, 'Alice', initialText, 0);

      // Alice types ' LOCAL' locally while awaiting server sync
      clientA.applyLocalEdit('insert', 4, ' LOCAL');
      assert.strictEqual(clientA.getLocalRope().toString(), 'BASE LOCAL');

      // Server authoritative snapshot at rev 1 is 'BASE REMOTE'
      clientA.reconcileWithRemote('BASE REMOTE', 1);

      // Local edit ' LOCAL' at pos 4 in 'BASE REMOTE' produces 'BASE LOCAL REMOTE'
      assert.strictEqual(clientA.getLocalRope().toString(), 'BASE LOCAL REMOTE');
      assert.strictEqual(clientA.getServerRevision(), 1);
      assert.strictEqual(clientA.getPendingCount(), 1);
    });
  });

  // =========================================================================
  // 4. MULTI-CLIENT CONVERGENCE TESTS (A, B, C, D, E, F, G, H)
  // =========================================================================
  describe('4. Multi-Client Execution Scenarios (Tests A through H)', () => {
    it('A. Two clients real-time editing converge to identical logical content', () => {
      const serverRope = new Rope('Start');
      const clientA = new OTClient('doc_m1', 'A', 'Start', 0);
      const clientB = new OTClient('doc_m1', 'B', 'Start', 0);

      // A types '!' at 5
      const editA = clientA.applyLocalEdit('insert', 5, '!');
      applyOpToRope(serverRope, editA.opMessageToSend!.op);
      clientA.handleAck(editA.opMessageToSend!.operationId, 1);
      clientB.handleRemoteCommittedOp(editA.opMessageToSend!.op, 1);

      // B types '?' at 6
      const editB = clientB.applyLocalEdit('insert', 6, '?');
      applyOpToRope(serverRope, editB.opMessageToSend!.op);
      clientB.handleAck(editB.opMessageToSend!.operationId, 2);
      clientA.handleRemoteCommittedOp(editB.opMessageToSend!.op, 2);

      assert.strictEqual(clientA.getLocalRope().toString(), 'Start!?');
      assert.strictEqual(clientB.getLocalRope().toString(), 'Start!?');
      assert.strictEqual(serverRope.toString(), 'Start!?');
    });

    it('B. Three clients concurrent editing achieve 100% convergence', () => {
      const initial = 'Collaboration';
      const clientA = new OTClient('doc_m3', 'Alice', initial, 0);
      const clientB = new OTClient('doc_m3', 'Bob', initial, 0);
      const clientC = new OTClient('doc_m3', 'Charlie', initial, 0);

      // Concurrently: Alice inserts at start, Bob at middle, Charlie at end
      const editA = clientA.applyLocalEdit('insert', 0, '[A] ');
      const editB = clientB.applyLocalEdit('insert', 6, '[B] ');
      const editC = clientC.applyLocalEdit('insert', initial.length, ' [C]');

      const opA = editA.opMessageToSend!.op;
      const opB = editB.opMessageToSend!.op;
      const opC = editC.opMessageToSend!.op;

      // Server commits order: A -> B -> C
      const serverRope = new Rope(initial);
      applyOpToRope(serverRope, opA); // Rev 1

      const opBTransformed = transform(opB, opA);
      applyOpToRope(serverRope, opBTransformed); // Rev 2

      let opCTransformed = transform(opC, opA);
      opCTransformed = transform(opCTransformed, opBTransformed);
      applyOpToRope(serverRope, opCTransformed); // Rev 3

      // Distribute committed operations
      // A receives ACK for A, then B and C
      clientA.handleAck(editA.opMessageToSend!.operationId, 1);
      clientA.handleRemoteCommittedOp(opBTransformed, 2);
      clientA.handleRemoteCommittedOp(opCTransformed, 3);

      // B receives A, ACK for B, then C
      clientB.handleRemoteCommittedOp(opA, 1);
      clientB.handleAck(editB.opMessageToSend!.operationId, 2);
      clientB.handleRemoteCommittedOp(opCTransformed, 3);

      // C receives A and B, then ACK for C
      clientC.handleRemoteCommittedOp(opA, 1);
      clientC.handleRemoteCommittedOp(opBTransformed, 2);
      clientC.handleAck(editC.opMessageToSend!.operationId, 3);

      const expected = serverRope.toString();
      assert.strictEqual(clientA.getLocalRope().toString(), expected);
      assert.strictEqual(clientB.getLocalRope().toString(), expected);
      assert.strictEqual(clientC.getLocalRope().toString(), expected);
    });
  });
});
