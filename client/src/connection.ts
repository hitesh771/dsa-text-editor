import { Operation, OperationMessage, ClientInfo } from './types.ts';

export type MessageHandler = {
  onJoined: (clientId: string, revision: number, doc: string, clients: ClientInfo[]) => void;
  onJoin: (clientId: string, clientName: string, color: string) => void;
  onOperationCommitted: (op: Operation, serverRevision: number, operationId: string, clientId: string) => void;
  onAck: (operationId: string, serverRevision: number, clientSeq?: number) => void;
  onCursor: (clientId: string, x: number, y: number) => void;
  onPresence?: (data: {
    clientId: string;
    userName?: string;
    color?: string;
    cursor?: number;
    selectionStart?: number;
    selectionEnd?: number;
    cursorX?: number;
    cursorY?: number;
    overlappingClientIds?: string[];
  }) => void;
  onHistoryResponse?: (fromRevision: number, toRevision: number, operations: any[]) => void;
  onSnapshotResponse?: (revision: number, doc: string, pieces?: any[]) => void;
  onDisconnect: (clientId: string) => void;
  onError?: (code: string, message: string, operationId?: string) => void;
};

export class CollabClient {
  private ws: WebSocket | null = null;
  private handlers: MessageHandler;
  private reconnectTimer: any = null;
  private clientId: string = '';
  private clientName: string;
  private documentId: string;

  constructor(
    private url: string,
    clientName: string,
    handlers: MessageHandler,
    documentId: string = 'default'
  ) {
    this.handlers = handlers;
    this.clientName = clientName;
    this.documentId = documentId;
  }

  connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log(`Connected to collaboration server for doc "${this.documentId}"`);
      const stableClientId = localStorage.getItem('stableClientId');
      this.send({
        type: 'join',
        docId: this.documentId,
        documentId: this.documentId,
        clientName: this.clientName,
        clientId: stableClientId || undefined,
      });
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (err) {
        console.error('Failed to parse incoming WebSocket message:', err);
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    this.ws.onclose = () => {
      console.log('Disconnected from collaboration server');
      this.scheduleReconnect();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  sendOperationMessage(opMsg: OperationMessage): void {
    this.send(opMsg);
  }

  sendCursor(x: number, y: number): void {
    this.send({
      type: 'presence_update',
      docId: this.documentId,
      documentId: this.documentId,
      clientId: this.clientId,
      cursorX: x,
      cursorY: y,
    });
  }

  sendPresence(selectionStart: number, selectionEnd: number, cursor: number, cursorX?: number, cursorY?: number): void {
    this.send({
      type: 'presence_update',
      docId: this.documentId,
      documentId: this.documentId,
      clientId: this.clientId,
      selectionStart,
      selectionEnd,
      cursor,
      cursorX,
      cursorY,
    });
  }

  requestHistory(fromRevision: number, toRevision?: number): void {
    this.send({
      type: 'history_request',
      docId: this.documentId,
      documentId: this.documentId,
      fromRevision,
      toRevision,
    });
  }

  requestSnapshot(): void {
    this.send({
      type: 'snapshot_request',
      docId: this.documentId,
      documentId: this.documentId,
    });
  }

  public send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: { type: string; [key: string]: any }): void {
    switch (msg.type) {
      case 'joined':
        this.clientId = msg.clientId as string;
        this.handlers.onJoined(
          msg.clientId as string,
          (msg.globalRevision !== undefined ? msg.globalRevision : msg.seq) as number,
          msg.doc as string,
          (msg.clients as ClientInfo[]) || []
        );
        break;

      case 'join':
        this.handlers.onJoin(
          msg.clientId as string,
          msg.clientName as string,
          msg.color as string
        );
        break;

      case 'operation_committed':
        this.handlers.onOperationCommitted(
          msg.op as Operation,
          msg.serverRevision as number,
          msg.operationId as string,
          msg.clientId as string
        );
        break;

      case 'op': // Legacy server compatibility
        this.handlers.onOperationCommitted(
          msg.operation as Operation,
          (msg.serverSeq || 0) as number,
          (msg.operation && msg.operation.clientSeq ? `op_${msg.operation.clientSeq}` : '') as string,
          (msg.operation && msg.operation.clientId) as string
        );
        break;

      case 'ack':
        this.handlers.onAck(
          msg.operationId as string,
          (msg.serverRevision !== undefined ? msg.serverRevision : msg.serverSeq) as number,
          msg.clientSeq as number | undefined
        );
        break;

      case 'presence_broadcast':
        if (this.handlers.onPresence) {
          this.handlers.onPresence({
            clientId: msg.clientId as string,
            userName: (msg.presence?.userName || msg.userName) as string,
            color: (msg.presence?.color || msg.color) as string,
            cursor: (msg.cursor !== undefined ? msg.cursor : msg.presence?.cursor) as number,
            selectionStart: (msg.selectionStart !== undefined ? msg.selectionStart : msg.presence?.selectionStart) as number,
            selectionEnd: (msg.selectionEnd !== undefined ? msg.selectionEnd : msg.presence?.selectionEnd) as number,
            cursorX: (msg.cursorX !== undefined ? msg.cursorX : msg.x) as number,
            cursorY: (msg.cursorY !== undefined ? msg.cursorY : msg.y) as number,
            overlappingClientIds: msg.overlappingClientIds as string[] | undefined,
          });
        }
        if (msg.cursorX !== undefined || msg.x !== undefined) {
          this.handlers.onCursor(
            msg.clientId as string,
            (msg.cursorX !== undefined ? msg.cursorX : msg.x) as number,
            (msg.cursorY !== undefined ? msg.cursorY : msg.y) as number
          );
        }
        break;

      case 'cursor':
        this.handlers.onCursor(
          msg.clientId as string,
          (msg.cursorX !== undefined ? msg.cursorX : msg.x) as number,
          (msg.cursorY !== undefined ? msg.cursorY : msg.y) as number
        );
        break;

      case 'history_response':
        if (this.handlers.onHistoryResponse) {
          this.handlers.onHistoryResponse(
            msg.fromRevision as number,
            msg.toRevision as number,
            msg.operations as any[]
          );
        }
        break;

      case 'snapshot_response':
        if (this.handlers.onSnapshotResponse) {
          this.handlers.onSnapshotResponse(
            msg.revision as number,
            msg.doc as string,
            msg.pieces as any[] | undefined
          );
        }
        break;

      case 'disconnect':
        this.handlers.onDisconnect(msg.clientId as string);
        break;

      case 'error':
        console.error('Server error received:', msg.code, msg.message);
        if (this.handlers.onError) {
          this.handlers.onError(msg.code, msg.message, msg.operationId);
        }
        break;
    }
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      console.log('Attempting to reconnect...');
      this.connect();
    }, 3000);
  }
}
