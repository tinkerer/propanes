/** Slack attachments → ProPanes. Files are downloaded from Slack with the bot
 * token (needs `files:read`) and staged through the same routes the admin
 * composer uses, so the agent sees them exactly as it would from the UI. */

/** The subset of Slack's file object the bridge looks at. */
export interface SlackFileInfo {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
  mode?: string;
  is_external?: boolean;
}

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** Image types the feedback/screenshot pipeline renders for the agent. */
export const SCREENSHOT_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface DownloadedFile { name: string; mime: string; bytes: Buffer; }

export type AttachmentClass = { kind: 'image' | 'file' } | { kind: 'skip'; reason: string };

export function classifyAttachment(file: SlackFileInfo): AttachmentClass {
  if (file.mode === 'tombstone' || file.mode === 'hidden_by_limit') return { kind: 'skip', reason: 'no longer available in Slack' };
  if (!file.url_private_download && !file.url_private) return { kind: 'skip', reason: 'not downloadable (Slack post, snippet or external file)' };
  if (typeof file.size === 'number' && file.size > ATTACHMENT_MAX_BYTES) {
    return { kind: 'skip', reason: `${(file.size / 1048576).toFixed(1)} MB exceeds the ${ATTACHMENT_MAX_BYTES / 1048576} MB limit` };
  }
  const mime = (file.mimetype || '').split(';')[0].trim().toLowerCase();
  return { kind: SCREENSHOT_MIMES.has(mime) ? 'image' : 'file' };
}

export class SlackFileAccessError extends Error {
  constructor(public readonly code: 'missing_scope' | 'not_found' | 'http_error', detail: string) {
    super(detail);
    this.name = 'SlackFileAccessError';
  }
}

export interface SlackFileDownloader {
  download(file: SlackFileInfo): Promise<DownloadedFile>;
}

export function displayName(file: SlackFileInfo): string {
  return file.name || file.title || file.id;
}

/** Downloads private Slack files with the bot token. Slack answers an
 * unauthorized download with an HTML sign-in page (status 200), which is how
 * a missing `files:read` scope shows up. */
export function downloaderFromToken(token: string, request: typeof fetch = fetch): SlackFileDownloader {
  return {
    async download(file) {
      const url = file.url_private_download || file.url_private;
      if (!url) throw new SlackFileAccessError('not_found', 'no download URL');
      const res = await request(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (res.status === 404) throw new SlackFileAccessError('not_found', 'file not found');
      if (!res.ok) throw new SlackFileAccessError('http_error', `download failed (${res.status})`);
      if (contentType === 'text/html') throw new SlackFileAccessError('missing_scope', 'Slack returned a sign-in page instead of the file');
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > ATTACHMENT_MAX_BYTES) throw new SlackFileAccessError('http_error', 'file larger than the limit');
      const mime = (file.mimetype || contentType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
      return { name: safeName(displayName(file)), mime, bytes };
    },
  };
}

export function safeName(name: string): string {
  const cleaned = name.replace(/[\\/\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 120) || 'attachment';
}

export interface ForwardedAttachment {
  kind: 'image' | 'file';
  name: string;
  /** Local path on the ProPanes host (the uploads /tmp link). */
  path: string;
  /** Public download URL for agents that are not on the server host. */
  url?: string;
}

/** The wording the admin composer uses when it attaches files to a prompt. */
export function attachmentBlock(items: ForwardedAttachment[], oneLine: boolean): string {
  const images = items.filter((i) => i.kind === 'image');
  const files = items.filter((i) => i.kind === 'file');
  const parts: string[] = [];
  if (oneLine) {
    if (images.length) parts.push(`Attached screenshots: ${images.map((i) => `${i.path}${i.url ? ` (GET ${i.url})` : ''}`).join(', ')}`);
    if (files.length) parts.push(`Attached files: ${files.map((i) => `${i.path}${i.url ? ` (download: ${i.url})` : ''}`).join(', ')}`);
    return parts.join(' · ');
  }
  if (images.length) {
    const urls = images.filter((i) => i.url).map((i) => `- ${i.url}`).join('\n');
    const paths = images.map((i) => `- ${i.path}`).join('\n');
    parts.push(`Attached screenshots${urls ? ' (GET to fetch PNG)' : ''}:\n${urls || paths}${urls ? `\nLocal tmp paths (if agent is on the server host):\n${paths}` : ''}`);
  }
  if (files.length) {
    parts.push(`Attached files (read from these local paths if you are on the server host):\n${files.map((i) => `- ${i.path}${i.url ? ` (download: ${i.url})` : ''}`).join('\n')}`);
  }
  return parts.join('\n\n');
}
