/**
 * Atomic embed reference element (e.g. image, file attachment)
 * Occupies exactly 1 logical unit in the document
 */
export interface EmbedRef {
  id: string;
  type: 'image' | 'file' | string;
  name?: string;
  url?: string;
  mimeType?: string;
  size?: number;  // file size in bytes for metadata display
  alt?: string;
}

/**
 * Representation of a contiguous text piece in the Rope
 */
export interface TextPiece {
  type: 'text';
  text: string;
}

/**
 * Representation of an atomic embed (image/file reference) in the Rope
 * Occupies exactly 1 logical document position
 */
export interface EmbedPiece {
  type: 'embed';
  embed: EmbedRef;
}

export type RopePiece = TextPiece | EmbedPiece;

export type RopeElement =
  | { type: 'text'; char: string; index: number }
  | { type: 'embed'; embed: EmbedRef; index: number };

/**
 * RopeNode represents a node in the balanced AVL Rope tree
 */
export class RopeNode {
  text?: string;         // Leaf text content (if text node)
  embed?: EmbedRef;      // Leaf embed content (if embed node)
  weight: number;        // Logical length of left subtree, or leaf length
  totalLength: number;   // Total logical length of this subtree
  height: number;        // Height for AVL balancing (leaves have height 1)
  left?: RopeNode;       // Left child
  right?: RopeNode;      // Right child

  constructor(data?: { text?: string; embed?: EmbedRef }) {
    if (data?.embed) {
      this.embed = data.embed;
      this.weight = 1;       // An embed occupies exactly 1 logical unit
      this.totalLength = 1;
      this.height = 1;
    } else if (data?.text !== undefined) {
      this.text = data.text;
      this.weight = data.text.length; // UTF-16 code units
      this.totalLength = data.text.length;
      this.height = 1;
    } else {
      this.weight = 0;
      this.totalLength = 0;
      this.height = 1;
    }
  }

  isLeaf(): boolean {
    return this.text !== undefined || this.embed !== undefined;
  }

  isEmbed(): boolean {
    return this.embed !== undefined;
  }

  length(): number {
    return this.totalLength;
  }

  /**
   * Logical string representation of this node's content
   */
  toString(): string {
    if (this.isLeaf()) {
      if (this.embed) {
        return `[EMBED: ${this.embed.id}]`;
      }
      return this.text ?? '';
    }
    const leftStr = this.left ? this.left.toString() : '';
    const rightStr = this.right ? this.right.toString() : '';
    return leftStr + rightStr;
  }

  /**
   * Character/element lookup at logical 0-indexed position
   */
  charAt(index: number): string {
    if (index < 0 || index >= this.totalLength) {
      throw new Error(`Index out of bounds: index ${index}, length ${this.totalLength}`);
    }

    if (this.isLeaf()) {
      if (this.embed) {
        // Standard Unicode Object Replacement Character for non-text embeds
        return '\uFFFC';
      }
      return this.text![index];
    }

    if (index < this.weight) {
      return this.left!.charAt(index);
    } else {
      return this.right!.charAt(index - this.weight);
    }
  }

  /**
   * Element lookup with full metadata
   */
  get(index: number): RopeElement {
    if (index < 0 || index >= this.totalLength) {
      throw new Error(`Index out of bounds: index ${index}, length ${this.totalLength}`);
    }

    if (this.isLeaf()) {
      if (this.embed) {
        return { type: 'embed', embed: this.embed, index };
      }
      return { type: 'text', char: this.text![index], index };
    }

    if (index < this.weight) {
      return this.left!.get(index);
    } else {
      return this.right!.get(index - this.weight);
    }
  }

  /**
   * Substring retrieval between logical start and end (exclusive)
   */
  substring(start: number, end: number): string {
    if (start < 0 || end > this.totalLength || start > end) {
      throw new Error(`Invalid substring range: [${start}, ${end}) on length ${this.totalLength}`);
    }

    if (start === end) {
      return '';
    }

    if (this.isLeaf()) {
      if (this.embed) {
        return `[EMBED: ${this.embed.id}]`;
      }
      return this.text!.substring(start, end);
    }

    if (end <= this.weight) {
      return this.left!.substring(start, end);
    } else if (start >= this.weight) {
      return this.right!.substring(start - this.weight, end - this.weight);
    } else {
      const leftPart = this.left!.substring(start, this.weight);
      const rightPart = this.right!.substring(0, end - this.weight);
      return leftPart + rightPart;
    }
  }
}

/**
 * Helper functions for AVL operations
 */
function getHeight(node?: RopeNode): number {
  return node ? node.height : 0;
}

function getBalance(node?: RopeNode): number {
  return node ? getHeight(node.left) - getHeight(node.right) : 0;
}

function updateNode(node: RopeNode): void {
  const leftLen = node.left ? node.left.length() : 0;
  const rightLen = node.right ? node.right.length() : 0;
  node.weight = leftLen;
  node.totalLength = leftLen + rightLen;
  node.height = 1 + Math.max(getHeight(node.left), getHeight(node.right));
}

function rotateRight(y: RopeNode): RopeNode {
  const x = y.left!;
  const T2 = x.right;

  // Rotation
  x.right = y;
  y.left = T2;

  // Recalculate metadata
  updateNode(y);
  updateNode(x);

  return x;
}

function rotateLeft(x: RopeNode): RopeNode {
  const y = x.right!;
  const T2 = y.left;

  // Rotation
  y.left = x;
  x.right = T2;

  // Recalculate metadata
  updateNode(x);
  updateNode(y);

  return y;
}

/**
 * Rebalances a node according to AVL invariants
 */
function rebalance(node: RopeNode): RopeNode {
  updateNode(node);
  const balance = getBalance(node);

  // Left heavy
  if (balance > 1) {
    if (getBalance(node.left) < 0) {
      // Left-Right case
      node.left = rotateLeft(node.left!);
    }
    // Left-Left case
    return rotateRight(node);
  }

  // Right heavy
  if (balance < -1) {
    if (getBalance(node.right) > 0) {
      // Right-Left case
      node.right = rotateRight(node.right!);
    }
    // Right-Right case
    return rotateLeft(node);
  }

  return node;
}

/**
 * Joins two AVL-balanced Rope trees T1 and T2 into a single balanced tree in O(|h1 - h2|) time
 */
function join(T1?: RopeNode, T2?: RopeNode): RopeNode | undefined {
  if (!T1) return T2;
  if (!T2) return T1;

  // Heights differ by at most 1: connect directly
  if (Math.abs(getHeight(T1) - getHeight(T2)) <= 1) {
    const parent = new RopeNode();
    parent.left = T1;
    parent.right = T2;
    updateNode(parent);
    return parent;
  }

  // T1 is significantly taller: descend down T1's right spine
  if (getHeight(T1) > getHeight(T2) + 1) {
    T1.right = join(T1.right, T2);
    return rebalance(T1);
  }

  // T2 is significantly taller: descend down T2's left spine
  T2.left = join(T1, T2.left);
  return rebalance(T2);
}

/**
 * Splits an AVL Rope at logical position pos into [left, right]
 */
function split(node: RopeNode | undefined, pos: number): [RopeNode | undefined, RopeNode | undefined] {
  if (!node) {
    return [undefined, undefined];
  }

  if (pos <= 0) {
    return [undefined, node];
  }

  if (pos >= node.length()) {
    return [node, undefined];
  }

  if (node.isLeaf()) {
    if (node.isEmbed()) {
      // Embeds are atomic: pos must be 0 or 1
      if (pos === 0) return [undefined, node];
      if (pos === 1) return [node, undefined];
      throw new Error(`Cannot split atomic embed at position ${pos}`);
    }

    // Split text leaf
    const leftText = node.text!.substring(0, pos);
    const rightText = node.text!.substring(pos);
    const leftNode = leftText.length > 0 ? new RopeNode({ text: leftText }) : undefined;
    const rightNode = rightText.length > 0 ? new RopeNode({ text: rightText }) : undefined;
    return [leftNode, rightNode];
  }

  if (pos < node.weight) {
    const [ll, lr] = split(node.left, pos);
    return [ll, join(lr, node.right)];
  } else if (pos === node.weight) {
    return [node.left, node.right];
  } else {
    const [rl, rr] = split(node.right, pos - node.weight);
    return [join(node.left, rl), rr];
  }
}

/**
 * Rope - AVL-balanced binary tree for real-time collaborative text editing
 * Supports text, atomic embed references, and rigorous AVL balance maintenance
 */
export class Rope {
  root?: RopeNode;

  constructor(initialText?: string) {
    if (initialText && initialText.length > 0) {
      this.root = new RopeNode({ text: initialText });
    }
  }

  /**
   * Creates a Rope directly from an existing root node
   */
  static fromNode(root?: RopeNode): Rope {
    const rope = new Rope();
    rope.root = root;
    return rope;
  }

  /**
   * Total logical length of the document in UTF-16 code units (text) + atomic units (embeds)
   */
  length(): number {
    return this.root ? this.root.length() : 0;
  }

  /**
   * Returns whether the document is empty
   */
  isEmpty(): boolean {
    return this.length() === 0;
  }

  /**
   * String representation with embeds formatted as [EMBED: <id>]
   */
  toString(): string {
    return this.root ? this.root.toString() : '';
  }

  /**
   * Character/element lookup at logical index
   */
  charAt(index: number): string {
    if (!this.root) {
      throw new Error('Rope is empty');
    }
    return this.root.charAt(index);
  }

  /**
   * Full element lookup (text character or embed reference)
   */
  get(index: number): RopeElement {
    if (!this.root) {
      throw new Error('Rope is empty');
    }
    return this.root.get(index);
  }

  /**
   * Retrieves substring between start and end (exclusive)
   */
  substring(start: number, end: number): string {
    if (!this.root || start >= end) {
      return '';
    }
    return this.root.substring(start, end);
  }

  /**
   * Inserts text at the specified logical position
   * Maintains strict AVL balancing
   */
  insert(pos: number, text: string): void {
    if (text.length === 0) {
      return;
    }

    const currentLen = this.length();
    if (pos < 0 || pos > currentLen) {
      throw new Error(`Insert position ${pos} out of bounds for length ${currentLen}`);
    }

    const newNode = new RopeNode({ text });

    if (!this.root) {
      this.root = newNode;
      return;
    }

    const [left, right] = split(this.root, pos);
    this.root = join(join(left, newNode), right);
  }

  /**
   * Inserts an atomic embed (image/file reference) at the specified logical position
   * An embed occupies exactly 1 logical unit
   */
  insertEmbed(pos: number, embed: EmbedRef): void {
    const currentLen = this.length();
    if (pos < 0 || pos > currentLen) {
      throw new Error(`InsertEmbed position ${pos} out of bounds for length ${currentLen}`);
    }

    const newNode = new RopeNode({ embed });

    if (!this.root) {
      this.root = newNode;
      return;
    }

    const [left, right] = split(this.root, pos);
    this.root = join(join(left, newNode), right);
  }

  /**
   * Deletes a range of length len starting at logical position pos
   * Maintains strict AVL balancing
   */
  delete(pos: number, len: number): void {
    if (len <= 0 || !this.root) {
      return;
    }

    const currentLen = this.length();
    if (pos < 0 || pos + len > currentLen) {
      throw new Error(`Delete range [${pos}, ${pos + len}) out of bounds for length ${currentLen}`);
    }

    const [left, rest] = split(this.root, pos);
    const [, right] = split(rest, len);

    this.root = join(left, right);
  }

  /**
   * Extracts a sub-Rope from start to end (exclusive)
   */
  slice(start: number = 0, end?: number): Rope {
    const currentLen = this.length();
    const normalizedEnd = end === undefined ? currentLen : Math.min(currentLen, end);
    const normalizedStart = Math.max(0, start);

    if (normalizedStart >= normalizedEnd || !this.root) {
      return new Rope();
    }

    const [, rest] = split(this.root, normalizedStart);
    const [middle] = split(rest, normalizedEnd - normalizedStart);

    return Rope.fromNode(middle);
  }

  /**
   * Flattened in-order traversal returning all leaf pieces (text chunks and embeds)
   */
  getPieces(): RopePiece[] {
    const pieces: RopePiece[] = [];
    const traverse = (node?: RopeNode) => {
      if (!node) return;
      if (node.isLeaf()) {
        if (node.embed) {
          pieces.push({ type: 'embed', embed: node.embed });
        } else if (node.text !== undefined && node.text.length > 0) {
          pieces.push({ type: 'text', text: node.text });
        }
        return;
      }
      traverse(node.left);
      traverse(node.right);
    };
    traverse(this.root);
    return pieces;
  }

  /**
   * Reconstructs Rope from serialized pieces (text chunks and embed references)
   */
  reconstructFromPieces(pieces: RopePiece[]): void {
    this.root = undefined;
    let currentPos = 0;
    for (const piece of pieces) {
      if (piece.type === 'text') {
        this.insert(currentPos, piece.text);
        currentPos += piece.text.length;
      } else if (piece.type === 'embed') {
        this.insertEmbed(currentPos, piece.embed);
        currentPos += 1;
      }
    }
  }

  /**
   * Invariant verification for tests and runtime assertions
   * Verifies:
   * 1. Subtree length consistency
   * 2. Left-weight correctness
   * 3. Height calculation
   * 4. Strict AVL balance: |balanceFactor| <= 1 for EVERY node
   */
  checkInvariants(): {
    valid: boolean;
    maxBalanceDiff: number;
    nodeCount: number;
    height: number;
    error?: string;
  } {
    let maxBalanceDiff = 0;
    let nodeCount = 0;

    const verify = (node?: RopeNode): { height: number; length: number } => {
      if (!node) {
        return { height: 0, length: 0 };
      }

      nodeCount++;

      if (node.isLeaf()) {
        const expectedLen = node.embed ? 1 : (node.text?.length ?? 0);
        if (node.totalLength !== expectedLen) {
          throw new Error(`Leaf totalLength mismatch: expected ${expectedLen}, got ${node.totalLength}`);
        }
        if (node.height !== 1) {
          throw new Error(`Leaf height must be 1, got ${node.height}`);
        }
        return { height: 1, length: expectedLen };
      }

      const left = verify(node.left);
      const right = verify(node.right);

      if (node.weight !== left.length) {
        throw new Error(`Internal node weight mismatch: expected ${left.length}, got ${node.weight}`);
      }

      const expectedTotal = left.length + right.length;
      if (node.totalLength !== expectedTotal) {
        throw new Error(`Internal node totalLength mismatch: expected ${expectedTotal}, got ${node.totalLength}`);
      }

      const expectedHeight = 1 + Math.max(left.height, right.height);
      if (node.height !== expectedHeight) {
        throw new Error(`Internal node height mismatch: expected ${expectedHeight}, got ${node.height}`);
      }

      const balance = Math.abs(left.height - right.height);
      if (balance > maxBalanceDiff) {
        maxBalanceDiff = balance;
      }

      if (balance > 1) {
        throw new Error(`AVL violation: balance factor is ${left.height - right.height} at node with weight ${node.weight}`);
      }

      return { height: expectedHeight, length: expectedTotal };
    };

    try {
      const { height } = verify(this.root);
      return {
        valid: true,
        maxBalanceDiff,
        nodeCount,
        height,
      };
    } catch (err: any) {
      return {
        valid: false,
        maxBalanceDiff,
        nodeCount,
        height: getHeight(this.root),
        error: err.message,
      };
    }
  }
}
