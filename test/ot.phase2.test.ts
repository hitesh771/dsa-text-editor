import test, { describe, it } from 'node:test';
import assert from 'node:assert';
import { Rope } from '../shared/rope.ts';
import { transform, applyOpToRope } from '../server/src/transform.ts';
import { OTClient } from '../client/src/otClient.ts';
import type { Operation, CommittedOperation, EmbedRef } from '../shared/types.ts';

/**
 * In-memory simulation of the authoritative collaboration server
 */
class ServerSimulator {
  public documentId: string;
  public masterRope: Rope;
  public globalRevision: number = 0;
  public history: CommittedOperation[] = [];
  public processedOperationIds: Set<string> = new Set();
  public clients: Set<string> = new Set();

  constructor(documentId: string, initialText: string = '') {
    this.documentId = documentId;
    this.masterRope = new Rope(initialText);
  }

  public registerClient(clientId: string): void {
    this.clients.add(clientId);
  }

  public applyClientOperation(
    clientId: string,
    operationId: string,
    baseRevision: number,
    op: Operation
  ): {
    success: boolean;
    error?: string;
    committedOp?: CommittedOperation;
    isDuplicate?: boolean;
  } {
    if (!this.clients.has(clientId)) {
      return { success: false, error: 'UNAUTHORIZED' };
    }

    // Duplicate detection
    if (this.processedOperationIds.has(operationId)) {
      const existing = this.history.find((h) => h.operationId === operationId);
      return { success: true, committedOp: existing, isDuplicate: true };
    }

    // Validate baseRevision
    if (baseRevision < 0 || baseRevision > this.globalRevision) {
      return {
        success: false,
        error: `INVALID_BASE_REVISION: base ${baseRevision} > global ${this.globalRevision}`,
      };
    }

    // Retrieve intervening operations
    const intervening = this.history.slice(baseRevision);

    // Transform incoming operation against all intervening committed operations
    let transformedOp: Operation = { ...op };
    for (const committed of intervening) {
      transformedOp = transform(transformedOp, committed.op);
    }

    // Apply transformed operation to master Rope
    applyOpToRope(this.masterRope, transformedOp);

    // Commit
    this.globalRevision++;
    const committed: CommittedOperation = {
      operationId,
      clientId,
      serverRevision: this.globalRevision,
      baseRevision,
      op: transformedOp,
      timestamp: Date.now(),
    };

    this.history.push(committed);
    this.processedOperationIds.add(operationId);

    return { success: true, committedOp: committed, isDuplicate: false };
  }
}

/**
 * Realistic network router modeling concurrent editing, in-flight queuing, and broadcast
 */
class NetworkHub {
  public server: ServerSimulator;
  public clients: Map<string, OTClient> = new Map();

  constructor(server: ServerSimulator) {
    this.server = server;
  }

  public register(clientId: string, client: OTClient): void {
    this.server.registerClient(clientId);
    this.clients.set(clientId, client);
  }

  /**
   * Simulates simultaneous concurrent edits from multiple clients before any reach the server
   */
  public simulateConcurrentEdits(
    edits: Array<{
      clientId: string;
      type: 'insert' | 'delete' | 'insert_embed';
      pos: number;
      text?: string;
      len?: number;
      embed?: EmbedRef;
    }>,
    arrivalOrder?: string[]
  ): void {
    const inFlightMessages: Array<{ clientId: string; msg: any }> = [];

    // 1. Each client edits locally and optimistically in parallel
    for (const edit of edits) {
      const client = this.clients.get(edit.clientId)!;
      const res = client.applyLocalEdit(edit.type, edit.pos, edit.text, edit.len, edit.embed);
      if (res.shouldSend && res.opMessageToSend) {
        // Deep clone message to represent serialization over network wire
        inFlightMessages.push({
          clientId: edit.clientId,
          msg: JSON.parse(JSON.stringify(res.opMessageToSend)),
        });
      }
    }

    // 2. Determine arrival order at server
    const order = arrivalOrder || inFlightMessages.map((m) => m.clientId);

    // 3. Deliver to server one by one in arrival order
    for (const arrivingClientId of order) {
      const item = inFlightMessages.find((m) => m.clientId === arrivingClientId)!;
      this.deliverToServer(item.clientId, item.msg);
    }
  }

  public deliverToServer(clientId: string, opMsg: any): void {
    const commitRes = this.server.applyClientOperation(
      clientId,
      opMsg.operationId,
      opMsg.baseRevision,
      opMsg.op
    );

    if (!commitRes.success || !commitRes.committedOp) return;

    // A. Broadcast committed operation in real-time to all OTHER clients
    for (const [peerId, peerClient] of this.clients.entries()) {
      if (peerId !== clientId) {
        peerClient.handleRemoteCommittedOp(
          commitRes.committedOp.op,
          commitRes.committedOp.serverRevision
        );
      }
    }

    // B. Deliver ACK to the sender
    const sender = this.clients.get(clientId)!;
    const ackRes = sender.handleAck(
      commitRes.committedOp.operationId,
      commitRes.committedOp.serverRevision
    );

    // If sender had buffered operations, promote and deliver next
    if (ackRes.shouldSend && ackRes.nextOpToSend) {
      this.deliverToServer(clientId, JSON.parse(JSON.stringify(ackRes.nextOpToSend)));
    }
  }
}

describe('Phase 2: Authoritative OT, Queues & Convergence', () => {
  it('A. Same-position insertions converge across clients and server', () => {
    const initialText = 'ABCDE';
    const server = new ServerSimulator('doc1', initialText);
    const hub = new NetworkHub(server);

    const clientA = new OTClient('doc1', 'Alice', initialText, 0);
    const clientB = new OTClient('doc1', 'Bob', initialText, 0);

    hub.register('Alice', clientA);
    hub.register('Bob', clientB);

    // Both Alice and Bob concurrently insert at position 2
    hub.simulateConcurrentEdits([
      { clientId: 'Alice', type: 'insert', pos: 2, text: 'X' },
      { clientId: 'Bob', type: 'insert', pos: 2, text: 'Y' },
    ]);

    const expected = server.masterRope.toString();
    assert.strictEqual(clientA.getLocalRope().toString(), expected);
    assert.strictEqual(clientB.getLocalRope().toString(), expected);
    assert.strictEqual(expected, 'ABXYCDE'); // Alice tie-breaks before Bob
    assert.strictEqual(server.masterRope.checkInvariants().valid, true);
  });

  it('B. Concurrent insert and delete interactions converge', () => {
    const initialText = 'ABCDE';
    const server = new ServerSimulator('doc2', initialText);
    const hub = new NetworkHub(server);

    const clientA = new OTClient('doc2', 'Alice', initialText, 0);
    const clientB = new OTClient('doc2', 'Bob', initialText, 0);

    hub.register('Alice', clientA);
    hub.register('Bob', clientB);

    // Concurrently: Alice deletes 'BC' (pos 1, len 2), Bob inserts 'ZZ' at pos 2
    hub.simulateConcurrentEdits([
      { clientId: 'Alice', type: 'delete', pos: 1, len: 2 },
      { clientId: 'Bob', type: 'insert', pos: 2, text: 'ZZ' },
    ]);

    const expected = server.masterRope.toString();
    assert.strictEqual(clientA.getLocalRope().toString(), expected);
    assert.strictEqual(clientB.getLocalRope().toString(), expected);
    assert.strictEqual(server.masterRope.checkInvariants().valid, true);
  });

  it('C. Overlapping deletions converge without corrupting boundaries', () => {
    const initialText = 'ABCDEFGH';
    const server = new ServerSimulator('doc3', initialText);
    const hub = new NetworkHub(server);

    const clientA = new OTClient('doc3', 'Alice', initialText, 0);
    const clientB = new OTClient('doc3', 'Bob', initialText, 0);

    hub.register('Alice', clientA);
    hub.register('Bob', clientB);

    // Concurrently: Alice deletes [2, 5) ('CDE'), Bob deletes [3, 6) ('DEF')
    hub.simulateConcurrentEdits([
      { clientId: 'Alice', type: 'delete', pos: 2, len: 3 },
      { clientId: 'Bob', type: 'delete', pos: 3, len: 3 },
    ]);

    const expected = server.masterRope.toString();
    assert.strictEqual(clientA.getLocalRope().toString(), expected);
    assert.strictEqual(clientB.getLocalRope().toString(), expected);
    assert.strictEqual(expected, 'ABGH');
    assert.strictEqual(server.masterRope.checkInvariants().valid, true);
  });

  it('D. Rapid typing drains buffer queue in correct order', () => {
    const server = new ServerSimulator('doc4', '');
    const clientA = new OTClient('doc4', 'Alice', '', 0);

    // Alice types 5 characters rapidly before receiving any ACK
    const firstEdit = clientA.applyLocalEdit('insert', 0, 'H');
    assert.strictEqual(firstEdit.shouldSend, true);
    assert.strictEqual(clientA.getPendingCount(), 1);

    const e2 = clientA.applyLocalEdit('insert', 1, 'e');
    const e3 = clientA.applyLocalEdit('insert', 2, 'l');
    const e4 = clientA.applyLocalEdit('insert', 3, 'l');
    const e5 = clientA.applyLocalEdit('insert', 4, 'o');

    assert.strictEqual(e2.shouldSend, false);
    assert.strictEqual(e3.shouldSend, false);
    assert.strictEqual(e4.shouldSend, false);
    assert.strictEqual(e5.shouldSend, false);
    assert.strictEqual(clientA.getPendingCount(), 5);
    assert.strictEqual(clientA.getLocalRope().toString(), 'Hello');

    server.registerClient('Alice');

    // Drain sequentially as ACKs arrive
    let currentOpToSend = firstEdit.opMessageToSend!;
    while (currentOpToSend) {
      const res = server.applyClientOperation(
        'Alice',
        currentOpToSend.operationId,
        currentOpToSend.baseRevision,
        currentOpToSend.op
      );
      assert.strictEqual(res.success, true);
      const ackRes = clientA.handleAck(res.committedOp!.operationId, res.committedOp!.serverRevision);
      currentOpToSend = ackRes.nextOpToSend!;
    }

    assert.strictEqual(clientA.getPendingCount(), 0);
    assert.strictEqual(clientA.getLocalRope().toString(), 'Hello');
    assert.strictEqual(server.masterRope.toString(), 'Hello');
    assert.strictEqual(server.globalRevision, 5);
  });

  it('E. Remote operation during pending local edits transforms both outstanding and buffer', () => {
    const server = new ServerSimulator('doc5', 'START ');
    server.registerClient('Alice');
    server.registerClient('Bob');

    const clientA = new OTClient('doc5', 'Alice', 'START ', 0);
    const clientB = new OTClient('doc5', 'Bob', 'START ', 0);

    // Alice sends op1 (pos 6, 'A') -> in-flight
    const a1 = clientA.applyLocalEdit('insert', 6, 'A');
    // Alice immediately types 'B' and 'C' into buffer
    clientA.applyLocalEdit('insert', 7, 'B');
    clientA.applyLocalEdit('insert', 8, 'C');

    assert.strictEqual(clientA.getLocalRope().toString(), 'START ABC');
    assert.strictEqual(clientA.getPendingCount(), 3);

    // Meanwhile, Bob commits 'X' at position 0 on the server
    const b1 = clientB.applyLocalEdit('insert', 0, 'X');
    const resB = server.applyClientOperation(
      'Bob',
      b1.opMessageToSend!.operationId,
      b1.opMessageToSend!.baseRevision,
      b1.opMessageToSend!.op
    );
    clientB.handleAck(resB.committedOp!.operationId, resB.committedOp!.serverRevision);
    assert.strictEqual(server.masterRope.toString(), 'XSTART ');

    // Alice receives Bob's committed operation while she still has 1 outstanding and 2 buffered!
    clientA.handleRemoteCommittedOp(resB.committedOp!.op, resB.committedOp!.serverRevision);
    assert.strictEqual(clientA.getLocalRope().toString(), 'XSTART ABC');

    // Now Alice's first op reaches server
    const resA1 = server.applyClientOperation(
      'Alice',
      a1.opMessageToSend!.operationId,
      a1.opMessageToSend!.baseRevision,
      a1.opMessageToSend!.op
    );
    assert.strictEqual(resA1.success, true);
    // Alice ACKs A1, promoting A2 (rebased)
    const ackA1 = clientA.handleAck(resA1.committedOp!.operationId, resA1.committedOp!.serverRevision);
    assert.strictEqual(ackA1.shouldSend, true);

    const resA2 = server.applyClientOperation(
      'Alice',
      ackA1.nextOpToSend!.operationId,
      ackA1.nextOpToSend!.baseRevision,
      ackA1.nextOpToSend!.op
    );
    const ackA2 = clientA.handleAck(resA2.committedOp!.operationId, resA2.committedOp!.serverRevision);

    const resA3 = server.applyClientOperation(
      'Alice',
      ackA2.nextOpToSend!.operationId,
      ackA2.nextOpToSend!.baseRevision,
      ackA2.nextOpToSend!.op
    );
    clientA.handleAck(resA3.committedOp!.operationId, resA3.committedOp!.serverRevision);

    // Propagate Alice's committed ops to Bob
    clientB.handleRemoteCommittedOp(resA1.committedOp!.op, resA1.committedOp!.serverRevision);
    clientB.handleRemoteCommittedOp(resA2.committedOp!.op, resA2.committedOp!.serverRevision);
    clientB.handleRemoteCommittedOp(resA3.committedOp!.op, resA3.committedOp!.serverRevision);

    // VERIFY: Full convergence across Alice, Bob, and Server
    assert.strictEqual(clientA.getLocalRope().toString(), 'XSTART ABC');
    assert.strictEqual(clientB.getLocalRope().toString(), 'XSTART ABC');
    assert.strictEqual(server.masterRope.toString(), 'XSTART ABC');
  });

  it('F. Three-client concurrent editing achieves 100% convergence', () => {
    const initialText = 'base document';
    const server = new ServerSimulator('doc6', initialText);
    const hub = new NetworkHub(server);

    const clientA = new OTClient('doc6', 'A', initialText, 0);
    const clientB = new OTClient('doc6', 'B', initialText, 0);
    const clientC = new OTClient('doc6', 'C', initialText, 0);

    hub.register('A', clientA);
    hub.register('B', clientB);
    hub.register('C', clientC);

    hub.simulateConcurrentEdits([
      { clientId: 'A', type: 'insert', pos: 0, text: '[A] ' },
      { clientId: 'B', type: 'insert', pos: 4, text: '[B] ' },
      { clientId: 'C', type: 'insert', pos: initialText.length, text: ' [C]' },
    ]);

    const serverDoc = server.masterRope.toString();
    assert.strictEqual(clientA.getLocalRope().toString(), serverDoc);
    assert.strictEqual(clientB.getLocalRope().toString(), serverDoc);
    assert.strictEqual(clientC.getLocalRope().toString(), serverDoc);
    assert.strictEqual(server.masterRope.checkInvariants().valid, true);
  });

  it('G. Duplicate delivery is detected and idempotently acknowledged without re-applying', () => {
    const server = new ServerSimulator('doc7', 'Hello');
    server.registerClient('Alice');

    const clientA = new OTClient('doc7', 'Alice', 'Hello', 0);
    const edit = clientA.applyLocalEdit('insert', 5, ' World');

    // First delivery
    const res1 = server.applyClientOperation(
      'Alice',
      edit.opMessageToSend!.operationId,
      edit.opMessageToSend!.baseRevision,
      edit.opMessageToSend!.op
    );
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.isDuplicate, false);
    assert.strictEqual(server.masterRope.toString(), 'Hello World');
    assert.strictEqual(server.globalRevision, 1);

    // Duplicate delivery of the exact same operationId
    const res2 = server.applyClientOperation(
      'Alice',
      edit.opMessageToSend!.operationId,
      edit.opMessageToSend!.baseRevision,
      edit.opMessageToSend!.op
    );
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.isDuplicate, true);
    assert.strictEqual(res2.committedOp!.serverRevision, 1);

    // Document length and revision MUST NOT change
    assert.strictEqual(server.masterRope.toString(), 'Hello World');
    assert.strictEqual(server.globalRevision, 1);
    assert.strictEqual(server.history.length, 1);
  });

  it('H. Invalid or future base revisions are rejected by server', () => {
    const server = new ServerSimulator('doc8', 'Test');
    server.registerClient('Alice');

    const op: Operation = {
      type: 'insert',
      pos: 0,
      text: 'Bad',
      clientId: 'Alice',
      clientSeq: 1,
    };

    // Impossible future revision (globalRevision is 0, client claims baseRevision 99)
    const futureRes = server.applyClientOperation('Alice', 'op_future', 99, op);
    assert.strictEqual(futureRes.success, false);
    assert.ok(futureRes.error!.includes('INVALID_BASE_REVISION'));

    // Negative revision
    const negRes = server.applyClientOperation('Alice', 'op_neg', -1, op);
    assert.strictEqual(negRes.success, false);
    assert.ok(negRes.error!.includes('INVALID_BASE_REVISION'));

    // Master document remains pristine
    assert.strictEqual(server.masterRope.toString(), 'Test');
    assert.strictEqual(server.globalRevision, 0);
  });
});
