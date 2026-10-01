/**
 * Fenwick Tree edge case tests
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert';
import { FenwickTree } from '../server/src/fenwick.ts';

describe('Fenwick Tree - Edge Cases', () => {
  it('should handle empty tree queries', () => {
    const tree = new FenwickTree(10);
    assert.strictEqual(tree.query(0), 0);
    assert.strictEqual(tree.query(5), 0);
    assert.strictEqual(tree.query(9), 0);
  });

  it('should handle single element updates', () => {
    const tree = new FenwickTree(10);
    tree.update(0, 5);
    assert.strictEqual(tree.query(0), 5);
    assert.strictEqual(tree.query(1), 5);
    assert.strictEqual(tree.query(5), 5);
  });

  it('should handle boundary index updates', () => {
    const tree = new FenwickTree(100);
    tree.update(0, 1);
    tree.update(99, 1);
    assert.strictEqual(tree.query(0), 1);
    assert.strictEqual(tree.query(50), 1);
    assert.strictEqual(tree.query(99), 2);
  });

  it('should handle negative deltas', () => {
    const tree = new FenwickTree(10);
    tree.update(0, 10);
    tree.update(5, 5);
    assert.strictEqual(tree.query(9), 15);
    
    tree.update(3, -3);
    assert.strictEqual(tree.query(9), 12);
  });

  it('should handle consecutive inserts at same position', () => {
    const tree = new FenwickTree(100);
    tree.addInsert(10, 5);  // Insert 5 chars at pos 10
    tree.addInsert(10, 3);  // Insert 3 more chars at pos 10
    
    assert.strictEqual(tree.query(9), 0);   // Before insert position
    assert.strictEqual(tree.query(10), 8);  // At insert position: 5 + 3
    assert.strictEqual(tree.query(20), 8);  // After insert position
  });

  it('should handle consecutive deletes at same position', () => {
    const tree = new FenwickTree(100);
    tree.addDelete(10, 5);  // Delete 5 chars at pos 10
    tree.addDelete(10, 3);  // Delete 3 more chars at pos 10
    
    assert.strictEqual(tree.query(9), 0);    // Before delete position
    assert.strictEqual(tree.query(10), -8);  // At delete position: -5 + -3
    assert.strictEqual(tree.query(20), -8);  // After delete position
  });

  it('should handle interleaved inserts and deletes', () => {
    const tree = new FenwickTree(100);
    tree.addInsert(10, 5);   // +5 at pos 10
    tree.addDelete(20, 3);   // -3 at pos 20
    tree.addInsert(15, 2);   // +2 at pos 15
    tree.addDelete(25, 4);   // -4 at pos 25
    
    assert.strictEqual(tree.query(9), 0);
    assert.strictEqual(tree.query(10), 5);
    assert.strictEqual(tree.query(15), 7);    // 5 + 2
    assert.strictEqual(tree.query(20), 4);    // 5 + 2 - 3
    assert.strictEqual(tree.query(25), 0);    // 5 + 2 - 3 - 4
    assert.strictEqual(tree.query(50), 0);    // 5 + 2 - 3 - 4
  });

  it('should handle large index values', () => {
    const tree = new FenwickTree(10000);
    tree.update(5000, 100);
    tree.update(9999, 50);
    
    assert.strictEqual(tree.query(4999), 0);
    assert.strictEqual(tree.query(5000), 100);
    assert.strictEqual(tree.query(9999), 150);
  });

  it('should handle zero-length operations', () => {
    const tree = new FenwickTree(100);
    tree.addInsert(10, 0);  // Insert 0 chars
    tree.addDelete(20, 0);  // Delete 0 chars
    
    assert.strictEqual(tree.query(50), 0);
  });

  it('should maintain consistency after many operations', () => {
    const tree = new FenwickTree(1000);
    let expectedSum = 0;
    
    // Perform 100 random operations
    for (let i = 0; i < 100; i++) {
      const pos = Math.floor(Math.random() * 500);
      const delta = Math.floor(Math.random() * 10) - 5;  // -5 to 4
      tree.update(pos, delta);
      expectedSum += delta;
    }
    
    assert.strictEqual(tree.query(999), expectedSum);
  });

  it('should handle 10000 operations efficiently', () => {
    const tree = new FenwickTree(10000);
    const start = Date.now();
    
    for (let i = 0; i < 10000; i++) {
      tree.update(i % 10000, 1);
    }
    
    for (let i = 0; i < 10000; i++) {
      tree.query(i % 10000);
    }
    
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `Execution took ${elapsed}ms, expected < 200ms`);
  });
});
