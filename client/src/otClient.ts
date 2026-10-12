import { Rope, type EmbedRef } from './rope.ts';
import { transform, applyOpToRope } from './rebase.ts';
import type { Operation, OperationMessage } from './types.ts';

/**
 * Result returned when a local edit is performed
 */
export interface LocalEditResult {
  shouldSend: boolean;
  opMessageToSend: OperationMessage | null;
}

/**
 * Result returned when an ACK is processed
 */
export interface AckResult {
  acknowledged: boolean;
  shouldSend: boolean;
  nextOpToSend: OperationMessage | null;
  serverRevision: number;
}

/**
 * Result returned when a remote committed operation is processed
 */
export interface RemoteOpResult {
  transformedOp: Operation;
  serverRevision: number;
}

/**
 * Client-Side Operational Transformation (OT) Engine
 * Implements the classic Jupiter/Google Docs OT state machine with:
 * - Local optimistic Rope updates
 * - Single-in-flight outstanding queue awaiting ACK
 * - Secondary buffer queue for rapid typing while awaiting ACK
 * - Symmetrical bidirectional rebasing on remote operations
 */
export class OTClient {
  private documentId: string;
  private clientId: string;
  private localRope: Rope;
  private serverRevision: number;
  private nextClientSeq: number = 0;

  // Single in-flight outstanding operation awaiting server ACK
  private outstandingOp: OperationMessage | null = null;

  // Buffer of subsequent local operations waiting to be sent
  private bufferQueue: OperationMessage[] = [];

  constructor(
    documentId: string,
    clientId: string,
    initialDoc: string = '',
    initialRevision: number = 0
  ) {
    this.documentId = documentId;
    this.clientId = clientId;
    this.localRope = new Rope(initialDoc);
    this.serverRevision = initialRevision;
  }

  public getDocumentId(): string {
    return this.documentId;
  }

  public getClientId(): string {
    return this.clientId;
  }

  public getLocalRope(): Rope {
    return this.localRope;
  }

  public getServerRevision(): number {
    return this.serverRevision;
  }

  public getOutstandingOp(): OperationMessage | null {
    return this.outstandingOp;
  }

  public getBufferQueue(): OperationMessage[] {
    return [...this.bufferQueue];
  }

  public getPendingCount(): number {
    return (this.outstandingOp ? 1 : 0) + this.bufferQueue.length;
  }

  /**
   * Resets local Rope and revision (e.g. upon initial room join)
   */
  public reset(doc: string, revision: number): void {
    this.localRope = new Rope(doc);
    this.serverRevision = revision;
    this.outstandingOp = null;
    this.bufferQueue = [];
  }

  /**
   * Reconciles document after gap recovery / snapshot update, preserving pending local edits
   */
  public reconcileWithRemote(remoteDoc: string, newRevision: number): void {
    this.localRope = new Rope(remoteDoc);
    this.serverRevision = newRevision;

    if (this.outstandingOp) {
      applyOpToRope(this.localRope, this.outstandingOp.op);
    }
    for (const b of this.bufferQueue) {
      applyOpToRope(this.localRope, b.op);
    }
  }

  /**
   * Replays an ordered sequence of missing committed operations during history catch-up
   */
  public catchUpHistory(operations: Array<{ op: Operation; serverRevision: number }>): void {
    for (const item of operations) {
      this.handleRemoteCommittedOp(item.op, item.serverRevision);
    }
  }

  /**
   * Generates a unique operation ID
   */
  private generateOperationId(): string {
    return `op_${this.clientId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  }

  /**
   * Applies a local user edit optimistically to the local Rope and enqueues it.
   */
  public applyLocalEdit(
    type: 'insert' | 'delete' | 'insert_embed',
    pos: number,
    text?: string,
    len?: number,
    embed?: EmbedRef
  ): LocalEditResult {
    // 1. Apply to local Rope optimistically
    if (type === 'insert_embed' && embed) {
      this.localRope.insertEmbed(pos, embed);
    } else if (type === 'insert' && text) {
      this.localRope.insert(pos, text);
    } else if (type === 'delete' && len) {
      this.localRope.delete(pos, len);
    }

    // 2. Construct operation payload
    const operationId = this.generateOperationId();
    const clientSeq = this.nextClientSeq++;

    const opPayload: Operation = {
      type,
      pos,
      clientId: this.clientId,
      clientSeq,
      ...(text !== undefined ? { text } : {}),
      ...(len !== undefined ? { len } : {}),
      ...(embed !== undefined ? { embed } : {}),
    };

    const opMessage: OperationMessage = {
      type: 'operation',
      docId: this.documentId,
      documentId: this.documentId,
      operationId,
      clientId: this.clientId,
      baseRevision: this.serverRevision,
      op: opPayload,
    };

    // 3. Queue management
    if (!this.outstandingOp) {
      // Nothing in flight: send immediately
      this.outstandingOp = opMessage;
      return { shouldSend: true, opMessageToSend: opMessage };
    } else {
      // An operation is already in flight: buffer this local edit
      this.bufferQueue.push(opMessage);
      return { shouldSend: false, opMessageToSend: null };
    }
  }

  /**
   * Processes server ACK for an in-flight operation.
   * Advances the acknowledged revision and promotes the next buffered operation if present.
   */
  public handleAck(operationId: string, serverRevision: number): AckResult {
    if (!this.outstandingOp || this.outstandingOp.operationId !== operationId) {
      // Stale or unrecognized ACK
      return {
        acknowledged: false,
        shouldSend: false,
        nextOpToSend: null,
        serverRevision: this.serverRevision,
      };
    }

    // Remove outstanding op and update revision
    this.outstandingOp = null;
    this.serverRevision = serverRevision;

    // Promote next buffered operation if available
    if (this.bufferQueue.length > 0) {
      const nextOp = this.bufferQueue.shift()!;
      // Update its baseRevision to the latest confirmed server revision
      nextOp.baseRevision = this.serverRevision;
      this.outstandingOp = nextOp;
      return {
        acknowledged: true,
        shouldSend: true,
        nextOpToSend: nextOp,
        serverRevision: this.serverRevision,
      };
    }

    return {
      acknowledged: true,
      shouldSend: false,
      nextOpToSend: null,
      serverRevision: this.serverRevision,
    };
  }

  /**
   * Handles a remote committed operation broadcast from the server.
   * Rebases the incoming operation against all local pending operations,
   * rebases all local pending operations against the incoming operation,
   * applies the transformed remote operation to the local Rope,
   * and advances the committed server revision.
   */
  public handleRemoteCommittedOp(
    remoteOp: Operation,
    serverRevision: number
  ): RemoteOpResult {
    let transformedRemoteOp: Operation = { ...remoteOp };

    // 1. Transform against in-flight outstanding operation
    if (this.outstandingOp) {
      const prevRemoteOp = { ...transformedRemoteOp };
      transformedRemoteOp = transform(transformedRemoteOp, this.outstandingOp.op);
      this.outstandingOp.op = transform(this.outstandingOp.op, prevRemoteOp);
    }

    // 2. Transform sequentially through all buffered operations
    for (let i = 0; i < this.bufferQueue.length; i++) {
      const prevRemoteOp = { ...transformedRemoteOp };
      transformedRemoteOp = transform(transformedRemoteOp, this.bufferQueue[i].op);
      this.bufferQueue[i].op = transform(this.bufferQueue[i].op, prevRemoteOp);
    }

    // 3. Apply transformed remote operation to local Rope
    applyOpToRope(this.localRope, transformedRemoteOp);

    // Advance synchronized serverRevision
    this.serverRevision = serverRevision;

    return {
      transformedOp: transformedRemoteOp,
      serverRevision: this.serverRevision,
    };
  }
}
