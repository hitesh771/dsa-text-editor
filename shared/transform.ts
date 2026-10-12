import type { Operation } from './types.ts';
import { Rope } from './rope.ts';

export function getOpLength(op: Operation): number {
  if (op.type === 'insert_embed') return 1;
  if (op.type === 'insert') return op.text?.length || 0;
  if (op.type === 'delete') return op.len || 0;
  if (op.type === 'composite' && op.ops) {
    return op.ops.reduce((sum, sub) => sum + getOpLength(sub), 0);
  }
  return 0;
}

export function isInsertLike(type: string): boolean {
  return type === 'insert' || type === 'insert_embed';
}

/**
 * Operational Transform (OT) implementation
 * Symmetrically transforms operation A against operation B
 * Preserves concurrent insertions without subsuming them in concurrent deletions by splitting the deletion
 */
export function transform(opA: Operation, opB: Operation): Operation {
  // If opA is composite, transform each component against opB
  if (opA.type === 'composite' && opA.ops) {
    return {
      ...opA,
      ops: opA.ops.map((sub) => transform(sub, opB)),
    };
  }

  // If opB is composite, transform opA through each component of opB sequentially
  if (opB.type === 'composite' && opB.ops) {
    let current = opA;
    for (const sub of opB.ops) {
      current = transform(current, sub);
    }
    return current;
  }

  const isAInsert = isInsertLike(opA.type);
  const isBInsert = isInsertLike(opB.type);
  const bLen = getOpLength(opB);

  // 1. Insert vs Insert (including atomic embeds)
  if (isAInsert && isBInsert) {
    if (opB.pos < opA.pos) {
      return { ...opA, pos: opA.pos + bLen };
    } else if (opB.pos > opA.pos) {
      return opA;
    } else {
      // Deterministic tie-breaking by clientId
      if (opB.clientId < opA.clientId) {
        return { ...opA, pos: opA.pos + bLen };
      } else {
        return opA;
      }
    }
  }

  // 2. Insert vs Delete
  if (isAInsert && opB.type === 'delete') {
    const deleteEnd = opB.pos + bLen;
    if (opA.pos <= opB.pos) {
      return opA;
    } else if (opA.pos >= deleteEnd) {
      return { ...opA, pos: opA.pos - bLen };
    } else {
      // Concurrent insertion inside deleted range is PRESERVED (not subsumed)
      // Since prior characters [opB.pos, opA.pos) are deleted, it lands at opB.pos
      return { ...opA, pos: opB.pos };
    }
  }

  // 3. Delete vs Insert
  if (opA.type === 'delete' && isBInsert) {
    const aLen = opA.len || 0;
    const deleteEnd = opA.pos + aLen;
    if (opB.pos <= opA.pos) {
      return { ...opA, pos: opA.pos + bLen };
    } else if (opB.pos >= deleteEnd) {
      return opA;
    } else {
      // Non-subsuming split: deletion of [opA.pos, deleteEnd) is divided into two distinct deletes around opB
      const lenBefore = opB.pos - opA.pos;
      const lenAfter = deleteEnd - opB.pos;

      const subOps: Operation[] = [];
      if (lenBefore > 0) {
        subOps.push({
          type: 'delete',
          pos: opA.pos,
          len: lenBefore,
          clientId: opA.clientId,
          clientSeq: opA.clientSeq,
        });
      }
      if (lenAfter > 0) {
        // Sequentially applied after lenBefore is deleted, the remaining slice starts at opA.pos + bLen
        subOps.push({
          type: 'delete',
          pos: opA.pos + bLen,
          len: lenAfter,
          clientId: opA.clientId,
          clientSeq: opA.clientSeq,
        });
      }

      if (subOps.length === 1) {
        return subOps[0];
      }

      return {
        type: 'composite',
        pos: opA.pos,
        clientId: opA.clientId,
        clientSeq: opA.clientSeq,
        ops: subOps,
      };
    }
  }

  // 4. Delete vs Delete
  if (opA.type === 'delete' && opB.type === 'delete') {
    const aLen = opA.len || 0;
    const aEnd = opA.pos + aLen;
    const bEnd = opB.pos + bLen;

    if (bEnd <= opA.pos) {
      return { ...opA, pos: opA.pos - bLen };
    }
    if (opB.pos >= aEnd) {
      return opA;
    }
    if (opB.pos <= opA.pos && bEnd >= aEnd) {
      return { ...opA, pos: opB.pos, len: 0 };
    }
    if (opA.pos <= opB.pos && aEnd >= bEnd) {
      return { ...opA, len: aLen - bLen };
    }
    if (opB.pos < opA.pos && bEnd > opA.pos && bEnd < aEnd) {
      return { ...opA, pos: opB.pos, len: aEnd - bEnd };
    }
    if (opB.pos > opA.pos && opB.pos < aEnd && bEnd >= aEnd) {
      return { ...opA, len: opB.pos - opA.pos };
    }
    return opA;
  }

  throw new Error(`Invalid operation types: ${opA.type} vs ${opB.type}`);
}

/**
 * Transforms an operation against a sequence of operations
 */
export function transformAgainstOps(op: Operation, ops: Operation[]): Operation {
  let transformed = op;
  for (const otherOp of ops) {
    transformed = transform(transformed, otherOp);
  }
  return transformed;
}

/**
 * Applies any operation (insert, delete, insert_embed, or composite) to a Rope
 */
export function applyOpToRope(rope: Rope, op: Operation): void {
  if (op.type === 'composite' && op.ops) {
    for (const sub of op.ops) {
      applyOpToRope(rope, sub);
    }
    return;
  }

  if (op.type === 'insert_embed' && op.embed) {
    const safePos = Math.max(0, Math.min(rope.length(), op.pos));
    rope.insertEmbed(safePos, op.embed);
  } else if (op.type === 'insert' && op.text) {
    const safePos = Math.max(0, Math.min(rope.length(), op.pos));
    rope.insert(safePos, op.text);
  } else if (op.type === 'delete' && op.len) {
    const currentLen = rope.length();
    if (op.pos < currentLen && op.len > 0) {
      const safeLen = Math.min(op.len, currentLen - op.pos);
      rope.delete(op.pos, safeLen);
    }
  }
}

