/** Read the same model catalogs as the authenticated CLIs, without sending a user turn.
 * Runs wherever the user's agents run: on the server host for the operator, on
 * a member's pinned launcher (as their Linux account, with their logins)
 * otherwise — see discoverModelsFor() and the launcher's discover_models. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
export type Runtime = 'claude' | 'codex';
export interface ModelOption { provider: string; runtime: Runtime; id: string; label: string; aliases?: string[]; }

export interface CliOptions { command?: string; args?: string[]; timeoutMs?: number; }
interface JsonRpc {
  request(message: Record<string, unknown>, id: string | number): Promise<any>;
  notify(message: Record<string, unknown>): void;
}

/** Bounded subprocess transport; diagnostics and credentials never enter error messages. */
async function withCli<T>(command: string, args: string[], timeoutMs: number, run: (rpc: JsonRpc) => Promise<T>): Promise<T> {
  const child = spawn(command, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let failure: Error | undefined;
  let disposed = false;
  let bytes = 0;
  const fail = (message: string) => {
    failure ??= new Error(message);
    for (const call of pending.values()) call.reject(failure);
    pending.clear();
  };
  child.on('error', () => fail('Model discovery CLI could not start'));
  child.stdin.on('error', () => fail('Model discovery CLI input closed'));
  child.on('close', () => { if (!disposed) fail('Model discovery CLI exited before replying'); });
  child.stdout.on('data', (data: Buffer) => {
    bytes += data.length;
    if (bytes > 5 * 1024 * 1024) fail('Model discovery response exceeded its size limit');
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (failure) return;
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    const id = message.id ?? (message.type === 'control_response' ? message.response?.request_id : undefined);
    if (id === undefined) return;
    const call = pending.get(String(id));
    if (call) { pending.delete(String(id)); call.resolve(message); }
  });
  const timeout = setTimeout(() => fail('Model discovery CLI timed out'), timeoutMs);
  const notify = (message: Record<string, unknown>) => {
    if (failure) throw failure;
    child.stdin.write(JSON.stringify(message) + '\n');
  };
  try {
    return await run({
      notify,
      request: (message, id) => new Promise((resolve, reject) => {
        if (failure) { reject(failure); return; }
        pending.set(String(id), { resolve, reject });
        try { notify(message); } catch (error) { pending.delete(String(id)); reject(error); }
      }),
    });
  } finally {
    disposed = true;
    clearTimeout(timeout);
    lines.close();
    child.stdin.destroy();
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* process already exited */ }
    };
    kill('SIGTERM');
    const force = setTimeout(() => kill('SIGKILL'), 1000);
    force.unref();
    child.once('close', () => clearTimeout(force));
  }
}

function cliCommand(runtime: Runtime): string {
  const configured = runtime === 'claude' ? process.env.CLAUDE_BIN : process.env.CODEX_BIN;
  if (configured) return configured;
  const name = runtime === 'claude' ? 'claude' : 'codex';
  // systemd's PATH often omits the directory used by the native Claude installer.
  const local = join(homedir(), '.local', 'bin', name);
  return existsSync(local) ? local : name;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const modelId = (value: unknown): value is string => text(value) && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value);

export async function discoverClaudeModels(options: CliOptions = {}): Promise<ModelOption[]> {
  return withCli(options.command ?? cliCommand('claude'), options.args ?? [
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ], options.timeoutMs ?? 30_000, async (rpc) => {
    const message = await rpc.request({ type: 'control_request', request_id: 'model-init', request: { subtype: 'initialize' } }, 'model-init');
    const response = message.response;
    if (response?.subtype !== 'success' || !Array.isArray(response.response?.models)) throw new Error('Claude model discovery returned an invalid response');
    const models = response.response.models;
    if (models.some((m: any) => !m || !modelId(m.value) || !text(m.displayName))) throw new Error('Claude model discovery returned invalid model metadata');
    return models.map((m: any) => ({ provider: 'Anthropic', runtime: 'claude', id: m.value, label: m.displayName,
      aliases: m.value !== 'default' && modelId(m.resolvedModel) && m.resolvedModel !== m.value ? [m.resolvedModel] : [],
    }));
  });
}

export async function discoverCodexModels(options: CliOptions = {}): Promise<ModelOption[]> {
  return withCli(options.command ?? cliCommand('codex'), options.args ?? ['app-server'], options.timeoutMs ?? 30_000, async (rpc) => {
    const init = await rpc.request({ id: 0, method: 'initialize', params: { clientInfo: { name: 'amirobot_model_discovery', version: '0.1.0' } } }, 0);
    if (init.error || !init.result) throw new Error('Codex model discovery initialization failed');
    rpc.notify({ method: 'initialized' });
    const models: ModelOption[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let id = 1;
    do {
      const message = await rpc.request({ id, method: 'model/list', params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } }, id++);
      const result = message.result;
      if (message.error || !Array.isArray(result?.data)) throw new Error('Codex model discovery returned an invalid response');
      for (const model of result.data) {
        if (!model || !modelId(model.model) || !text(model.displayName)) throw new Error('Codex model discovery returned invalid model metadata');
        if (model.hidden === true) continue;
        models.push({ provider: 'OpenAI', runtime: 'codex', id: model.model, label: model.displayName });
      }
      const next = result.nextCursor;
      if (next != null && !text(next)) throw new Error('Codex model discovery returned an invalid cursor');
      cursor = next ?? undefined;
      if (cursor && cursors.has(cursor)) throw new Error('Codex model discovery repeated a cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return models;
  });
}
