/** Resolve human target names conservatively; ambiguity must never launch work. */
interface Target { id: string; name: string; hostname?: string; }

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) {
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
    }
    row = next;
  }
  return row[b.length];
}

export class TargetResolutionError extends Error {}

export function resolveTarget<T extends Target>(kind: 'app' | 'infra', query: string, targets: T[]): T {
  const exactId = targets.find(t => t.id.toLowerCase() === query.toLowerCase());
  if (exactId) return exactId;
  const q = normalize(query);
  const names = (t: T) => [t.name, t.hostname, t.id].filter((s): s is string => !!s).map(normalize);
  let matches = q ? targets.filter(t => names(t).includes(q)) : [];
  if (!matches.length && q) matches = targets.filter(t => names(t).some(n => n.includes(q)));
  if (!matches.length && q.length >= 4) {
    const fuzzyNames = (t: T) => [...names(t), ...[t.name, t.hostname ?? ''].flatMap(n => n.split(/[^\p{L}\p{N}]+/u).map(normalize))];
    matches = targets.filter(t => fuzzyNames(t).some(n => distance(q, n) <= Math.min(3, Math.floor(Math.min(q.length, n.length) / 4))));
  }
  if (matches.length === 1) return matches[0];
  const choices = (matches.length ? matches : targets).slice(0, 10)
    .map(t => `${t.name} [${kind}:${t.id}]`).join(', ');
  throw new TargetResolutionError(matches.length
    ? `Ambiguous ${kind} "${query}". Mention me again with your request and an exact selector: ${choices}.`
    : `No ${kind} matches "${query}". ${choices ? `Available choices: ${choices}.` : 'No targets are available.'}`);
}
