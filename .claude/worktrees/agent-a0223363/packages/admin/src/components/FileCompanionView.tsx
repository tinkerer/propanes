import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import { api } from '../lib/api.js';
import { getExt, getLanguage, IMAGE_EXTS } from '../lib/file-utils.js';
import hljs from 'highlight.js/lib/common';

interface Props {
  filePath: string;
}

export function FileCompanionView({ filePath }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedLines, setSelectedLines] = useState<{ start: number; end: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const codeRef = useRef<HTMLDivElement>(null);

  const ext = getExt(filePath);
  const isImage = IMAGE_EXTS.has(ext);
  const fileName = filePath.split('/').pop() || filePath;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    setImageUrl(null);
    setSelectedLines(null);

    (async () => {
      try {
        if (isImage) {
          const url = await api.readFileImage(filePath);
          if (!cancelled) { setImageUrl(url); setLoading(false); }
        } else {
          const result = await api.readFile(filePath);
          if (!cancelled) { setContent(result.content); setLoading(false); }
        }
      } catch (err: any) {
        if (!cancelled) { setError(err.message || 'Failed to load file'); setLoading(false); }
      }
    })();

    return () => { cancelled = true; };
  }, [filePath]);

  const highlightedLines = useCallback(() => {
    if (!content) return [];
    const lang = getLanguage(ext);
    let highlighted: string;
    try {
      highlighted = lang
        ? hljs.highlight(content, { language: lang }).value
        : hljs.highlightAuto(content).value;
    } catch {
      highlighted = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    return highlighted.split('\n');
  }, [content, ext]);

  const lines = content ? highlightedLines() : [];

  function handleLineClick(lineNum: number, e: MouseEvent) {
    if (e.shiftKey && selectedLines) {
      const start = Math.min(selectedLines.start, lineNum);
      const end = Math.max(selectedLines.start, lineNum);
      setSelectedLines({ start, end });
    } else {
      setSelectedLines({ start: lineNum, end: lineNum });
      copyToClipboard(`${filePath}:${lineNum}`);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  function copyRef() {
    if (!selectedLines) return;
    const ref = selectedLines.start === selectedLines.end
      ? `${filePath}:${selectedLines.start}`
      : `${filePath}:${selectedLines.start}-${selectedLines.end}`;
    copyToClipboard(ref);
  }

  function copyCode() {
    if (!selectedLines || !content) return;
    const allLines = content.split('\n');
    const slice = allLines.slice(selectedLines.start - 1, selectedLines.end);
    copyToClipboard(slice.join('\n'));
  }

  function copyPath() {
    copyToClipboard(filePath);
  }

  const isRange = selectedLines && selectedLines.start !== selectedLines.end;

  return (
    <div class="file-companion">
      <div class="file-companion-toolbar">
        <span class="file-companion-path" title={filePath}>{fileName}</span>
        <button class="file-companion-btn" onClick={copyPath} title="Copy path">
          {copied === filePath ? '\u2713' : '\u{1F4CB}'}
        </button>
      </div>
      {loading && <div class="file-companion-loading">Loading...</div>}
      {error && <div class="file-companion-error">{error}</div>}
      {imageUrl && (
        <div class="file-companion-image">
          <img src={imageUrl} alt={fileName} style={{ maxWidth: '100%', maxHeight: '100%' }} />
        </div>
      )}
      {content !== null && (
        <div class="file-companion-code" ref={codeRef}>
          {isRange && selectedLines && (
            <div class="file-companion-selection-toolbar">
              <span>Lines {selectedLines.start}-{selectedLines.end}</span>
              <button onClick={copyRef}>Copy ref</button>
              <button onClick={copyCode}>Copy code</button>
            </div>
          )}
          {lines.map((html, i) => {
            const lineNum = i + 1;
            const isSelected = selectedLines &&
              lineNum >= selectedLines.start && lineNum <= selectedLines.end;
            return (
              <div
                key={i}
                class={`file-companion-line${isSelected ? ' selected' : ''}`}
              >
                <span
                  class="file-companion-linenum"
                  onClick={(e) => handleLineClick(lineNum, e as any)}
                >
                  {lineNum}
                </span>
                <span class="file-companion-linetext" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
              </div>
            );
          })}
        </div>
      )}
      {copied && (
        <div class="file-companion-toast">Copied!</div>
      )}
    </div>
  );
}
