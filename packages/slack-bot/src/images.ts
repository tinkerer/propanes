/** Images the agent actually viewed: only tool_result image blocks count —
 * either inline base64 (small) or the server's jsonl-image URL (elided). File
 * paths mentioned in text are never treated as something to upload. */
import { createHash } from 'node:crypto';
import type { ParsedMessage } from './transcript';
import { summarizeToolInput } from './format';

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export type ImageSource =
  | { kind: 'data'; mime: string; bytes: Buffer }
  | { kind: 'url'; path: string };

export interface ImageRef {
  /** Dedupe key: the server URL, or a hash of inline bytes. */
  id: string;
  source: ImageSource;
  /** What the agent read, e.g. the Read tool's file path. */
  label: string;
}

const DATA_RE = /data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)/g;
const URL_RE = /\/api\/v1\/admin\/agent-sessions\/[\w-]+\/jsonl-image\/[\w-]+\/\d+/g;

export function extractImageRefs(msg: ParsedMessage, toolUses: Map<string, ParsedMessage>): ImageRef[] {
  if (msg.role !== 'tool_result' || !msg.content) return [];
  const tool = msg.toolUseResultId ? toolUses.get(msg.toolUseResultId) : undefined;
  const label = tool ? `${tool.toolName || 'tool'} ${summarizeToolInput(tool.toolName, tool.toolInput)}`.trim() : 'image viewed by the agent';
  const refs: ImageRef[] = [];
  let m: RegExpExecArray | null;
  DATA_RE.lastIndex = 0;
  while ((m = DATA_RE.exec(msg.content)) !== null) {
    const bytes = Buffer.from(m[2], 'base64');
    refs.push({ id: `sha1:${createHash('sha1').update(bytes).digest('hex')}`, source: { kind: 'data', mime: m[1], bytes }, label });
  }
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(msg.content)) !== null) {
    refs.push({ id: m[0], source: { kind: 'url', path: m[0] }, label });
  }
  return refs;
}

export function filenameFor(label: string, mime: string, index: number): string {
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : 'png';
  const base = (label.split(/[\s/]+/).pop() || 'image').replace(/[^\w.-]+/g, '_').replace(/\.[a-z0-9]+$/i, '');
  return `${base || 'image'}-${index}.${ext}`;
}
