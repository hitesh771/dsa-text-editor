import { FenwickTree } from './fenwick';
import { Operation } from './types';

/**
 * RevisionDeltaIndex - Uses Fenwick Tree for a mathematically valid responsibility:
 * Indexing cumulative document-length deltas across committed revisions.
 *
 * ARCHITECTURAL DECISION NOTE:
 * A Fenwick Tree (Binary Indexed Tree) is NOT used as an authority for current character
 * positions or as an OT engine replacement. Document character lookup and positional indexing
 * are authoritatively handled by the AVL Rope subtree weights in O(log n).
 *
 * Here, the Fenwick Tree indexes net length changes by committed revision number:
 * - revisionIndex.recordRevision(rev, +length) for inserts
 * - revisionIndex.recordRevision(rev, -length) for deletes
 * - revisionIndex.getNetGrowthBetween(rev1, rev2) computes cumulative document growth in O(log R).
 */
export class RevisionDeltaIndex {
  private tree: FenwickTree;

  constructor(maxRevisions: number = 100000) {
    this.tree = new FenwickTree(maxRevisions);
  }

  /**
   * Records the net document length delta produced by a committed revision
   */
  recordRevisionDelta(revision: number, delta: number): void {
    if (revision >= 0 && revision < this.tree.getSize()) {
      this.tree.update(revision, delta);
    }
  }

  /**
   * Computes the cumulative net document length change from revision 0 through target revision
   */
  getCumulativeDelta(revision: number): number {
    return this.tree.query(revision);
  }

  /**
   * Computes net document length growth between two revisions [startRev, endRev]
   */
  getDeltaBetween(startRev: number, endRev: number): number {
    if (startRev > endRev) return 0;
    return this.tree.rangeQuery(startRev, endRev);
  }
}

/**
 * Legacy TransformEngine stub retained for backwards compatibility
 * Position lookups defer to the Rope's authoritative subtree weights.
 */
export class TransformEngine {
  private revisionIndex = new RevisionDeltaIndex();

  getRevisionIndex(): RevisionDeltaIndex {
    return this.revisionIndex;
  }
}
