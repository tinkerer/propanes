import { useMemo, useState } from 'preact/hooks';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import { cosArtifacts } from '../lib/cos-artifacts.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function codeBody(raw: string): string {
  const m = raw.match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  return m ? m[1] : raw;
}

export function ArtifactCompanionView({ artifactId }: { artifactId: string }) {
  const artifact = cosArtifacts.value[artifactId];
  const [copied, setCopied] = useState(false);

  const body = useMemo(() => {
    if (!artifact) return null;
    if (artifact.kind === 'code') {
      const code = codeBody(artifact.raw);
      try {
        if (artifact.lang && hljs.getLanguage(artifact.lang)) {
          return { __html: hljs.highlight(code, { language: artifact.lang }).value };
        }
      } catch { /* fall through */ }
      return { __html: escapeHtml(code) };
    }
    const html = marked.parse(artifact.raw) as string;
    return { __html: typeof html === 'string' ? html : '' };
  }, [artifact?.raw, artifact?.kind, artifact?.lang]);

  if (!artifact) {
    return (
      <div class="artifact-companion artifact-companion-empty">
        <div class="companion-error">Artifact not found (may have been closed or the page reloaded).</div>
      </div>
    );
  }

  const rawForCopy = artifact.kind === 'code' ? codeBody(artifact.raw) : artifact.raw;

  return (
    <div class="artifact-companion">
      <div class="artifact-companion-header">
        <span class="artifact-companion-kind">
          {artifact.kind === 'code' ? '❮❯' : artifact.kind === 'table' ? '▦' : '☰'}
        </span>
        <span class="artifact-companion-label" title={artifact.label}>{artifact.label}</span>
        <span class="artifact-companion-meta">{artifact.meta}</span>
        <button
          type="button"
          class="artifact-companion-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(rawForCopy);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            } catch { /* ignore */ }
          }}
          title="Copy to clipboard"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <div class="artifact-companion-body-wrap">
        {artifact.kind === 'code' ? (
          <pre class="artifact-companion-body artifact-companion-body-code">
            <code class="hljs" dangerouslySetInnerHTML={body!} />
          </pre>
        ) : (
          <div class="artifact-companion-body cos-md-prose" dangerouslySetInnerHTML={body!} />
        )}
      </div>
    </div>
  );
}
