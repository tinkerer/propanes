import { useMemo, useState } from 'preact/hooks';
import { useTranscriptStream } from '../../lib/transcript-stream.js';
import { openFileViewer } from '../../lib/file-viewer.js';
import { type ParsedMessage } from '../../lib/output-parser.js';
import './conversation.css';

interface FilesCompanionProps {
  sessionId: string;
}

// --- Data extraction types ---

interface FileReadInfo {
  path: string;
  count: number;
  ranges: string[];
}

interface FileEditInfo {
  path: string;
  edits: Array<{ oldStr: string; newStr: string }>;
  writeContent?: string;
}

interface SearchInfo {
  pattern: string;
  path?: string;
  tool: 'Glob' | 'Grep';
}

interface FileSummary {
  reads: Map<string, FileReadInfo>;
  edits: Map<string, FileEditInfo>;
  searches: SearchInfo[];
}

function extractFiles(messages: ParsedMessage[]): FileSummary {
  const reads = new Map<string, FileReadInfo>();
  const edits = new Map<string, FileEditInfo>();
  const searches: SearchInfo[] = [];

  for (const msg of messages) {
    if (msg.role !== 'tool_use' || !msg.toolName) continue;
    const input = msg.toolInput || {};

    switch (msg.toolName) {
      case 'Read': {
        const path = String(input.file_path || '').trim();
        if (!path) break;
        const info = reads.get(path) || { path, count: 0, ranges: [] };
        info.count++;
        const offset = input.offset ? Number(input.offset) : null;
        const limit = input.limit ? Number(input.limit) : null;
        if (offset && limit) info.ranges.push(`${offset}-${offset + limit}`);
        else if (offset) info.ranges.push(`from ${offset}`);
        else if (limit) info.ranges.push(`first ${limit}`);
        reads.set(path, info);
        break;
      }
      case 'Edit': {
        const path = String(input.file_path || '').trim();
        if (!path) break;
        const info = edits.get(path) || { path, edits: [] };
        info.edits.push({
          oldStr: String(input.old_string || ''),
          newStr: String(input.new_string || ''),
        });
        edits.set(path, info);
        break;
      }
      case 'Write': {
        const path = String(input.file_path || '').trim();
        if (!path) break;
        const info = edits.get(path) || { path, edits: [] };
        info.writeContent = String(input.content || '');
        edits.set(path, info);
        break;
      }
      case 'Glob':
      case 'Grep': {
        const pattern = String(input.pattern || '').trim();
        if (pattern) {
          searches.push({
            pattern,
            path: input.path ? String(input.path) : undefined,
            tool: msg.toolName as 'Glob' | 'Grep',
          });
        }
        break;
      }
    }
  }

  return { reads, edits, searches };
}

// --- Path display helpers ---

function shortenPath(p: string): string {
  const parts = p.split('/');
  if (parts.length <= 2) return p;
  const basename = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  return `${parent}/${basename}`;
}

type FileKind = 'edited' | 'written' | 'read';

interface FileEntry {
  path: string;
  kind: FileKind;
  editInfo?: FileEditInfo;
  readInfo?: FileReadInfo;
}

function buildFileList(summary: FileSummary): FileEntry[] {
  const entries: FileEntry[] = [];
  const seen = new Set<string>();

  // Edits first
  for (const [path, info] of summary.edits) {
    seen.add(path);
    const kind: FileKind = info.writeContent !== undefined && info.edits.length === 0
      ? 'written'
      : 'edited';
    entries.push({ path, kind, editInfo: info });
  }

  // Then reads (excluding files that were also edited)
  for (const [path, info] of summary.reads) {
    if (seen.has(path)) continue;
    entries.push({ path, kind: 'read', readInfo: info });
  }

  return entries;
}

// --- Diff rendering ---

function DiffBlock({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  return (
    <div class="conv-file-diff">
      {oldLines.map((line, i) => (
        <div key={`del-${i}`} class="conv-diff-del">- {line}</div>
      ))}
      {newLines.map((line, i) => (
        <div key={`add-${i}`} class="conv-diff-add">+ {line}</div>
      ))}
    </div>
  );
}

function WriteBlock({ content }: { content: string }) {
  const lines = content.split('\n');
  const display = lines.length > 30 ? lines.slice(0, 30) : lines;
  const truncated = lines.length > 30;
  return (
    <div class="conv-file-diff">
      {display.map((line, i) => (
        <div key={i} class="conv-diff-add">+ {line}</div>
      ))}
      {truncated && (
        <div class="conv-diff-truncated">... {lines.length - 30} more lines</div>
      )}
    </div>
  );
}

// --- File row component ---

function FileRow({ entry }: { entry: FileEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasExpandableContent = entry.kind === 'edited' || entry.kind === 'written';

  const badge = entry.kind === 'edited'
    ? { icon: '\u270F', label: 'Edited', cls: 'conv-badge-edit' }
    : entry.kind === 'written'
      ? { icon: '+', label: 'Written', cls: 'conv-badge-write' }
      : { icon: '\uD83D\uDC41', label: 'Read', cls: 'conv-badge-read' };

  const handlePathClick = (e: Event) => {
    e.stopPropagation();
    try {
      openFileViewer(entry.path);
    } catch {
      navigator.clipboard.writeText(entry.path).catch(() => {});
    }
  };

  return (
    <div class="conv-file-row">
      <div
        class={`conv-file-header${hasExpandableContent ? ' conv-file-expandable' : ''}`}
        onClick={hasExpandableContent ? () => setExpanded(e => !e) : undefined}
      >
        <span class={`conv-file-badge ${badge.cls}`} title={badge.label}>
          {badge.icon}
        </span>
        <span
          class="conv-file-path"
          title={entry.path}
          onClick={handlePathClick}
        >
          {shortenPath(entry.path)}
        </span>
        {entry.readInfo && entry.readInfo.count > 1 && (
          <span class="conv-file-meta">{entry.readInfo.count}x</span>
        )}
        {entry.readInfo && entry.readInfo.ranges.length > 0 && (
          <span class="conv-file-meta">
            {entry.readInfo.ranges.slice(0, 2).join(', ')}
            {entry.readInfo.ranges.length > 2 && ` +${entry.readInfo.ranges.length - 2}`}
          </span>
        )}
        {entry.editInfo && entry.editInfo.edits.length > 0 && (
          <span class="conv-file-meta">{entry.editInfo.edits.length} edit{entry.editInfo.edits.length === 1 ? '' : 's'}</span>
        )}
        {hasExpandableContent && (
          <span class="conv-file-caret">{expanded ? '\u25BE' : '\u25B8'}</span>
        )}
      </div>
      {expanded && entry.editInfo && (
        <div class="conv-file-details">
          {entry.editInfo.edits.map((edit, i) => (
            <DiffBlock key={i} oldStr={edit.oldStr} newStr={edit.newStr} />
          ))}
          {entry.editInfo.writeContent !== undefined && entry.editInfo.edits.length === 0 && (
            <WriteBlock content={entry.editInfo.writeContent} />
          )}
        </div>
      )}
    </div>
  );
}

// --- Main component ---

export function FilesCompanion({ sessionId }: FilesCompanionProps) {
  const { messages, loading, isRunning, isSessionDone } = useTranscriptStream(sessionId);

  const summary = useMemo(() => extractFiles(messages), [messages]);
  const fileList = useMemo(() => buildFileList(summary), [summary]);

  if (loading) {
    const msg = isSessionDone
      ? 'Loading transcript...'
      : isRunning
        ? 'Session running, waiting for output...'
        : 'Waiting for agent to start...';
    return <div class="conv-files-list"><div class="conv-files-empty">{msg}</div></div>;
  }

  if (fileList.length === 0 && summary.searches.length === 0) {
    return (
      <div class="conv-files-list">
        <div class="conv-files-empty">No file operations yet.</div>
      </div>
    );
  }

  const editedCount = fileList.filter(f => f.kind === 'edited' || f.kind === 'written').length;
  const readCount = fileList.filter(f => f.kind === 'read').length;

  return (
    <div class="conv-files-list">
      <div class="conv-files-header">
        <span class="conv-files-title">Files</span>
        <span class="conv-files-counts">
          {editedCount > 0 && <span class="conv-files-count-edit">{editedCount} edited</span>}
          {readCount > 0 && <span class="conv-files-count-read">{readCount} read</span>}
          {summary.searches.length > 0 && (
            <span class="conv-files-count-search">{summary.searches.length} search{summary.searches.length === 1 ? '' : 'es'}</span>
          )}
        </span>
      </div>

      {fileList.map(entry => (
        <FileRow key={entry.path} entry={entry} />
      ))}

      {summary.searches.length > 0 && (
        <div class="conv-files-section">
          <div class="conv-files-section-title">Searches</div>
          {summary.searches.map((s, i) => (
            <div key={i} class="conv-file-row conv-search-row">
              <span class="conv-file-badge conv-badge-search" title={s.tool}>
                {s.tool === 'Grep' ? '\uD83D\uDD0D' : '*'}
              </span>
              <span class="conv-search-pattern" title={s.path ? `${s.tool} in ${s.path}` : s.tool}>
                {s.pattern}
              </span>
              {s.path && <span class="conv-file-meta">{shortenPath(s.path)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
