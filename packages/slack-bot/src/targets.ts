/** Resolve human target names conservatively; ambiguity must never launch work. */

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  let previous: number[] | undefined;
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) {
      let cost = Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1));
      if (previous && j > 0 && a[i] === b[j - 1] && a[i - 1] === b[j]) cost = Math.min(cost, previous[j - 1] + 1);
      next.push(cost);
    }
    previous = row;
    row = next;
  }
  return row[b.length];
}

/** Exact IDs win, then normalized aliases, then partial names, then small typos.
 * Return all matches at the first successful level so callers can clarify ambiguity. */
export function matchTargets<T>(targets: readonly T[], query: string, id: (target: T) => string, aliases: (target: T) => string[]): T[] {
  const exactId = targets.filter(t => id(t).toLowerCase() === query.trim().toLowerCase());
  if (exactId.length) return exactId;
  const q = normalize(query);
  if (!q) return [];
  const names = (t: T) => aliases(t).filter(Boolean).map(normalize);
  const exact = targets.filter(t => names(t).includes(q));
  if (exact.length) return exact;
  const partial = targets.filter(t => names(t).some(n => n.includes(q)));
  if (partial.length) return partial;
  if (q.length < 4) return [];
  const fuzzyNames = (t: T) => [...names(t), ...aliases(t).flatMap(n => n.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(normalize))];
  return targets.filter(t => fuzzyNames(t).some(n => distance(q, n) <= Math.min(3, Math.floor(Math.min(q.length, n.length) / 4))));
}
