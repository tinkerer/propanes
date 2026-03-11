import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { applications, navigate } from '../lib/state.js';
import { allSessions, openSession, getSessionLabel, loadAllSessions } from '../lib/sessions.js';
import { recentResults, type RecentResult } from '../lib/settings.js';
import { api } from '../lib/api.js';

interface SearchResult {
  type: 'application' | 'feedback' | 'session';
  id: string;
  title: string;
  subtitle?: string;
  icon: string;
  route: string;
}

interface SessionSearchResult {
  sessionId: string;
  feedbackTitle: string | null;
  agentName: string | null;
  status: string;
  createdAt: string | null;
  errorCount: number;
  matches: Array<{ line: number; content: string; isError: boolean; toolName?: string }>;
}

interface Props {
  onClose: () => void;
}

const AI_PRESETS = [
  { label: 'Find error-causing sessions', query: '', errorsOnly: true, icon: '\u26A0\uFE0F' },
  { label: 'Search JSONL content...', query: '', errorsOnly: false, icon: '\u{1F50D}' },
];

export function SpotlightSearch({ onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advancedQuery, setAdvancedQuery] = useState('');
  const [advancedResults, setAdvancedResults] = useState<SessionSearchResult[]>([]);
  const [advancedLoading, setAdvancedLoading] = useState(false);
  const [advancedSelectedIndex, setAdvancedSelectedIndex] = useState(0);
  const [aiDispatchLoading, setAiDispatchLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const advancedInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (advancedMode) {
      advancedInputRef.current?.focus();
    } else {
      inputRef.current?.focus();
    }
  }, [advancedMode]);

  const search = useCallback((q: string) => {
    if (!q.trim()) {
      setResults([]);
      setSelectedIndex(0);
      return;
    }

    const lower = q.toLowerCase();
    const matched: SearchResult[] = [];

    for (const app of applications.value) {
      if (app.name?.toLowerCase().includes(lower) || app.id?.toLowerCase().includes(lower)) {
        matched.push({
          type: 'application',
          id: app.id,
          title: app.name,
          subtitle: app.projectDir || app.id.slice(0, 12),
          icon: '\u{1F4E6}',
          route: `/app/${app.id}/feedback`,
        });
      }
    }

    for (const s of allSessions.value) {
      if (s.status === 'deleted') continue;
      const customLabel = getSessionLabel(s.id);
      const label = customLabel || s.feedbackTitle || s.agentName || s.id;
      const searchable = [label, s.id, s.paneTitle, s.paneCommand, s.panePath].filter(Boolean).join(' ').toLowerCase();
      if (searchable.includes(lower)) {
        const isPlain = s.permissionProfile === 'plain';
        const plainLabel = s.paneCommand
          ? `${s.paneCommand}:${s.panePath || ''} \u2014 ${s.paneTitle || s.id.slice(-6)}`
          : (s.paneTitle || s.id.slice(-6));
        matched.push({
          type: 'session',
          id: s.id,
          title: customLabel || (isPlain ? `\u{1F5A5}\uFE0F ${plainLabel}` : (s.feedbackTitle || s.agentName || `Session ${s.id.slice(-6)}`)),
          subtitle: s.status,
          icon: isPlain ? '\u{1F4BB}' : '\u26A1',
          route: '',
        });
      }
    }

    setResults(matched);
    setSelectedIndex(0);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params: Record<string, string | number> = { search: q, limit: 10 };
        const res = await api.getFeedback(params);
        setResults((prev) => {
          const feedbackResults: SearchResult[] = res.items.map((item: any) => ({
            type: 'feedback' as const,
            id: item.id,
            title: item.title || 'Untitled feedback',
            subtitle: `${item.status || 'new'}${item.shortId ? ` \u00B7 ${item.shortId}` : ''}`,
            icon: '\u{1F4CB}',
            route: `/app/${item.appId || '__unlinked__'}/feedback/${item.id}`,
          }));
          const nonFeedback = prev.filter((r) => r.type !== 'feedback');
          return [...nonFeedback, ...feedbackResults];
        });
      } catch {
        // ignore search errors
      } finally {
        setLoading(false);
      }
    }, 200);
  }, []);

  useEffect(() => {
    if (!advancedMode) {
      search(query);
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, advancedMode]);

  async function runAdvancedSearch(searchQuery?: string, errorsOnly?: boolean) {
    const q = searchQuery ?? advancedQuery;
    if (!q.trim() && !errorsOnly) return;
    setAdvancedLoading(true);
    setAdvancedResults([]);
    try {
      const res = await api.searchSessionContent({
        query: errorsOnly ? undefined : q,
        errorsOnly: errorsOnly || false,
        limit: 20,
      });
      setAdvancedResults(res.results);
      setAdvancedSelectedIndex(0);
    } catch (err) {
      console.error('Advanced search failed:', err);
    } finally {
      setAdvancedLoading(false);
    }
  }

  async function dispatchAiSearch(promptText: string) {
    setAiDispatchLoading(true);
    onClose();
    try {
      // Get error summary (JSONL errors + console errors from live widget sessions)
      const errorSummary = await api.getSessionErrorSummary();

      let context = '';

      // Console errors from live widget sessions
      if (errorSummary.consoleErrors?.length > 0) {
        context += '\n\nBrowser console errors from live widget sessions:\n';
        for (const ce of errorSummary.consoleErrors) {
          context += `- Widget session on ${ce.url || 'unknown page'}: ${ce.errors.length} error(s)\n`;
          for (const err of ce.errors.slice(0, 3)) {
            context += `  [${err.level}] ${err.message?.slice(0, 200) || 'N/A'}${err.source ? ` (${err.source})` : ''}\n`;
          }
        }
      }

      // JSONL session errors
      if (errorSummary.sessions.length > 0) {
        context += '\n\nJSONL tool errors from agent sessions:\n';
        context += errorSummary.sessions.map((s: any) =>
          `- Session ${s.sessionId.slice(-8)} (${s.agentName || s.feedbackTitle || 'unnamed'}): ${s.errorCount} errors. Sample: ${s.errors[0]?.content?.slice(0, 100) || 'N/A'}`
        ).join('\n');
      }

      if (!context.trim()) {
        context = '\n\nNo errors found in recent JSONL files or live widget console logs.';
      }

      const { sessionId } = await api.setupAssist({
        request: `${promptText}${context}`,
        entityType: 'agent',
      });
      await loadAllSessions();
      openSession(sessionId);
    } catch (err: any) {
      console.error('AI search dispatch failed:', err.message);
    } finally {
      setAiDispatchLoading(false);
    }
  }

  function selectResult(result: SearchResult) {
    const entry: RecentResult = { type: result.type, id: result.id, title: result.title, subtitle: result.subtitle, icon: result.icon, route: result.route };
    recentResults.value = [entry, ...recentResults.value.filter((r) => r.id !== result.id)].slice(0, 10);
    if (result.type === 'session') {
      openSession(result.id);
    } else {
      navigate(result.route);
    }
    onClose();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (advancedMode) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (advancedResults.length > 0) {
          setAdvancedResults([]);
        } else {
          setAdvancedMode(false);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAdvancedSelectedIndex((i) => Math.min(i + 1, advancedResults.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAdvancedSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (advancedResults.length > 0 && advancedSelectedIndex < advancedResults.length) {
          openSession(advancedResults[advancedSelectedIndex].sessionId);
          onClose();
        } else if (advancedQuery.trim()) {
          runAdvancedSearch();
        }
      }
      return;
    }

    const showingRecent = !query && recentResults.value.length > 0;
    const listLen = showingRecent ? recentResults.value.length : results.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, listLen - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (showingRecent && selectedIndex < recentResults.value.length) {
        const r = recentResults.value[selectedIndex];
        if (r.type === 'session') {
          openSession(r.id);
        } else {
          navigate(r.route);
        }
        onClose();
      } else if (results.length > 0) {
        selectResult(results[selectedIndex]);
      }
    }
  }

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector('.spotlight-result.selected') as HTMLElement;
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, advancedSelectedIndex]);

  const grouped = groupResults(results);

  return (
    <div class="spotlight-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class={`spotlight-container ${advancedMode ? 'spotlight-advanced' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div class="spotlight-input-row">
          <span class="spotlight-search-icon">{'\u{1F50D}'}</span>
          {advancedMode ? (
            <input
              ref={advancedInputRef}
              type="text"
              class="spotlight-input"
              placeholder="Search JSONL content, errors, tool calls..."
              value={advancedQuery}
              onInput={(e) => setAdvancedQuery((e.target as HTMLInputElement).value)}
              onKeyDown={handleKeyDown}
            />
          ) : (
            <input
              ref={inputRef}
              type="text"
              class="spotlight-input"
              placeholder="Search applications, feedback, sessions..."
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={handleKeyDown}
            />
          )}
          {(loading || advancedLoading) && <span class="spotlight-spinner" />}
          <button
            class={`spotlight-advanced-btn ${advancedMode ? 'active' : ''}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setAdvancedMode(!advancedMode);
              setAdvancedResults([]);
            }}
            title="\u2318K"
          >
            Advanced
          </button>
          <kbd class="spotlight-esc">esc</kbd>
        </div>

        {advancedMode ? (
          <div class="spotlight-advanced-panel">
            <div class="spotlight-advanced-presets">
              {AI_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  class="spotlight-preset-btn"
                  onClick={() => {
                    if (preset.errorsOnly) {
                      runAdvancedSearch('', true);
                    } else {
                      advancedInputRef.current?.focus();
                    }
                  }}
                >
                  <span>{preset.icon}</span>
                  <span>{preset.label}</span>
                </button>
              ))}
              <button
                class="spotlight-preset-btn spotlight-preset-ai"
                onClick={() => {
                  const prompt = advancedQuery.trim() || 'Which current agent session is causing errors? Look at the console errors and JSONL session data to find the culprit. Suggest a fix.';
                  dispatchAiSearch(prompt);
                }}
                disabled={aiDispatchLoading}
              >
                <span>{'\u2728'}</span>
                <span>{aiDispatchLoading ? 'Dispatching...' : 'Ask AI Assistant'}</span>
              </button>
            </div>
            {advancedQuery.trim() && (
              <div style="padding:0 12px 8px">
                <button
                  class="btn btn-sm btn-primary"
                  style="width:100%"
                  onClick={() => runAdvancedSearch()}
                  disabled={advancedLoading}
                >
                  {advancedLoading ? 'Searching...' : 'Search JSONL Content'}
                </button>
              </div>
            )}
            {advancedResults.length > 0 && (
              <div class="spotlight-results" ref={listRef}>
                <div class="spotlight-category">
                  Sessions with Matches ({advancedResults.length})
                </div>
                {advancedResults.map((r, i) => (
                  <div
                    key={r.sessionId}
                    class={`spotlight-result ${i === advancedSelectedIndex ? 'selected' : ''}`}
                    onClick={() => { openSession(r.sessionId); onClose(); }}
                    onMouseEnter={() => setAdvancedSelectedIndex(i)}
                  >
                    <span class="spotlight-result-icon">{r.errorCount > 0 ? '\u{1F534}' : '\u{1F7E2}'}</span>
                    <div class="spotlight-result-text">
                      <span class="spotlight-result-title">
                        {r.feedbackTitle || r.agentName || `Session ${r.sessionId.slice(-8)}`}
                      </span>
                      <span class="spotlight-result-subtitle">
                        {r.errorCount} error{r.errorCount !== 1 ? 's' : ''} · {r.matches.length} match{r.matches.length !== 1 ? 'es' : ''} · {r.status}
                      </span>
                      {r.matches[0] && (
                        <span class="spotlight-result-snippet">
                          {r.matches[0].toolName && <span class="spotlight-snippet-tool">{r.matches[0].toolName}</span>}
                          {r.matches[0].content.slice(0, 120)}
                        </span>
                      )}
                    </div>
                    <span class="spotlight-result-type">session</span>
                  </div>
                ))}
              </div>
            )}
            {advancedLoading && (
              <div class="spotlight-empty">Scanning JSONL files...</div>
            )}
            {!advancedLoading && advancedResults.length === 0 && advancedQuery && (
              <div class="spotlight-empty" style="padding:12px 16px">
                Press Enter or click Search to find matches in session transcripts
              </div>
            )}
          </div>
        ) : (
          <>
            {!query && recentResults.value.length > 0 && (
              <div class="spotlight-results" ref={listRef}>
                <div class="spotlight-category spotlight-recent-header">
                  <span>Recent</span>
                  <button class="spotlight-clear-recent" onClick={() => { recentResults.value = []; }}>Clear</button>
                </div>
                {recentResults.value.map((r, i) => (
                  <div
                    key={r.id}
                    class={`spotlight-result ${i === selectedIndex ? 'selected' : ''}`}
                    onClick={() => {
                      if (r.type === 'session') { openSession(r.id); } else { navigate(r.route); }
                      onClose();
                    }}
                    onMouseEnter={() => setSelectedIndex(i)}
                  >
                    <span class="spotlight-result-icon">{r.icon}</span>
                    <div class="spotlight-result-text">
                      <span class="spotlight-result-title">{r.title}</span>
                      {r.subtitle && <span class="spotlight-result-subtitle">{r.subtitle}</span>}
                    </div>
                    <span class="spotlight-result-type">{r.type}</span>
                  </div>
                ))}
              </div>
            )}
            {results.length > 0 && (
              <div class="spotlight-results" ref={listRef}>
                {grouped.map(([category, items]) => (
                  <div key={category}>
                    <div class="spotlight-category">{category}</div>
                    {items.map((r) => {
                      const globalIdx = results.indexOf(r);
                      return (
                        <div
                          key={r.id}
                          class={`spotlight-result ${globalIdx === selectedIndex ? 'selected' : ''}`}
                          onClick={() => selectResult(r)}
                          onMouseEnter={() => setSelectedIndex(globalIdx)}
                        >
                          <span class="spotlight-result-icon">{r.icon}</span>
                          <div class="spotlight-result-text">
                            <span class="spotlight-result-title">{r.title}</span>
                            {r.subtitle && <span class="spotlight-result-subtitle">{r.subtitle}</span>}
                          </div>
                          <span class="spotlight-result-type">{r.type}</span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
            {query && results.length === 0 && !loading && (
              <div class="spotlight-empty">No results found</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function groupResults(results: SearchResult[]): [string, SearchResult[]][] {
  const groups: [string, SearchResult[]][] = [];
  const byType: Record<string, SearchResult[]> = {};
  for (const r of results) {
    if (!byType[r.type]) byType[r.type] = [];
    byType[r.type].push(r);
  }
  const order: [string, string][] = [
    ['application', 'Applications'],
    ['session', 'Sessions'],
    ['feedback', 'Feedback'],
  ];
  for (const [type, label] of order) {
    if (byType[type]?.length) groups.push([label, byType[type]]);
  }
  return groups;
}
