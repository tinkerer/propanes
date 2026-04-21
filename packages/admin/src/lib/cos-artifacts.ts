import { signal } from '@preact/signals';

export type CosArtifactKind = 'code' | 'list' | 'table';

export type CosArtifact = {
  id: string;
  kind: CosArtifactKind;
  label: string;
  meta: string;
  lang?: string;
  filename?: string;
  raw: string;
  createdAt: number;
};

export const cosArtifacts = signal<Record<string, CosArtifact>>({});

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

export function artifactIdFor(kind: CosArtifactKind, raw: string): string {
  return `${kind}-${hashStr(raw)}`;
}

export function registerCosArtifact(a: Omit<CosArtifact, 'id' | 'createdAt'> & { id?: string }): CosArtifact {
  const id = a.id || artifactIdFor(a.kind, a.raw);
  const existing = cosArtifacts.value[id];
  if (existing) return existing;
  const entry: CosArtifact = { ...a, id, createdAt: Date.now() };
  cosArtifacts.value = { ...cosArtifacts.value, [id]: entry };
  return entry;
}

export function getCosArtifact(id: string): CosArtifact | null {
  return cosArtifacts.value[id] ?? null;
}
