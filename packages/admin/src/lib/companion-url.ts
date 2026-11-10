/**
 * Normalize what a user typed into a URL field into something an iframe can
 * load. Root-relative paths (`/files/…`) resolve against the admin origin;
 * a bare host gets `http://` (matching the URL picker). Returns '' for blank
 * input so callers can ignore it.
 */
export function normalizeCompanionUrl(input: string, origin: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `${origin.split('//')[0] || 'http:'}${trimmed}`;
  if (trimmed.startsWith('/')) return `${origin.replace(/\/+$/, '')}${trimmed}`;
  return `http://${trimmed}`;
}
