import { useState, useEffect, useRef, useCallback } from 'react';
import { RichEditor as Editor } from './RichEditor';
import { CollabClient } from './connection';
import { CursorManager } from './cursorManager';
import { ClientsDropdown } from './components/ClientsDropdown';
import { OTClient } from './otClient';
import { Operation, EmbedRef, ClientInfo } from './types';

/**
 * Main application component for the collaborative text editor
 */
function App() {
  const [connected, setConnected] = useState(false);
  const [clientId, setClientId] = useState<string>('');
  const clientIdRef = useRef<string>('');
  const [doc, setDoc] = useState<string>('');
  const [globalRevision, setGlobalRevision] = useState<number>(0);
  const [cursors, setCursors] = useState<ReturnType<CursorManager['getAllCursors']>>([]);
  const [clients, setClients] = useState<Array<{ id: string; name: string; color: string }>>([]);
  const [remoteSelections, setRemoteSelections] = useState<Map<string, { clientId: string; start: number; end: number; color: string; userName: string }>>(new Map());
  const [clientName, setClientName] = useState<string>('');
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [nameInput, setNameInput] = useState<string>('');

  // Extract documentId from URL query param: e.g. http://localhost:5173/?doc=team-doc
  const documentId = new URLSearchParams(window.location.search).get('doc') || 'default';

  const clientRef = useRef<CollabClient | null>(null);
  const cursorManagerRef = useRef<CursorManager>(new CursorManager());
  const otClientRef = useRef<OTClient>(new OTClient(documentId, '', '', 0));
  const applyOperationRef = useRef<((pos: number, text?: string, length?: number, embed?: EmbedRef) => void) | null>(null);

  const lastMouseMoveTime = useRef<number>(0);
  const cursorUpdateTimeout = useRef<number | null>(null);
  const pendingCursorUpdates = useRef<Map<string, { x: number; y: number; name: string }>>(new Map());

  // Batch cursor updates to reduce re-renders
  const flushCursorUpdates = useCallback(() => {
    if (pendingCursorUpdates.current.size > 0) {
      pendingCursorUpdates.current.forEach((update, cId) => {
        cursorManagerRef.current.updateCursor(cId, update.x, update.y, update.name);
      });
      setCursors(cursorManagerRef.current.getAllCursors());
      pendingCursorUpdates.current.clear();
    }
    cursorUpdateTimeout.current = null;
  }, []);

  // Check for saved name in localStorage on mount
  useEffect(() => {
    const savedName = localStorage.getItem('clientName');
    if (savedName) {
      setClientName(savedName);
      setNameInput(savedName);
    } else {
      setShowNameDialog(true);
    }
  }, []);

  const handleNameSubmit = () => {
    const trimmedName = nameInput.trim();
    if (trimmedName) {
      setClientName(trimmedName);
      localStorage.setItem('clientName', trimmedName);

      let clientIdToUse = localStorage.getItem('stableClientId');
      if (!clientIdToUse) {
        clientIdToUse = `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        localStorage.setItem('stableClientId', clientIdToUse);
      }

      setShowNameDialog(false);
    }
  };

  useEffect(() => {
    if (!clientName) return;

    const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8080';
    const client = new CollabClient(
      wsUrl,
      clientName,
      {
        onJoined: (id, revision, initialDoc, clientsInfo) => {
          clientIdRef.current = id;
          setClientId(id);
          setDoc(initialDoc);
          setGlobalRevision(revision);
          setConnected(true);

          otClientRef.current = new OTClient(documentId, id, initialDoc, revision);

          console.log(`Joined as ${id} on doc "${documentId}" at rev ${revision}`);
          setClients(clientsInfo.map((c) => ({ id: c.id, name: c.name, color: c.color })));

          clientsInfo.forEach((c) => {
            if (c.id !== id) {
              cursorManagerRef.current.updateCursor(c.id, c.cursorX || 0, c.cursorY || 0, c.name);
            }
          });
          setCursors(cursorManagerRef.current.getAllCursors());
        },

        onJoin: (cId, name, color) => {
          console.log('Client joined:', cId, name);
          setClients((prev) => {
            if (prev.some((c) => c.id === cId)) return prev;
            return [...prev, { id: cId, name, color }];
          });
          cursorManagerRef.current.updateCursor(cId, 0, 0, name);
          setCursors(cursorManagerRef.current.getAllCursors());
        },

        onOperationCommitted: (op, serverRevision, operationId, senderId) => {
          // If this committed operation was authored by us, it's already accounted for in local Rope
          if (senderId === clientIdRef.current) {
            setGlobalRevision(serverRevision);
            return;
          }

          // Rebase remote operation against all pending local operations
          const res = otClientRef.current.handleRemoteCommittedOp(op, serverRevision);
          setGlobalRevision(serverRevision);

          // Apply the transformed remote op to the editor view
          if (applyOperationRef.current) {
            applyOperationRef.current(
              res.transformedOp.pos,
              res.transformedOp.text,
              res.transformedOp.len,
              res.transformedOp.embed
            );
          }
        },

        onAck: (operationId, serverRevision) => {
          console.log(`Received ACK for operation ${operationId}, serverRevision: ${serverRevision}`);
          const ackResult = otClientRef.current.handleAck(operationId, serverRevision);
          setGlobalRevision(serverRevision);

          // Promote and send the next buffered local operation
          if (ackResult.shouldSend && ackResult.nextOpToSend) {
            console.log('Promoting buffered op:', ackResult.nextOpToSend.operationId);
            clientRef.current?.sendOperationMessage(ackResult.nextOpToSend);
          }
        },

        onCursor: (cId, x, y) => {
          const existingCursor = cursorManagerRef.current.getCursor(cId);
          setClients((currentClients) => {
            const clientInfo = currentClients.find((c) => c.id === cId);
            const name = existingCursor?.name || clientInfo?.name || cId.slice(0, 8);

            pendingCursorUpdates.current.set(cId, { x, y, name });

            if (cursorUpdateTimeout.current === null) {
              cursorUpdateTimeout.current = window.setTimeout(flushCursorUpdates, 50);
            }

            return currentClients;
          });
        },

        onPresence: (data) => {
          if (data.clientId === clientIdRef.current) return;
          if (data.selectionStart !== undefined && data.selectionEnd !== undefined) {
            setRemoteSelections((prev) => {
              const next = new Map(prev);
              next.set(data.clientId, {
                clientId: data.clientId,
                start: data.selectionStart!,
                end: data.selectionEnd!,
                color: data.color || '#3b82f6',
                userName: data.userName || data.clientId.slice(0, 6),
              });
              return next;
            });
          }
        },

        onDisconnect: (cId) => {
          setClients((prev) => prev.filter((c) => c.id !== cId));
          setRemoteSelections((prev) => {
            const next = new Map(prev);
            next.delete(cId);
            return next;
          });
          cursorManagerRef.current.removeCursor(cId);
          setCursors(cursorManagerRef.current.getAllCursors());
        },

        onHistoryResponse: (_fromRev, _toRev, ops) => {
          otClientRef.current.catchUpHistory(ops);
          const newRev = otClientRef.current.getServerRevision();
          setGlobalRevision(newRev);
          setDoc(otClientRef.current.getLocalRope().toString());
        },

        onSnapshotResponse: (rev, snapshotDoc) => {
          otClientRef.current.reconcileWithRemote(snapshotDoc, rev);
          setGlobalRevision(rev);
          setDoc(snapshotDoc);
        },

        onError: (code, message) => {
          console.error(`Collaboration server error [${code}]:`, message);
        },
      },
      documentId
    );

    client.connect();
    clientRef.current = client;

    return () => {
      client.disconnect();
    };
  }, [clientName, documentId, flushCursorUpdates]);

  const handleChange = (
    pos: number,
    text: string,
    isDelete: boolean,
    length?: number,
    embed?: EmbedRef
  ) => {
    const editType = embed ? 'insert_embed' : isDelete ? 'delete' : 'insert';

    const result = otClientRef.current.applyLocalEdit(
      editType,
      pos,
      isDelete ? undefined : text,
      isDelete ? length : undefined,
      embed
    );

    // Send immediately if outstanding queue was empty
    if (result.shouldSend && result.opMessageToSend) {
      console.log(`Sending operation ${result.opMessageToSend.operationId} (rev ${result.opMessageToSend.baseRevision})`);
      clientRef.current?.sendOperationMessage(result.opMessageToSend);
    } else {
      console.log(`Buffered operation (pending count: ${otClientRef.current.getPendingCount()})`);
    }
  };

  const handleMouseMove = (x: number, y: number) => {
    if (connected) {
      const now = Date.now();
      if (now - lastMouseMoveTime.current < 16) {
        return;
      }
      lastMouseMoveTime.current = now;
      clientRef.current?.sendCursor(x, y);
    }
  };

  const handleSelectionChange = (start: number, end: number, cursor: number) => {
    if (connected) {
      clientRef.current?.sendPresence(start, end, cursor);
    }
  };

  return (
    <div className="app">
      {showNameDialog && (
        <div className="name-dialog-overlay">
          <div className="name-dialog">
            <h2>Welcome to Collaborative Editor</h2>
            <p>Please enter your name to continue:</p>
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleNameSubmit()}
              placeholder="Enter your name"
              autoFocus
            />
            <button onClick={handleNameSubmit} disabled={!nameInput.trim()}>
              Join Editor
            </button>
          </div>
        </div>
      )}
      <header className="app-header">
        <div className="header-left">
          <h1>Collaborative Editor</h1>
          <span className="doc-badge">Doc: {documentId}</span>
          <span className="rev-badge">Rev: {globalRevision}</span>
        </div>
        <div className="header-right">
          {connected && clients.length > 0 && (
            <ClientsDropdown clients={clients} currentClientId={clientId} />
          )}
          <div className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
            <span className="status-dot"></span>
            {connected ? 'Connected' : 'Disconnected'}
          </div>
          {clientName && (
            <button
              className="change-name-btn"
              onClick={() => {
                localStorage.removeItem('clientName');
                localStorage.removeItem('stableClientId');
                window.location.reload();
              }}
              title="Change your display name"
            >
              {clientName}
            </button>
          )}
        </div>
      </header>
      <main className="app-main">
        <Editor
          initialDoc={doc}
          documentId={documentId}
          onChange={handleChange}
          onMouseMove={handleMouseMove}
          onSelectionChange={handleSelectionChange}
          onApplyOperation={(callback) => {
            applyOperationRef.current = callback;
          }}
          remoteCursors={cursors}
          remoteSelections={Array.from(remoteSelections.values())}
        />
      </main>
    </div>
  );
}

export default App;
