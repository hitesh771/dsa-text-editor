/**
 * Shared types for the collaborative text editor
 */

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
 * Operation type - insert text, delete range, or insert atomic embed
 */
export type OperationType = 'insert' | 'delete' | 'insert_embed' | 'composite';

/**
 * Base operation structure
 */
export interface Operation {
  type: OperationType;
  pos: number;
  clientId: string;
  clientSeq: number;
  text?: string;        // For insert operations
  len?: number;         // For delete operations
  embed?: EmbedRef;     // For insert_embed operations
  ops?: Operation[];    // For composite operations (e.g. split delete)
}

/**
 * Asset metadata stored persistently for uploads
 */
export interface AssetMetadata {
  assetId: string;
  documentId: string;
  type: 'image' | 'file' | 'csv' | 'pdf';
  mimeType: string;
  originalFileName: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  checksum: string;
  storageKey: string;
  createdAt: number;
  uploadStatus: 'ready' | 'processing' | 'failed';
}

/**
 * Collaborator presence record for interval indexing
 */
export interface PresenceRecord {
  documentId: string;
  clientId: string;
  userName: string;
  color: string;
  cursor: number;
  selectionStart: number;
  selectionEnd: number;
  cursorX?: number;
  cursorY?: number;
  lastUpdated: number;
  revision?: number;
}

/**
 * Insert operation
 */
export interface InsertOperation extends Operation {
  type: 'insert';
  text: string;
}

/**
 * Delete operation
 */
export interface DeleteOperation extends Operation {
  type: 'delete';
  len: number;
}

/**
 * Insert embed operation
 */
export interface InsertEmbedOperation extends Operation {
  type: 'insert_embed';
  embed: EmbedRef;
}

/**
 * Server operation with server sequence number
 */
export interface ServerOperation extends Operation {
  serverSeq: number;
}

/**
 * Client information
 */
export interface ClientInfo {
  id: string;
  name: string;
  color: string;
  cursorX: number;
  cursorY: number;
}

/**
 * Record of a committed operation in the authoritative server history
 */
export interface CommittedOperation {
  operationId: string;
  clientId: string;
  serverRevision: number;
  baseRevision: number;
  op: Operation;
  timestamp: number;
}

/**
 * Message types for WebSocket communication
 */
export type MessageType =
  | 'join'
  | 'joined'
  | 'operation'
  | 'operation_committed'
  | 'op'                  // legacy alias for operation
  | 'ack'
  | 'history_request'
  | 'history_response'
  | 'snapshot_request'
  | 'snapshot_response'
  | 'presence_update'
  | 'presence_broadcast'
  | 'cursor'              // legacy alias for presence
  | 'disconnect'
  | 'error';

/**
 * Base message structure
 */
export interface Message {
  type: MessageType;
  docId: string;
  clientId?: string;
}

/**
 * Join message - sent when client connects
 */
export interface JoinMessage extends Message {
  type: 'join';
  clientId: string;
  clientName: string;
}

/**
 * Joined confirmation sent to the client upon joining a document
 */
export interface JoinedMessage extends Message {
  type: 'joined';
  clientId: string;
  globalRevision: number;
  doc: string;
  clients: ClientInfo[];
}

/**
 * Client submission of a document-edit operation
 */
export interface OperationMessage extends Message {
  type: 'operation';
  documentId: string;
  operationId: string;
  clientId: string;
  baseRevision: number;
  op: Operation;
}

/**
 * Broadcast of a committed operation with authoritative server revision
 */
export interface OperationCommittedMessage extends Message {
  type: 'operation_committed';
  documentId: string;
  operationId: string;
  clientId: string;
  serverRevision: number;
  op: Operation;
}

/**
 * Legacy Operation message alias
 */
export interface OpMessage extends Message {
  type: 'op';
  documentId?: string;
  operationId?: string;
  baseRevision?: number;
  operation: Operation;
}

/**
 * Acknowledgment message sent to sender after processing operation
 */
export interface AckMessage extends Message {
  type: 'ack';
  operationId: string;
  serverRevision: number;
  clientSeq?: number;
}

/**
 * History catch-up request
 */
export interface HistoryRequestMessage extends Message {
  type: 'history_request';
  documentId: string;
  fromRevision: number;
  toRevision?: number;
}

/**
 * History catch-up response
 */
export interface HistoryResponseMessage extends Message {
  type: 'history_response';
  documentId: string;
  fromRevision: number;
  toRevision: number;
  operations: CommittedOperation[];
}

/**
 * Snapshot request
 */
export interface SnapshotRequestMessage extends Message {
  type: 'snapshot_request';
  documentId: string;
}

/**
 * Snapshot response
 */
export interface SnapshotResponseMessage extends Message {
  type: 'snapshot_response';
  documentId: string;
  revision: number;
  doc: string;
}

/**
 * Presence update (selection ranges and optional cursor coordinates)
 */
export interface PresenceUpdateMessage extends Message {
  type: 'presence_update';
  documentId: string;
  clientId: string;
  userName?: string;
  color?: string;
  cursor?: number;
  selectionStart?: number;
  selectionEnd?: number;
  cursorX?: number;
  cursorY?: number;
  revision?: number;
  timestamp?: number;
}

/**
 * Presence broadcast to room peers
 */
export interface PresenceBroadcastMessage extends Message {
  type: 'presence_broadcast';
  documentId: string;
  clientId: string;
  presence?: PresenceRecord;
  selectionStart?: number;
  selectionEnd?: number;
  cursorX?: number;
  cursorY?: number;
  overlappingClientIds?: string[];
}

/**
 * Error message
 */
export interface ErrorMessage extends Message {
  type: 'error';
  code: string;
  message: string;
  operationId?: string;
}

/**
 * Cursor update message (legacy)
 */
export interface CursorMessage extends Message {
  type: 'cursor';
  x: number;
  y: number;
}

/**
 * Disconnect message
 */
export interface DisconnectMessage extends Message {
  type: 'disconnect';
  clientId: string;
}
