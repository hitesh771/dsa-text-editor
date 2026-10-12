/**
 * End-to-end tests for collaborative editing scenarios using the AVL Rope
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert';
import { type Operation } from '../server/src/types.ts';
import { transform } from '../server/src/transform.ts';
import { Rope } from '../server/src/rope.ts';

describe('E2E: Two-client scenario', () => {
  it('should converge when both clients insert at different positions', () => {
    const initialDoc = 'hello';
    
    // Client A inserts " world" at position 5
    const opA: Operation = {
      type: 'insert',
      pos: 5,
      text: ' world',
      clientId: 'A',
      clientSeq: 1,
    };

    // Client B inserts "!" at position 5
    const opB: Operation = {
      type: 'insert',
      pos: 5,
      text: '!',
      clientId: 'B',
      clientSeq: 1,
    };

    // Transform ops
    const opA_prime = transform(opA, opB);
    const opB_prime = transform(opB, opA);

    // Apply to document A: hello -> hello! -> hello! world
    const ropeA = new Rope(initialDoc);
    ropeA.insert(opB.pos, opB.text!);
    ropeA.insert(opA_prime.pos, opA_prime.text!);
    const docA = ropeA.toString();

    // Apply to document B: hello -> hello world -> hello! world
    const ropeB = new Rope(initialDoc);
    ropeB.insert(opA.pos, opA.text!);
    ropeB.insert(opB_prime.pos, opB_prime.text!);
    const docB = ropeB.toString();

    assert.strictEqual(docA, docB);
    assert.strictEqual(docA, 'hello world!');
    assert.strictEqual(ropeA.checkInvariants().valid, true);
    assert.strictEqual(ropeB.checkInvariants().valid, true);
  });

  it('should converge when one client inserts and another deletes', () => {
    const initialDoc = 'hello world';
    
    // Client A deletes "world" (positions 6-11)
    const opA: Operation = {
      type: 'delete',
      pos: 6,
      len: 5,
      clientId: 'A',
      clientSeq: 1,
    };

    // Client B inserts "beautiful " at position 6
    const opB: Operation = {
      type: 'insert',
      pos: 6,
      text: 'beautiful ',
      clientId: 'B',
      clientSeq: 1,
    };

    // Transform ops
    const opA_prime = transform(opA, opB);
    const opB_prime = transform(opB, opA);

    // Apply to document A
    const ropeA = new Rope(initialDoc);
    ropeA.insert(opB.pos, opB.text!);
    ropeA.delete(opA_prime.pos, opA_prime.len!);
    const docA = ropeA.toString();

    // Apply to document B
    const ropeB = new Rope(initialDoc);
    ropeB.delete(opA.pos, opA.len!);
    ropeB.insert(opB_prime.pos, opB_prime.text!);
    const docB = ropeB.toString();

    assert.strictEqual(docA, docB);
    assert.strictEqual(docA, 'hello beautiful ');
    assert.strictEqual(ropeA.checkInvariants().valid, true);
    assert.strictEqual(ropeB.checkInvariants().valid, true);
  });
});

describe('E2E: Concurrent same-position inserts', () => {
  it('should handle multiple clients inserting at the same position', () => {
    const initialDoc = 'text';

    const opA: Operation = {
      type: 'insert',
      pos: 0,
      text: 'A',
      clientId: 'clientA',
      clientSeq: 1,
    };

    const opB: Operation = {
      type: 'insert',
      pos: 0,
      text: 'B',
      clientId: 'clientB',
      clientSeq: 1,
    };

    const opC: Operation = {
      type: 'insert',
      pos: 0,
      text: 'C',
      clientId: 'clientC',
      clientSeq: 1,
    };

    // Client A applies: A, then B', then C''
    const ropeA = new Rope(initialDoc);
    ropeA.insert(opA.pos, opA.text!);
    const opB_A = transform(opB, opA);
    ropeA.insert(opB_A.pos, opB_A.text!);
    const opC_A = transform(transform(opC, opA), opB_A);
    ropeA.insert(opC_A.pos, opC_A.text!);
    const docA = ropeA.toString();

    // Client B applies: B, then A', then C''
    const ropeB = new Rope(initialDoc);
    ropeB.insert(opB.pos, opB.text!);
    const opA_B = transform(opA, opB);
    ropeB.insert(opA_B.pos, opA_B.text!);
    const opC_B = transform(transform(opC, opB), opA_B);
    ropeB.insert(opC_B.pos, opC_B.text!);
    const docB = ropeB.toString();

    // Client C applies: C, then A', then B''
    const ropeC = new Rope(initialDoc);
    ropeC.insert(opC.pos, opC.text!);
    const opA_C = transform(opA, opC);
    ropeC.insert(opA_C.pos, opA_C.text!);
    const opB_C = transform(transform(opB, opC), opA_C);
    ropeC.insert(opB_C.pos, opB_C.text!);
    const docC = ropeC.toString();

    assert.strictEqual(docA, docB);
    assert.strictEqual(docB, docC);
    assert.strictEqual(ropeA.checkInvariants().valid, true);
    assert.strictEqual(ropeB.checkInvariants().valid, true);
    assert.strictEqual(ropeC.checkInvariants().valid, true);
  });
});

describe('E2E: Overlapping deletes', () => {
  it('should handle overlapping delete operations', () => {
    const initialDoc = 'abcdefgh';

    // Client A deletes "cde" (positions 2-5)
    const opA: Operation = {
      type: 'delete',
      pos: 2,
      len: 3,
      clientId: 'A',
      clientSeq: 1,
    };

    // Client B deletes "def" (positions 3-6)
    const opB: Operation = {
      type: 'delete',
      pos: 3,
      len: 3,
      clientId: 'B',
      clientSeq: 1,
    };

    // Transform
    const opA_prime = transform(opA, opB);
    const opB_prime = transform(opB, opA);

    // Apply to client A
    const ropeA = new Rope(initialDoc);
    ropeA.delete(opA.pos, opA.len!);
    ropeA.delete(opA_prime.pos, opA_prime.len!);
    const docA = ropeA.toString();

    // Apply to client B
    const ropeB = new Rope(initialDoc);
    ropeB.delete(opB.pos, opB.len!);
    ropeB.delete(opB_prime.pos, opB_prime.len!);
    const docB = ropeB.toString();

    assert.strictEqual(docA, docB);
    assert.strictEqual(ropeA.checkInvariants().valid, true);
    assert.strictEqual(ropeB.checkInvariants().valid, true);
  });
});
