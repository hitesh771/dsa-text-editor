import test, { describe, it } from 'node:test';
import assert from 'node:assert';
import { Rope, RopeNode, type EmbedRef } from '../shared/rope.ts';

describe('Phase 1: AVL Rope Core & Balancing Invariants', () => {
  it('Empty Rope handles queries and invariants correctly', () => {
    const rope = new Rope();
    assert.strictEqual(rope.length(), 0);
    assert.strictEqual(rope.isEmpty(), true);
    assert.strictEqual(rope.toString(), '');
    assert.strictEqual(rope.substring(0, 5), '');
    assert.strictEqual(rope.getPieces().length, 0);

    const inv = rope.checkInvariants();
    assert.strictEqual(inv.valid, true);
    assert.strictEqual(inv.nodeCount, 0);

    assert.throws(() => rope.charAt(0), /empty/);
  });

  it('Creates rope with initial text and verifies invariants', () => {
    const rope = new Rope('Hello, World!');
    assert.strictEqual(rope.length(), 13);
    assert.strictEqual(rope.isEmpty(), false);
    assert.strictEqual(rope.toString(), 'Hello, World!');

    const inv = rope.checkInvariants();
    assert.strictEqual(inv.valid, true);
    assert.strictEqual(inv.maxBalanceDiff, 0);
  });

  it('Insert at beginning, middle, and end', () => {
    const rope = new Rope('World');

    // Insert at beginning (pos 0)
    rope.insert(0, 'Hello ');
    assert.strictEqual(rope.toString(), 'Hello World');
    assert.strictEqual(rope.length(), 11);
    assert.strictEqual(rope.checkInvariants().valid, true);

    // Insert at middle (pos 6)
    rope.insert(6, 'Beautiful ');
    assert.strictEqual(rope.toString(), 'Hello Beautiful World');
    assert.strictEqual(rope.length(), 21);
    assert.strictEqual(rope.checkInvariants().valid, true);

    // Insert at end (pos length)
    rope.insert(rope.length(), '!');
    assert.strictEqual(rope.toString(), 'Hello Beautiful World!');
    assert.strictEqual(rope.length(), 22);
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  it('Delete at beginning, middle, and end', () => {
    const rope = new Rope('Hello Beautiful World!');

    // Delete at end: remove '!'
    rope.delete(21, 1);
    assert.strictEqual(rope.toString(), 'Hello Beautiful World');
    assert.strictEqual(rope.checkInvariants().valid, true);

    // Delete at middle: remove 'Beautiful ' (length 10 at pos 6)
    rope.delete(6, 10);
    assert.strictEqual(rope.toString(), 'Hello World');
    assert.strictEqual(rope.checkInvariants().valid, true);

    // Delete at beginning: remove 'Hello ' (length 6 at pos 0)
    rope.delete(0, 6);
    assert.strictEqual(rope.toString(), 'World');
    assert.strictEqual(rope.checkInvariants().valid, true);

    // Delete entire remainder
    rope.delete(0, 5);
    assert.strictEqual(rope.length(), 0);
    assert.strictEqual(rope.toString(), '');
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  it('Maintains AVL balance and subtree weights under sequential insertions', () => {
    const rope = new Rope();
    const count = 500;

    // Sequential insertions at the end (worst-case for unbalanced binary trees)
    for (let i = 0; i < count; i++) {
      rope.insert(rope.length(), String.fromCharCode(65 + (i % 26)));
    }

    assert.strictEqual(rope.length(), count);
    const inv = rope.checkInvariants();
    assert.strictEqual(inv.valid, true, `Invariant failure: ${inv.error}`);
    assert.ok(inv.maxBalanceDiff <= 1, `Max balance diff ${inv.maxBalanceDiff} exceeds 1`);

    // In an AVL tree, max height for N nodes is <= 1.44 * log2(N + 2)
    // For 500 insertions, height should be around 10-15, never anywhere near 500
    assert.ok(inv.height < 20, `AVL height ${inv.height} is too large for 500 nodes`);

    // Verify content
    let expected = '';
    for (let i = 0; i < count; i++) {
      expected += String.fromCharCode(65 + (i % 26));
    }
    assert.strictEqual(rope.toString(), expected);
  });

  it('Maintains AVL balance under random insertions and deletions', () => {
    const rope = new Rope('INITIAL');
    let mirror = 'INITIAL';

    for (let step = 0; step < 300; step++) {
      const isInsert = Math.random() > 0.4 || mirror.length === 0;
      if (isInsert) {
        const pos = Math.floor(Math.random() * (mirror.length + 1));
        const char = String.fromCharCode(97 + Math.floor(Math.random() * 26));
        rope.insert(pos, char);
        mirror = mirror.slice(0, pos) + char + mirror.slice(pos);
      } else {
        const pos = Math.floor(Math.random() * mirror.length);
        const maxLen = Math.min(mirror.length - pos, 5);
        const len = 1 + Math.floor(Math.random() * maxLen);
        rope.delete(pos, len);
        mirror = mirror.slice(0, pos) + mirror.slice(pos + len);
      }

      assert.strictEqual(rope.length(), mirror.length);
      assert.strictEqual(rope.toString(), mirror);

      const inv = rope.checkInvariants();
      assert.strictEqual(inv.valid, true, `Failed at step ${step}: ${inv.error}`);
    }
  });

  it('Supports Unicode characters and emoji with UTF-16 code unit indexing', () => {
    // '🌍' is 2 UTF-16 code units (surrogate pair)
    // '👋' is 2 UTF-16 code units
    const text = 'Hello 🌍 World';
    const rope = new Rope(text);

    // 'Hello ' is 6 code units. '🌍' occupies index 6 and 7. ' ' is 8.
    assert.strictEqual(rope.length(), text.length);
    assert.strictEqual(rope.charAt(0), 'H');
    assert.strictEqual(rope.charAt(6), text[6]); // high surrogate
    assert.strictEqual(rope.charAt(7), text[7]); // low surrogate
    assert.strictEqual(rope.substring(6, 8), '🌍');

    // Insert emoji right after 🌍 (at index 8)
    rope.insert(8, '👋 ');
    assert.strictEqual(rope.toString(), 'Hello 🌍👋  World');
    assert.strictEqual(rope.checkInvariants().valid, true);

    // Delete 🌍 (length 2 at index 6)
    rope.delete(6, 2);
    assert.strictEqual(rope.toString(), 'Hello 👋  World');
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  it('Atomic embed insertion, length, and non-splittable position', () => {
    const rope = new Rope('Prefix:  Suffix');
    const imageEmbed: EmbedRef = {
      id: 'img_test_1',
      type: 'image',
      name: 'diagram.png',
      url: 'https://example.com/diagram.png',
      size: 1048576, // 1MB file size
    };

    // Insert embed at index 8 (between 'Prefix: ' and ' Suffix')
    // Logical length of embed is exactly 1 (not file size 1048576)
    rope.insertEmbed(8, imageEmbed);

    assert.strictEqual(rope.length(), 'Prefix:  Suffix'.length + 1);
    assert.strictEqual(rope.toString(), 'Prefix: [EMBED: img_test_1] Suffix');

    // The embed occupies exactly index 8
    const elem = rope.get(8);
    assert.strictEqual(elem.type, 'embed');
    if (elem.type === 'embed') {
      assert.strictEqual(elem.embed.id, 'img_test_1');
      assert.strictEqual(elem.embed.size, 1048576);
    }

    // charAt at embed position returns object replacement char \uFFFC
    assert.strictEqual(rope.charAt(8), '\uFFFC');

    // Characters around it
    assert.strictEqual(rope.charAt(7), ' ');
    assert.strictEqual(rope.charAt(9), ' ');

    assert.strictEqual(rope.checkInvariants().valid, true);

    // Delete embed (position 8, length 1)
    rope.delete(8, 1);
    assert.strictEqual(rope.toString(), 'Prefix:  Suffix');
    assert.strictEqual(rope.checkInvariants().valid, true);
  });

  it('Mixed text and multiple embeds with slice and pieces traversal', () => {
    const rope = new Rope('Intro. ');
    const embed1: EmbedRef = { id: 'asset_1', type: 'image', name: 'img1.png' };
    const embed2: EmbedRef = { id: 'asset_2', type: 'file', name: 'data.csv' };

    rope.insertEmbed(rope.length(), embed1);
    rope.insert(rope.length(), ' Middle text. ');
    rope.insertEmbed(rope.length(), embed2);
    rope.insert(rope.length(), ' Conclusion.');

    assert.strictEqual(
      rope.toString(),
      'Intro. [EMBED: asset_1] Middle text. [EMBED: asset_2] Conclusion.'
    );

    const pieces = rope.getPieces();
    assert.strictEqual(pieces.length, 5);
    assert.strictEqual(pieces[0].type, 'text');
    assert.strictEqual((pieces[0] as any).text, 'Intro. ');
    assert.strictEqual(pieces[1].type, 'embed');
    assert.strictEqual((pieces[1] as any).embed.id, 'asset_1');
    assert.strictEqual(pieces[2].type, 'text');
    assert.strictEqual((pieces[2] as any).text, ' Middle text. ');
    assert.strictEqual(pieces[3].type, 'embed');
    assert.strictEqual((pieces[3] as any).embed.id, 'asset_2');
    assert.strictEqual(pieces[4].type, 'text');
    assert.strictEqual((pieces[4] as any).text, ' Conclusion.');

    // Sub-Rope slicing
    // Slice across embed1
    const sub = rope.slice(0, 8); // 'Intro. ' (7) + embed1 (1) = 8
    assert.strictEqual(sub.length(), 8);
    assert.strictEqual(sub.toString(), 'Intro. [EMBED: asset_1]');
    assert.strictEqual(sub.checkInvariants().valid, true);
  });

  it('Large sequential insertion workload (5,000 ops) verifies AVL logarithmic depth', () => {
    const rope = new Rope();
    const totalOps = 5000;

    for (let i = 0; i < totalOps; i++) {
      rope.insert(rope.length(), 'x');
    }

    assert.strictEqual(rope.length(), totalOps);

    const inv = rope.checkInvariants();
    assert.strictEqual(inv.valid, true);
    assert.ok(inv.maxBalanceDiff <= 1, 'AVL balance invariant violated');

    // Mathematical upper bound for AVL tree height: 1.4404 * log2(N + 2) - 0.328
    // For N = 5000, 1.4404 * log2(5002) ~ 17.7 -> max theoretical height is ~18
    assert.ok(
      inv.height <= 20,
      `Height ${inv.height} exceeds expected logarithmic bound for ${totalOps} nodes`
    );
  });

  it('Split and concatenate preserve subtree weights and AVL invariants', () => {
    const text1 = 'The quick brown fox ';
    const text2 = 'jumps over the lazy dog.';
    const rope1 = new Rope(text1);
    const rope2 = new Rope(text2);

    // Concatenate via insert at end
    rope1.insert(rope1.length(), text2);
    assert.strictEqual(rope1.toString(), text1 + text2);
    assert.strictEqual(rope1.length(), text1.length + text2.length);
    assert.strictEqual(rope1.checkInvariants().valid, true);

    // Split at word boundaries
    const splitPoint = text1.length;
    const subLeft = rope1.slice(0, splitPoint);
    const subRight = rope1.slice(splitPoint);

    assert.strictEqual(subLeft.toString(), text1);
    assert.strictEqual(subRight.toString(), text2);
    assert.strictEqual(subLeft.checkInvariants().valid, true);
    assert.strictEqual(subRight.checkInvariants().valid, true);
  });

  it('Flattened traversal output matches exact logical content with embeds', () => {
    const rope = new Rope();
    rope.insert(0, 'Start ');
    const embed: EmbedRef = {
      id: 'chart_42',
      type: 'image',
      name: 'chart.png',
      url: '/assets/chart.png',
    };
    rope.insertEmbed(6, embed);
    rope.insert(7, ' End');

    assert.strictEqual(rope.length(), 11);

    const pieces = rope.getPieces();
    let reconstructed = '';
    for (const piece of pieces) {
      if (piece.type === 'text') {
        reconstructed += piece.text;
      } else {
        reconstructed += `[EMBED: ${piece.embed.id}]`;
      }
    }

    assert.strictEqual(reconstructed, 'Start [EMBED: chart_42] End');
    assert.strictEqual(rope.toString(), reconstructed);
  });
});
