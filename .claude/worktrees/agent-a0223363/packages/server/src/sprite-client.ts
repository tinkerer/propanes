import WebSocket from 'ws';

const API_BASE = 'https://api.sprites.dev/v1';

function resolveToken(configToken?: string | null): string {
  const token = configToken || process.env.SPRITES_TOKEN;
  if (!token) throw new Error('No Sprites token configured (set per-config token or SPRITES_TOKEN env)');
  return token;
}

function headers(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export interface SpriteInfo {
  id: string;
  name: string;
  status: string;
  url?: string;
}

export async function createSprite(name: string, configToken?: string | null): Promise<SpriteInfo> {
  const token = resolveToken(configToken);
  const res = await fetch(`${API_BASE}/sprites`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create sprite "${name}": ${res.status} ${text}`);
  }
  return res.json();
}

export async function getSprite(name: string, configToken?: string | null): Promise<SpriteInfo> {
  const token = resolveToken(configToken);
  const res = await fetch(`${API_BASE}/sprites/${encodeURIComponent(name)}`, {
    headers: headers(token),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get sprite "${name}": ${res.status} ${text}`);
  }
  return res.json();
}

export async function deleteSprite(name: string, configToken?: string | null): Promise<void> {
  const token = resolveToken(configToken);
  const res = await fetch(`${API_BASE}/sprites/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: headers(token),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to delete sprite "${name}": ${res.status} ${text}`);
  }
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function execCommand(
  name: string,
  cmd: string,
  configToken?: string | null,
): Promise<ExecResult> {
  const token = resolveToken(configToken);
  const res = await fetch(
    `${API_BASE}/sprites/${encodeURIComponent(name)}/exec?cmd=${encodeURIComponent(cmd)}`,
    { method: 'POST', headers: headers(token) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exec failed on sprite "${name}": ${res.status} ${text}`);
  }
  return res.json();
}

export interface ExecSession {
  id: string;
  [key: string]: unknown;
}

export async function listExecSessions(
  name: string,
  configToken?: string | null,
): Promise<ExecSession[]> {
  const token = resolveToken(configToken);
  const res = await fetch(
    `${API_BASE}/sprites/${encodeURIComponent(name)}/exec/sessions`,
    { headers: headers(token) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to list exec sessions for "${name}": ${res.status} ${text}`);
  }
  return res.json();
}

export function openExecWebSocket(
  name: string,
  configToken: string | null | undefined,
  cmdArgs: string[],
  opts: { tty?: boolean; stdin?: boolean; cols?: number; rows?: number } = {},
): WebSocket {
  const token = resolveToken(configToken);
  const params = new URLSearchParams();
  params.set('cmd', cmdArgs.join(' '));
  if (opts.tty) params.set('tty', 'true');
  if (opts.stdin) params.set('stdin', 'true');
  if (opts.cols) params.set('cols', String(opts.cols));
  if (opts.rows) params.set('rows', String(opts.rows));

  const wsUrl = `wss://api.sprites.dev/v1/sprites/${encodeURIComponent(name)}/exec?${params}`;
  const ws = new WebSocket(wsUrl, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return ws;
}
