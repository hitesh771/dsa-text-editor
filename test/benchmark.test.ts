/**
 * Performance benchmark tests
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert';
import { Rope } from '../server/src/rope.ts';
import { FenwickTree } from '../server/src/fenwick.ts';
import { transform } from '../server/src/transform.ts';
import { type Operation } from '../server/src/types.ts';

describe('Performance Benchmarks', () => {
  describe('Rope Operations', () => {
    it('should complete insert operations in < 5ms for 10k char documents', () => {
      const rope = new Rope('a'.repeat(10000));
      const iterations = 100;
      
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        rope.insert(5000, 'x');
      }
      const elapsed = performance.now() - start;
      const avgTime = elapsed / iterations;
      
      assert.ok(avgTime < 5, `Insert avg ${avgTime}ms exceeds 5ms`);
    });

    it('should complete delete operations in < 5ms for 10k char documents', () => {
      const rope = new Rope('a'.repeat(10000));
      const iterations = 100;
      
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        rope.delete(5000, 10);
      }
      const elapsed = performance.now() - start;
      const avgTime = elapsed / iterations;
      
      assert.ok(avgTime < 5, `Delete avg ${avgTime}ms exceeds 5ms`);
    });

    it('should complete charAt operations in < 1ms', () => {
      const rope = new Rope('a'.repeat(10000));
      const iterations = 1000;
      
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        rope.charAt(Math.floor(Math.random() * 10000));
      }
      const elapsed = performance.now() - start;
      const avgTime = elapsed / iterations;
      
      assert.ok(avgTime < 1, `charAt avg ${avgTime}ms exceeds 1ms`);
    });

    it('should handle large documents (100k+ chars) efficiently', () => {
      const largeText = 'a'.repeat(100000);
      
      const start = performance.now();
      const rope = new Rope(largeText);
      rope.insert(50000, 'test');
      rope.delete(25000, 100);
      rope.charAt(75000);
      const elapsed = performance.now() - start;
      
      assert.ok(elapsed < 100, `Large doc elapsed ${elapsed}ms exceeds 100ms`);
    });
  });

  describe('Transform Operations', () => {
    it('should transform operations in < 1ms', () => {
      const op1: Operation = {
        type: 'insert',
        pos: 100,
        text: 'hello',
        clientId: 'A',
        clientSeq: 1,
      };

      const op2: Operation = {
        type: 'insert',
        pos: 200,
        text: 'world',
        clientId: 'B',
        clientSeq: 1,
      };

      const iterations = 1000;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        transform(op1, op2);
      }
      const elapsed = performance.now() - start;
      const avgTime = elapsed / iterations;
      
      assert.ok(avgTime < 1, `Transform avg ${avgTime}ms exceeds 1ms`);
    });
  });

  describe('End-to-End Performance', () => {
    it('should handle rapid concurrent edits efficiently', () => {
      const rope = new Rope('Hello world');
      const operations: Operation[] = [];

      // Simulate 100 rapid operations from 3 clients
      for (let i = 0; i < 100; i++) {
        const clientId = `client${i % 3}`;
        operations.push({
          type: i % 3 === 0 ? 'delete' : 'insert',
          pos: Math.floor(Math.random() * (rope.length() + 1)),
          clientId,
          clientSeq: i,
          ...(i % 3 === 0
            ? { len: Math.min(5, rope.length()) }
            : { text: 'x'.repeat(Math.floor(Math.random() * 5) + 1) }
          ),
        });
      }

      const start = performance.now();
      for (const op of operations) {
        if (op.type === 'insert' && op.text) {
          rope.insert(Math.min(op.pos, rope.length()), op.text);
        } else if (op.type === 'delete' && op.len) {
          const actualLen = Math.min(op.len, rope.length() - op.pos);
          if (actualLen > 0) {
            rope.delete(op.pos, actualLen);
          }
        }
      }
      const elapsed = performance.now() - start;

      assert.ok(elapsed < 100, `100 ops elapsed ${elapsed}ms exceeds 100ms`);
      assert.strictEqual(rope.checkInvariants().valid, true);
    });

    it('should maintain 60 FPS processing rate', () => {
      const rope = new Rope('Start text ');
      const frameTime = 1000 / 60; // ~16.67ms per frame

      let opsInFrame = 0;
      const start = performance.now();
      
      while (performance.now() - start < frameTime) {
        rope.insert(rope.length(), 'x');
        opsInFrame++;
      }

      assert.ok(opsInFrame > 10, `Ops in frame ${opsInFrame} is less than 10`);
    });
  });
});
