/** The model catalog `[models]` shows: discovered per provider (by the ProPanes
 * server, as the requesting user — see packages/server/src/model-discovery.ts),
 * cached briefly, plus configured extras. */
import type { ModelOption } from './models';
import type { Runtime } from './options';
import type { PropanesClient } from './propanes';

export interface ModelProvider { provider: string; runtime: Runtime; discover(): Promise<ModelOption[]>; }
export interface ModelCatalogSnapshot { models: ModelOption[]; warnings: string[]; }
export interface ModelCatalogSource {
  list(): Promise<ModelCatalogSnapshot>;
  providerForRuntime(runtime: Runtime): string | undefined;
}

export function createModelCatalog(options: {
  providers?: ModelProvider[]; extra?: ModelOption[]; now?: () => number; ttlMs?: number;
} = {}): ModelCatalogSource {
  const providers = options.providers ?? [];
  for (const extra of options.extra ?? []) {
    const provider = providers.find((p) => p.runtime === extra.runtime);
    if (provider && provider.provider !== extra.provider) throw new Error('Custom models must use the provider registered for their runtime');
  }
  const now = options.now ?? Date.now;
  const cache = new Map<string, { models: ModelOption[]; fetchedAt: number }>();
  let pending: Promise<ModelCatalogSnapshot> | undefined;
  return {
    providerForRuntime: (runtime) => providers.find((p) => p.runtime === runtime)?.provider ?? options.extra?.find((m) => m.runtime === runtime)?.provider,
    list: () => {
      if (pending) return pending;
      pending = (async () => {
        const results = await Promise.all(providers.map(async (provider) => {
          const previous = cache.get(provider.provider);
          if (previous && now() - previous.fetchedAt < (options.ttlMs ?? 60_000)) return { models: previous.models, warnings: [] };
          try {
            const models = await provider.discover();
            if (!models.length) throw new Error('Empty model catalog');
            cache.set(provider.provider, { models, fetchedAt: now() });
            return { models, warnings: [] };
          } catch {
            return { models: previous?.models ?? [], warnings: [previous
              ? `${provider.provider} discovery is unavailable; showing its last retrieved model list.`
              : `${provider.provider} discovery is unavailable; its models could not be listed. Try [models] again.`] };
          }
        }));
        // Explicit configuration adds custom options; it never suppresses discovered models.
        const combined = [...results.flatMap((r) => r.models), ...(options.extra ?? [])];
        const models = [...new Map(combined.map((model) => [JSON.stringify([model.provider, model.id]), model])).values()];
        return { models, warnings: results.flatMap((r) => r.warnings) };
      })().finally(() => { pending = undefined; });
      return pending;
    },
  };
}

/** Claude and Codex catalogs as the client's user sees them: discovered by the
 * server on that user's machine with their CLI logins. */
export function apiModelProviders(propanes: Pick<PropanesClient, 'discoverModels'>): ModelProvider[] {
  return [
    { provider: 'Anthropic', runtime: 'claude', discover: () => propanes.discoverModels('claude') },
    { provider: 'OpenAI', runtime: 'codex', discover: () => propanes.discoverModels('codex') },
  ];
}
