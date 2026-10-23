import { memo, useCallback } from 'react';

interface ToolbarProps {
  onFormat: (format: string) => void;
}

export const Toolbar = memo(function Toolbar({ onFormat }: ToolbarProps) {
  const handleButtonClick = useCallback((format: string) => {
    onFormat(format);
  }, [onFormat]);

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('bold')}
          title="Bold (Ctrl+B)"
          aria-label="Bold"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 2h5.5a3.5 3.5 0 0 1 2.5 6 3.5 3.5 0 0 1-2.5 6H4V2z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M4 8h5.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('italic')}
          title="Italic (Ctrl+I)"
          aria-label="Italic"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 2h4M6 14h4M8 2l-2 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('underline')}
          title="Underline (Ctrl+U)"
          aria-label="Underline"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 2v5a4 4 0 0 0 8 0V2M2 14h12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('strikethrough')}
          title="Strikethrough"
          aria-label="Strikethrough"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 8h12M5 3h6a3 3 0 0 1 0 6H5M6 13h5a3 3 0 0 0 0-6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="toolbar-separator" />

      <div className="toolbar-group">
        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('h1')}
          title="Heading 1"
          aria-label="Heading 1"
        >
          <span className="toolbar-text">H1</span>
        </button>

        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('h2')}
          title="Heading 2"
          aria-label="Heading 2"
        >
          <span className="toolbar-text">H2</span>
        </button>

        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('h3')}
          title="Heading 3"
          aria-label="Heading 3"
        >
          <span className="toolbar-text">H3</span>
        </button>
      </div>

      <div className="toolbar-separator" />

      <div className="toolbar-group">
        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('link')}
          title="Insert Link (Ctrl+K)"
          aria-label="Insert Link"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 9a3 3 0 0 0 3 3h2a3 3 0 1 0 0-6h-2M8 7a3 3 0 0 1-3-3H3a3 3 0 1 1 0 6h2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('image')}
          title="Insert Image Embed"
          aria-label="Insert Image Embed"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="5.5" cy="5.5" r="1.5" fill="currentColor" />
            <path d="M14 11l-3.5-3.5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>

        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('file')}
          title="Insert File Embed"
          aria-label="Insert File Embed"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M4 2h5l4 4v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.5" />
            <path d="M9 2v4h4" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>

        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('code')}
          title="Code Block"
          aria-label="Code Block"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 4l4 4-4 4M6 12l-4-4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="toolbar-separator" />

      <div className="toolbar-group">
        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('bulletList')}
          title="Bullet List"
          aria-label="Bullet List"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M6 4h8M6 8h8M6 12h8M2 4h.01M2 8h.01M2 12h.01"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('numberedList')}
          title="Numbered List"
          aria-label="Numbered List"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M6 4h8M6 8h8M6 12h8M2 5V2l-1 1M2 8h2l-2 3h2M3 14v-2a1 1 0 1 0-2 0"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="toolbar-separator" />

      <div className="toolbar-group">
        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('alignLeft')}
          title="Align Left"
          aria-label="Align Left"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 4h12M2 8h8M2 12h12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('alignCenter')}
          title="Align Center"
          aria-label="Align Center"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 4h12M4 8h8M2 12h12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('alignRight')}
          title="Align Right"
          aria-label="Align Right"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 4h12M6 8h8M2 12h12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="toolbar-separator" />

      <div className="toolbar-group">
        <button
          className="toolbar-button"
          onClick={() => handleButtonClick('uploadFile')}
          title="Upload Asset (Image, PDF, CSV, File)"
          aria-label="Upload Asset"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 10V2M5 5l3-3 3 3M2 11v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
});
