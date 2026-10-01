import test, { describe } from 'node:test';
import assert from 'node:assert';
import { Rope } from '../src/rope.ts';

describe('Server Rope Data Structure (AVL-Balanced)', () => {
  test('Create empty rope', () => {
    const rope = new Rope();
    assert.strictEqual(rope.length(), 0);
    assert.strictEqual(rope.toString(), '');
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  test('Create rope with initial text', () => {
    const rope = new Rope('Hello World');
    assert.strictEqual(rope.length(), 11);
    assert.strictEqual(rope.toString(), 'Hello World');
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  test('Insert at position 0', () => {
    const rope = new Rope('World');
    rope.insert(0, 'Hello ');
    assert.strictEqual(rope.toString(), 'Hello World');
    assert.strictEqual(rope.length(), 11);
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  test('Insert at middle position', () => {
    const rope = new Rope('Hello World');
    rope.insert(6, 'Beautiful ');
    assert.strictEqual(rope.toString(), 'Hello Beautiful World');
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  test('Insert at end position', () => {
    const rope = new Rope('Hello');
    rope.insert(5, ' World');
    assert.strictEqual(rope.toString(), 'Hello World');
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  test('Delete at start', () => {
    const rope = new Rope('Hello World');
    rope.delete(0, 6);
    assert.strictEqual(rope.toString(), 'World');
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  test('Delete at middle', () => {
    const rope = new Rope('Hello Beautiful World');
    rope.delete(6, 10);
    assert.strictEqual(rope.toString(), 'Hello World');
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  test('Delete at end', () => {
    const rope = new Rope('Hello World');
    rope.delete(5, 6);
    assert.strictEqual(rope.toString(), 'Hello');
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  test('charAt for all positions', () => {
    const rope = new Rope('Hello');
    assert.strictEqual(rope.charAt(0), 'H');
    assert.strictEqual(rope.charAt(1), 'e');
    assert.strictEqual(rope.charAt(4), 'o');
  });

  test('substring edge cases', () => {
    const rope = new Rope('Hello World');
    assert.strictEqual(rope.substring(0, 5), 'Hello');
    assert.strictEqual(rope.substring(6, 11), 'World');
    assert.strictEqual(rope.substring(0, 11), 'Hello World');
  });

  test('Multiple insertions maintain structure', () => {
    const rope = new Rope('');
    rope.insert(0, 'a');
    rope.insert(1, 'b');
    rope.insert(2, 'c');
    rope.insert(3, 'd');
    rope.insert(4, 'e');
    assert.strictEqual(rope.toString(), 'abcde');
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  test('Multiple deletions maintain structure', () => {
    const rope = new Rope('abcdefgh');
    rope.delete(6, 2);  // Remove 'gh'
    rope.delete(4, 2);  // Remove 'ef'
    assert.strictEqual(rope.toString(), 'abcd');
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  test('Mixed operations', () => {
    const rope = new Rope('Hello');
    rope.insert(5, ' ');
    rope.insert(6, 'World');
    rope.delete(0, 6);
    assert.strictEqual(rope.toString(), 'World');
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  test('Handle Unicode and emoji', () => {
    const rope = new Rope('Hello 🌍');
    assert.strictEqual(rope.toString(), 'Hello 🌍');
    rope.insert(6, '👋 ');
    assert.ok(rope.toString().includes('👋'));
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  test('Large document handling', () => {
    const text = 'a'.repeat(1000);
    const rope = new Rope(text);
    assert.strictEqual(rope.length(), 1000);
    rope.insert(500, 'X');
    assert.strictEqual(rope.length(), 1001);
    assert.strictEqual(rope.checkInvariants().valid, true);
  });
});
