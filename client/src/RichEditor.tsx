import { useEffect, useRef, useState, useCallback } from 'react';
import { CursorInfo } from './cursorManager';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { Rope, RopePiece, EmbedRef } from './rope';

interface RichEditorProps {
  initialDoc: string;
  documentId?: string;
  onChange: (pos: number, text: string, isDelete: boolean, length?: number, embed?: EmbedRef) => void;
  onMouseMove: (x: number, y: number) => void;
  onSelectionChange?: (start: number, end: number, cursor: number) => void;
  onApplyOperation?: (callback: (pos: number, text?: string, length?: number, embed?: EmbedRef) => void) => void;
  remoteCursors?: CursorInfo[];
  remoteSelections?: Array<{
    clientId: string;
    start: number;
    end: number;
    color: string;
    userName: string;
  }>;
}

/**
 * Computes logical UTF-16/embed offset from DOM node and offset
 */
function getLogicalPosition(container: HTMLElement, targetNode: Node, targetOffset: number): number {
  let offset = 0;
  let found = false;

  function traverse(node: Node): boolean {
    if (node === targetNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += targetOffset;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Offset within element child nodes
        let childOffset = 0;
        for (let i = 0; i < targetOffset && i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if ((child as HTMLElement).dataset?.embedId) {
            childOffset += 1;
          } else {
            childOffset += child.textContent?.length || 0;
          }
        }
        offset += childOffset;
      }
      found = true;
      return true;
    }

    if ((node as HTMLElement).dataset?.embedId) {
      offset += 1;
      return false;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.nodeValue?.length || 0;
      return false;
    }

    for (let i = 0; i < node.childNodes.length; i++) {
      if (traverse(node.childNodes[i])) {
        return true;
      }
    }

    return false;
  }

  traverse(container);
  return found ? offset : container.textContent?.length || 0;
}

/**
 * Sets caret in DOM container based on logical Rope position
 */
function setLogicalCaret(container: HTMLElement, logicalPos: number): void {
  let remaining = logicalPos;
  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  let placed = false;

  function traverse(node: Node): boolean {
    if ((node as HTMLElement).dataset?.embedId) {
      if (remaining <= 1) {
        range.setStartAfter(node);
        range.collapse(true);
        placed = true;
        return true;
      }
      remaining -= 1;
      return false;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.nodeValue?.length || 0;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        placed = true;
        return true;
      }
      remaining -= len;
      return false;
    }

    for (let i = 0; i < node.childNodes.length; i++) {
      if (traverse(node.childNodes[i])) {
        return true;
      }
    }

    return false;
  }

  traverse(container);

  if (!placed) {
    range.selectNodeContents(container);
    range.collapse(false);
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

export function RichEditor({
  initialDoc,
  documentId = 'default',
  onChange,
  onMouseMove,
  onSelectionChange,
  onApplyOperation,
  remoteCursors = [],
  remoteSelections = [],
}: RichEditorProps) {
  // Local authoritative Rope data structure
  const localRopeRef = useRef<Rope>(new Rope(initialDoc));
  const editableRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isApplyingRemoteRef = useRef(false);

  const [docString, setDocString] = useState(initialDoc);
  const [cursorPos, setCursorPos] = useState({ line: 1, column: 1 });

  // Render Rope pieces into DOM while maintaining embeds
  const renderRopeToDom = useCallback((rope: Rope) => {
    if (!editableRef.current) return;
    const pieces = rope.getPieces();

    // If completely empty, keep container clear
    if (pieces.length === 0) {
      editableRef.current.innerHTML = '';
      return;
    }

    const fragment = document.createDocumentFragment();

    const serverBase = typeof window !== 'undefined' ? `http://${window.location.hostname || 'localhost'}:8080` : '';

    for (const piece of pieces) {
      if (piece.type === 'text') {
        fragment.appendChild(document.createTextNode(piece.text));
      } else {
        const span = document.createElement('span');
        span.className = `embed-badge embed-${piece.embed.type}`;
        span.contentEditable = 'false';
        span.dataset.embedId = piece.embed.id;
        span.dataset.embedType = piece.embed.type;
        span.title = `Embed: ${piece.embed.name || piece.embed.id} (${piece.embed.type})`;

        const assetUrl = piece.embed.url || `${serverBase}/api/assets/${piece.embed.id}`;

        if (piece.embed.type === 'image') {
          const img = document.createElement('img');
          img.src = assetUrl;
          img.alt = piece.embed.name || 'image';
          img.className = 'inline-embed-img';
          img.style.maxHeight = '80px';
          img.style.verticalAlign = 'middle';
          img.style.margin = '0 4px';
          img.style.borderRadius = '4px';
          img.onerror = () => {
            img.style.display = 'none';
          };
          span.appendChild(img);
          const caption = document.createElement('span');
          caption.textContent = ` 🖼️ ${piece.embed.name || 'image'}`;
          span.appendChild(caption);
        } else {
          const link = document.createElement('a');
          link.href = assetUrl;
          link.download = piece.embed.name || 'file';
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.className = 'inline-embed-link';
          link.style.textDecoration = 'none';
          link.style.color = 'inherit';
          const icon = piece.embed.type === 'csv' ? '📊 ' : piece.embed.type === 'pdf' ? '📄 ' : '📁 ';
          link.textContent = `${icon}${piece.embed.name || piece.embed.id}`;
          span.appendChild(link);
        }

        fragment.appendChild(span);
      }
    }

    editableRef.current.innerHTML = '';
    editableRef.current.appendChild(fragment);
  }, []);

  // Sync when initialDoc changes
  useEffect(() => {
    localRopeRef.current = new Rope(initialDoc);
    renderRopeToDom(localRopeRef.current);
    setDocString(localRopeRef.current.toString());
  }, [initialDoc, renderRopeToDom]);

  // Hook up remote operation handler
  useEffect(() => {
    if (onApplyOperation) {
      onApplyOperation((pos: number, text?: string, length?: number, embed?: EmbedRef) => {
        if (!editableRef.current) return;

        isApplyingRemoteRef.current = true;

        // Remember current caret
        let currentCaret = 0;
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          if (editableRef.current.contains(range.startContainer)) {
            currentCaret = getLogicalPosition(editableRef.current, range.startContainer, range.startOffset);
          }
        }

        // Apply to local Rope
        if (embed) {
          localRopeRef.current.insertEmbed(pos, embed);
          if (currentCaret >= pos) currentCaret += 1;
        } else if (text !== undefined) {
          localRopeRef.current.insert(pos, text);
          if (currentCaret >= pos) currentCaret += text.length;
        } else if (length !== undefined && length > 0) {
          localRopeRef.current.delete(pos, length);
          if (currentCaret >= pos + length) {
            currentCaret -= length;
          } else if (currentCaret > pos) {
            currentCaret = pos;
          }
        }

        renderRopeToDom(localRopeRef.current);
        setDocString(localRopeRef.current.toString());

        // Restore caret
        try {
          setLogicalCaret(editableRef.current, currentCaret);
        } catch (_) {}

        isApplyingRemoteRef.current = false;
      });
    }
  }, [onApplyOperation, renderRopeToDom]);

  // Handle local user input
  const handleInput = () => {
    if (isApplyingRemoteRef.current || !editableRef.current) return;

    // Reconstruct current text from DOM
    let newText = '';
    const walk = (node: Node) => {
      if ((node as HTMLElement).dataset?.embedId) {
        newText += '\uFFFC'; // Embed placeholder
      } else if (node.nodeType === Node.TEXT_NODE) {
        newText += node.nodeValue || '';
      } else {
        node.childNodes.forEach(walk);
      }
    };
    walk(editableRef.current);

    // Old text representation from local Rope
    const oldPieces = localRopeRef.current.getPieces();
    let oldText = '';
    for (const p of oldPieces) {
      oldText += p.type === 'embed' ? '\uFFFC' : p.text;
    }

    if (oldText === newText) return;

    // Diff oldText and newText to find edit range
    let start = 0;
    while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) {
      start++;
    }

    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }

    const deleteCount = oldEnd - start;
    const insertedText = newText.slice(start, newEnd);

    // Update Local Rope
    if (deleteCount > 0) {
      localRopeRef.current.delete(start, deleteCount);
      onChange(start, '', true, deleteCount);
    }

    if (insertedText.length > 0) {
      // Don't re-insert raw placeholder if it was unchanged embed
      if (insertedText !== '\uFFFC') {
        localRopeRef.current.insert(start, insertedText);
        onChange(start, insertedText, false);
      }
    }

    setDocString(localRopeRef.current.toString());
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (editorContainerRef.current) {
      const rect = editorContainerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      onMouseMove(x, y);
    }
  };

  const handleSelect = () => {
    if (!editableRef.current) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (!editableRef.current.contains(range.startContainer)) return;

    const logicalOffset = getLogicalPosition(editableRef.current, range.startContainer, range.startOffset);
    const textBefore = localRopeRef.current.substring(0, logicalOffset);
    const lines = textBefore.split('\n');
    const line = lines.length;
    const column = lines[lines.length - 1].length + 1;

    setCursorPos({ line, column });

    if (onSelectionChange) {
      const endOffset = getLogicalPosition(editableRef.current, range.endContainer, range.endOffset);
      const start = Math.min(logicalOffset, endOffset);
      const end = Math.max(logicalOffset, endOffset);
      onSelectionChange(start, end, logicalOffset);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;

    const caret = getCurrentLogicalCaret();
    localRopeRef.current.insert(caret, text);
    renderRopeToDom(localRopeRef.current);
    setDocString(localRopeRef.current.toString());
    setLogicalCaret(editableRef.current, caret + text.length);
    onChange(caret, text, false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const serverBase = typeof window !== 'undefined' ? `http://${window.location.hostname || 'localhost'}:8080` : '';
      const res = await fetch(`${serverBase}/api/documents/${documentId}/assets`, {
        method: 'POST',
        headers: {
          'x-document-id': documentId,
          'x-filename': file.name,
          'content-type': file.type || 'application/octet-stream',
        },
        body: file,
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Upload failed with status ${res.status}`);
      }

      const data = await res.json();
      const asset = data.asset;

      const caret = getCurrentLogicalCaret();
      const embed: EmbedRef = {
        id: asset.assetId,
        type: asset.type,
        name: asset.originalFileName,
        url: `${serverBase}/api/assets/${asset.assetId}`,
        mimeType: asset.mimeType,
        size: asset.sizeBytes,
      };

      localRopeRef.current.insertEmbed(caret, embed);
      renderRopeToDom(localRopeRef.current);
      setDocString(localRopeRef.current.toString());
      setLogicalCaret(editableRef.current, caret + 1);

      onChange(caret, '', false, undefined, embed);
    } catch (err: any) {
      alert(`Asset upload error: ${err.message}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const getCurrentLogicalCaret = (): number => {
    if (!editableRef.current) return localRopeRef.current.length();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (editableRef.current.contains(range.startContainer)) {
        return getLogicalPosition(editableRef.current, range.startContainer, range.startOffset);
      }
    }
    return localRopeRef.current.length();
  };

  const handleFormat = (format: string) => {
    if (!editableRef.current) return;
    editableRef.current.focus();

    if (format === 'uploadFile') {
      fileInputRef.current?.click();
      return;
    }

    if (format === 'image') {
      const url = prompt('Enter image URL or asset reference:');
      if (url) {
        const caret = getCurrentLogicalCaret();
        const embed: EmbedRef = {
          id: `img_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          type: 'image',
          name: url.split('/').pop() || 'image.png',
          url,
        };

        localRopeRef.current.insertEmbed(caret, embed);
        renderRopeToDom(localRopeRef.current);
        setDocString(localRopeRef.current.toString());
        setLogicalCaret(editableRef.current, caret + 1);

        onChange(caret, '', false, undefined, embed);
      }
      return;
    }

    if (format === 'file') {
      const fileName = prompt('Enter file name / attachment name:');
      if (fileName) {
        const caret = getCurrentLogicalCaret();
        const embed: EmbedRef = {
          id: `file_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          type: 'file',
          name: fileName,
        };

        localRopeRef.current.insertEmbed(caret, embed);
        renderRopeToDom(localRopeRef.current);
        setDocString(localRopeRef.current.toString());
        setLogicalCaret(editableRef.current, caret + 1);

        onChange(caret, '', false, undefined, embed);
      }
      return;
    }

    switch (format) {
      case 'bold':
        document.execCommand('bold', false);
        break;
      case 'italic':
        document.execCommand('italic', false);
        break;
      case 'underline':
        document.execCommand('underline', false);
        break;
      case 'strikethrough':
        document.execCommand('strikeThrough', false);
        break;
      case 'code':
        document.execCommand('formatBlock', false, 'pre');
        break;
      case 'link':
        const linkUrl = prompt('Enter URL:');
        if (linkUrl) {
          document.execCommand('createLink', false, linkUrl);
        }
        break;
      case 'bulletList':
        document.execCommand('insertUnorderedList', false);
        break;
      case 'numberedList':
        document.execCommand('insertOrderedList', false);
        break;
      case 'h1':
      case 'h2':
      case 'h3':
        document.execCommand('formatBlock', false, format);
        break;
      case 'alignLeft':
        document.execCommand('justifyLeft', false);
        break;
      case 'alignCenter':
        document.execCommand('justifyCenter', false);
        break;
      case 'alignRight':
        document.execCommand('justifyRight', false);
        break;
      default:
        break;
    }

    handleInput();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'b':
          e.preventDefault();
          handleFormat('bold');
          break;
        case 'i':
          e.preventDefault();
          handleFormat('italic');
          break;
        case 'u':
          e.preventDefault();
          handleFormat('underline');
          break;
        default:
          break;
      }
    }
  };

  return (
    <div
      ref={editorContainerRef}
      className="editor-container"
      onMouseMove={handleMouseMove}
    >
      <div className="editor-with-toolbar">
        <div className="editor-toolbar-container">
          <Toolbar onFormat={handleFormat} />
        </div>
        <div className="editor-content-with-toolbar">
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: 'none' }}
            onChange={handleFileUpload}
            accept="image/*,.pdf,.csv,.txt"
          />
          <div
            ref={editableRef}
            className="editor rich-editor"
            contentEditable
            onInput={handleInput}
            onPaste={handlePaste}
            onSelect={handleSelect}
            onClick={handleSelect}
            onKeyUp={handleSelect}
            onKeyDown={handleKeyDown}
            suppressContentEditableWarning
            spellCheck={false}
            data-placeholder="Start typing or insert embed..."
          />
        </div>
      </div>
      <StatusBar content={docString} cursorPosition={cursorPos} />
      <div className="cursors-overlay">
        {remoteCursors.map((cursor) => (
          <div
            key={cursor.clientId}
            className="remote-cursor-pointer"
            style={{
              left: `${cursor.x}px`,
              top: `${cursor.y}px`,
            }}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill={cursor.color}
              style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))' }}
            >
              <path d="M5 3L19 12L12 13L9 20L5 3Z" />
            </svg>
            <div className="cursor-label" style={{ backgroundColor: cursor.color }}>
              {cursor.name}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
