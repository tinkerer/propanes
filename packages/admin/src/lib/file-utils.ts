export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
export const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);

export function getExt(path: string): string {
  return path.split('.').pop()?.toLowerCase() || '';
}

export function getLanguage(ext: string): string | undefined {
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
    css: 'css', scss: 'scss', less: 'less',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    sql: 'sql', graphql: 'graphql',
    swift: 'swift', kt: 'kotlin', cs: 'csharp',
    lua: 'lua', pl: 'perl', php: 'php', r: 'r',
    makefile: 'makefile', dockerfile: 'dockerfile',
    diff: 'diff', patch: 'diff',
  };
  return map[ext];
}

export function shortenPath(p: string): string {
  if (p.length <= 60) return p;
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '.../' + parts.slice(-3).join('/');
}
