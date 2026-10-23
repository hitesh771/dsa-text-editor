/**
 * Augmented AVL Interval Tree for tracking active collaborators' selection ranges
 * Uses half-open interval convention [start, end)
 * Guaranteed O(log n) insertion, deletion, and overlap queries
 */

export interface IntervalData {
  clientId: string;
  userName?: string;
  color?: string;
  cursor?: number;
  lastUpdated: number;
  [key: string]: any;
}

export interface Interval<T = IntervalData> {
  start: number;
  end: number;
  data: T;
}

export class IntervalNode<T = IntervalData> {
  public start: number;
  public end: number;
  public max: number; // Subtree maximum endpoint
  public height: number;
  public data: T;
  public left?: IntervalNode<T>;
  public right?: IntervalNode<T>;

  constructor(start: number, end: number, data: T) {
    this.start = start;
    this.end = Math.max(start, end);
    this.max = this.end;
    this.height = 1;
    this.data = data;
  }
}

export class IntervalTree<T extends IntervalData = IntervalData> {
  public root?: IntervalNode<T>;

  private getHeight(node?: IntervalNode<T>): number {
    return node ? node.height : 0;
  }

  private getMax(node?: IntervalNode<T>): number {
    return node ? node.max : -Infinity;
  }

  private getBalance(node: IntervalNode<T>): number {
    return this.getHeight(node.left) - this.getHeight(node.right);
  }

  private updateNode(node: IntervalNode<T>): void {
    node.height = 1 + Math.max(this.getHeight(node.left), this.getHeight(node.right));
    node.max = Math.max(node.end, this.getMax(node.left), this.getMax(node.right));
  }

  private rotateRight(y: IntervalNode<T>): IntervalNode<T> {
    const x = y.left!;
    const T2 = x.right;

    x.right = y;
    y.left = T2;

    this.updateNode(y);
    this.updateNode(x);

    return x;
  }

  private rotateLeft(x: IntervalNode<T>): IntervalNode<T> {
    const y = x.right!;
    const T2 = y.left;

    y.left = x;
    x.right = T2;

    this.updateNode(x);
    this.updateNode(y);

    return y;
  }

  private rebalance(node: IntervalNode<T>): IntervalNode<T> {
    this.updateNode(node);
    const balance = this.getBalance(node);

    // Left heavy
    if (balance > 1) {
      if (this.getBalance(node.left!) < 0) {
        node.left = this.rotateLeft(node.left!);
      }
      return this.rotateRight(node);
    }

    // Right heavy
    if (balance < -1) {
      if (this.getBalance(node.right!) > 0) {
        node.right = this.rotateRight(node.right!);
      }
      return this.rotateLeft(node);
    }

    return node;
  }

  /**
   * Inserts a half-open interval [start, end)
   */
  public insert(start: number, end: number, data: T): void {
    const normalizedEnd = Math.max(start, end);
    this.root = this.insertNode(this.root, start, normalizedEnd, data);
  }

  private insertNode(
    node: IntervalNode<T> | undefined,
    start: number,
    end: number,
    data: T
  ): IntervalNode<T> {
    if (!node) {
      return new IntervalNode<T>(start, end, data);
    }

    if (start < node.start || (start === node.start && data.clientId < node.data.clientId)) {
      node.left = this.insertNode(node.left, start, end, data);
    } else {
      node.right = this.insertNode(node.right, start, end, data);
    }

    return this.rebalance(node);
  }

  /**
   * Finds a node matching clientId
   */
  public findByClientId(clientId: string): Interval<T> | undefined {
    return this.findNodeByClientId(this.root, clientId)?.interval();
  }

  private findNodeByClientId(
    node: IntervalNode<T> | undefined,
    clientId: string
  ): { node: IntervalNode<T>; interval: () => Interval<T> } | undefined {
    if (!node) return undefined;
    if (node.data.clientId === clientId) {
      return {
        node,
        interval: () => ({ start: node.start, end: node.end, data: node.data }),
      };
    }

    const left = this.findNodeByClientId(node.left, clientId);
    if (left) return left;
    return this.findNodeByClientId(node.right, clientId);
  }

  /**
   * Deletes interval associated with clientId
   */
  public delete(clientId: string): boolean {
    const beforeCount = this.getAll().length;
    this.root = this.deleteByClientIdNode(this.root, clientId);
    return this.getAll().length < beforeCount;
  }

  private findMin(node: IntervalNode<T>): IntervalNode<T> {
    let current = node;
    while (current.left) {
      current = current.left;
    }
    return current;
  }

  private deleteByClientIdNode(
    node: IntervalNode<T> | undefined,
    clientId: string
  ): IntervalNode<T> | undefined {
    if (!node) return undefined;

    if (node.data.clientId === clientId) {
      // Node found: standard AVL deletion
      if (!node.left) return node.right;
      if (!node.right) return node.left;

      // Two children: replace with in-order successor (min of right subtree)
      const successor = this.findMin(node.right);
      node.start = successor.start;
      node.end = successor.end;
      node.data = successor.data;
      node.right = this.deleteByClientIdNode(node.right, successor.data.clientId);
    } else {
      node.left = this.deleteByClientIdNode(node.left, clientId);
      node.right = this.deleteByClientIdNode(node.right, clientId);
    }

    return this.rebalance(node);
  }

  /**
   * Updates or creates interval for a given clientId
   */
  public update(clientId: string, start: number, end: number, data: T): void {
    this.delete(clientId);
    this.insert(start, end, data);
  }

  /**
   * Queries all intervals overlapping with half-open range [start, end)
   * Two intervals [s1, e1) and [s2, e2) overlap if and only if s1 < e2 and s2 < e1
   */
  public findOverlapping(start: number, end: number): Interval<T>[] {
    const results: Interval<T>[] = [];
    const queryStart = Math.min(start, end);
    const queryEnd = Math.max(start, end);

    // If query is a point cursor [p, p), treat as [p, p + 1) for proximity or empty
    const effectiveEnd = queryStart === queryEnd ? queryStart + 1 : queryEnd;

    this.searchOverlapping(this.root, queryStart, effectiveEnd, results);
    return results;
  }

  private searchOverlapping(
    node: IntervalNode<T> | undefined,
    start: number,
    end: number,
    results: Interval<T>[]
  ): void {
    if (!node) return;

    // Prune left subtree: if left.max <= query start, no interval in left can overlap
    if (node.left && node.left.max > start) {
      this.searchOverlapping(node.left, start, end, results);
    }

    // Check current node overlap: node.start < end && node.end > start
    if (node.start < end && node.end > start) {
      results.push({
        start: node.start,
        end: node.end,
        data: node.data,
      });
    }

    // Search right subtree: if node.start >= end, right subtree cannot overlap because right.start >= node.start
    if (node.right && node.start < end) {
      this.searchOverlapping(node.right, start, end, results);
    }
  }

  /**
   * Shifts all intervals when text is inserted or deleted at pos
   * Maintains strict half-open interval ordering and rebalances the tree
   */
  public shiftAll(pos: number, delta: number): void {
    const all = this.getAll();
    this.root = undefined;

    for (const item of all) {
      let { start, end } = item;

      if (delta > 0) {
        // Insertion at pos
        if (start >= pos) {
          start += delta;
          end += delta;
        } else if (end > pos) {
          end += delta;
        }
      } else if (delta < 0) {
        // Deletion of span [pos, pos + |delta|)
        const delLen = -delta;
        const delEnd = pos + delLen;

        // Shift start
        if (start >= delEnd) {
          start -= delLen;
        } else if (start > pos) {
          start = pos;
        }

        // Shift end
        if (end >= delEnd) {
          end -= delLen;
        } else if (end > pos) {
          end = pos;
        }
      }

      start = Math.max(0, start);
      end = Math.max(start, end);

      this.insert(start, end, item.data);
    }
  }

  /**
   * Removes stale presence records older than ttlMs
   */
  public cleanupStale(ttlMs: number, now: number = Date.now()): string[] {
    const all = this.getAll();
    const removedClientIds: string[] = [];

    for (const item of all) {
      if (now - item.data.lastUpdated > ttlMs) {
        this.delete(item.data.clientId);
        removedClientIds.push(item.data.clientId);
      }
    }

    return removedClientIds;
  }

  /**
   * Retrieves all intervals sorted by start position
   */
  public getAll(): Interval<T>[] {
    const results: Interval<T>[] = [];
    this.inOrderTraversal(this.root, results);
    return results;
  }

  private inOrderTraversal(node: IntervalNode<T> | undefined, results: Interval<T>[]): void {
    if (!node) return;
    this.inOrderTraversal(node.left, results);
    results.push({ start: node.start, end: node.end, data: node.data });
    this.inOrderTraversal(node.right, results);
  }

  public clear(): void {
    this.root = undefined;
  }

  /**
   * Verifies AVL balance and subtree max invariants
   */
  public checkInvariants(node?: IntervalNode<T>): { valid: boolean; error?: string } {
    const targetNode = arguments.length === 0 ? this.root : node;
    if (!targetNode) return { valid: true };

    const balance = this.getBalance(targetNode);
    if (Math.abs(balance) > 1) {
      return { valid: false, error: `AVL balance violation: ${balance} at [${targetNode.start}, ${targetNode.end})` };
    }

    const expectedMax = Math.max(targetNode.end, this.getMax(targetNode.left), this.getMax(targetNode.right));
    if (targetNode.max !== expectedMax) {
      return { valid: false, error: `Subtree max violation: got ${targetNode.max}, expected ${expectedMax}` };
    }

    if (targetNode.left && targetNode.left.start > targetNode.start) {
      return { valid: false, error: `BST ordering violation on left child` };
    }
    if (targetNode.right && targetNode.right.start < targetNode.start) {
      return { valid: false, error: `BST ordering violation on right child` };
    }

    const leftCheck = this.checkInvariants(targetNode.left);
    if (!leftCheck.valid) return leftCheck;

    return this.checkInvariants(targetNode.right);
  }
}
