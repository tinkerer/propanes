/** Model catalog is configurable so providers and model names need no parser changes. */
import type { Runtime } from './options';

export interface ModelOption {
  provider: string;
  runtime: Runtime;
  id: string;
  label: string;
  aliases?: string[];
}

export const DEFAULT_MODELS: ModelOption[] = [
  { provider: 'Anthropic', runtime: 'claude', id: 'opus', label: 'Opus' },
  { provider: 'Anthropic', runtime: 'claude', id: 'sonnet', label: 'Sonnet' },
  { provider: 'Anthropic', runtime: 'claude', id: 'haiku', label: 'Haiku' },
  { provider: 'OpenAI', runtime: 'codex', id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
  { provider: 'OpenAI', runtime: 'codex', id: 'gpt-6-astra', label: 'GPT-6-Astra', aliases: ['astra'] },
  { provider: 'OpenAI', runtime: 'codex', id: 'gpt-6-sol', label: 'GPT-6-Sol' },
  { provider: 'OpenAI', runtime: 'codex', id: 'gpt-6-luna', label: 'GPT-6-Luna', aliases: ['luna'] },
];

export function modelCatalog(json?: string): ModelOption[] {
  if (!json) return DEFAULT_MODELS;
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.length || value.some((m) => !m ||
    typeof m.provider !== 'string' || !m.provider.trim() ||
    !['claude', 'codex'].includes(m.runtime) ||
    typeof m.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(m.id) ||
    typeof m.label !== 'string' || !m.label.trim() ||
    (m.aliases !== undefined && (!Array.isArray(m.aliases) || m.aliases.some((a: unknown) => typeof a !== 'string' || !a.trim()))))) {
    throw new Error('AMIROBOT_MODELS_JSON must be a non-empty array of provider, runtime, id, label and optional aliases.');
  }
  const models = value as ModelOption[];
  // Dispatch chooses a default by runtime; keep that mapping unambiguous.
  for (const model of models) {
    if (models.some((other) => other.runtime === model.runtime && other.provider !== model.provider)) {
      throw new Error('Each model runtime must map to one provider.');
    }
  }
  return models;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export function matchModels(models: ModelOption[], query: string): ModelOption[] {
  const q = normalize(query);
  if (!q) return [];
  const names = (m: ModelOption) => [m.id, m.label, ...(m.aliases ?? [])].map(normalize);
  const exact = models.filter((m) => names(m).includes(q));
  return exact.length ? exact : models.filter((m) => names(m).some((n) => n.includes(q)) || normalize(`${m.provider} ${m.label}`).includes(q));
}
