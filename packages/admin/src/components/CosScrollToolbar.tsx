import { useEffect, useRef, useState } from 'preact/hooks';
import { type RefObject } from 'preact';
import { cosLearnings, loadCosLearnings } from '../lib/cos-learnings.js';
import {
  cosToggleLearningsTab,
  setCosSlackMode,
  setCosShowResolved,
  setCosShowArchived,
} from '../lib/cos-popout-tree.js';

export type CosSearchRole = 'all' | 'user' | 'assistant';
export type CosSearchScope = 'text' | 'tools' | 'both';

/**
 * The horizontal toolbar that hangs off the top of the chat scroll area:
 * Tools / Expand-collapse / Search / Learnings / Options + (when search is
 * open) the search input row with role/scope filters.
 *
 * Almost everything is parent state passed through props — the toolbar is a
 * presentational shell, not a state owner. The one piece of internal state is
 * the search-filters dropdown's open flag (clicking outside closes it), which
 * doesn't need to escape this component.
 */
export function CosScrollToolbar({
  hasMessages,
  hasMultipleThreads,
  anyExpanded,
  hiddenThreadCount,
  showTools,
  setShowTools,
  toggleAllThreads,
  searchOpen,
  setSearchOpen,
  searchQuery,
  setSearchQuery,
  searchMatchPos,
  setSearchMatchPos,
  searchMatchCount,
  searchRole,
  setSearchRole,
  searchScope,
  setSearchScope,
  searchInputRef,
  gotoSearchMatch,
  inPane,
  showLearnings,
  setShowLearnings,
  learningsButtonActive,
  optionsMenuOpen,
  setOptionsMenuOpen,
  optionsMenuRef,
  slackMode,
  showResolved,
  showArchived,
}: {
  hasMessages: boolean;
  hasMultipleThreads: boolean;
  anyExpanded: boolean;
  hiddenThreadCount: number;
  showTools: boolean;
  setShowTools: (v: boolean) => void;
  toggleAllThreads: () => void;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  searchMatchPos: number;
  setSearchMatchPos: (v: number) => void;
  searchMatchCount: number;
  searchRole: CosSearchRole;
  setSearchRole: (v: CosSearchRole) => void;
  searchScope: CosSearchScope;
  setSearchScope: (v: CosSearchScope) => void;
  searchInputRef: RefObject<HTMLInputElement>;
  gotoSearchMatch: (pos: number) => void;
  inPane: boolean;
  showLearnings: boolean;
  setShowLearnings: (v: boolean) => void;
  learningsButtonActive: boolean;
  optionsMenuOpen: boolean;
  setOptionsMenuOpen: (v: boolean) => void;
  optionsMenuRef: RefObject<HTMLDivElement>;
  slackMode: boolean;
  showResolved: boolean;
  showArchived: boolean;
}) {
  const [searchFiltersOpen, setSearchFiltersOpen] = useState(false);
  const searchFiltersRef = useRef<HTMLDivElement>(null);

  // Close the filters submenu when the user clicks outside it.
  useEffect(() => {
    if (!searchFiltersOpen) return;
    const onDoc = (e: MouseEvent) => {
      const el = searchFiltersRef.current;
      if (el && !el.contains(e.target as Node)) setSearchFiltersOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [searchFiltersOpen]);

  const filtersActive = slackMode || showResolved || showArchived;
  const searchPlaceholder =
    searchScope === 'tools' ? 'Find filename or edit...'
    : searchScope === 'both' ? 'Find in messages + tool calls...'
    : 'Find in messages...';
  const searchActive = searchRole !== 'all' || searchScope !== 'text';

  return (
    <>
      <div class="cos-scroll-toolbar">
        {hasMessages && (
          <>
            <button
              type="button"
              class={`cos-scroll-toolbar-btn${showTools ? ' cos-scroll-toolbar-btn-active' : ''}`}
              onClick={() => setShowTools(!showTools)}
              title={showTools ? 'Hide tool calls' : 'Show tool calls'}
              aria-pressed={showTools}
            >
              Tools
            </button>
            {hasMultipleThreads && (
              <button
                type="button"
                class="cos-scroll-toolbar-btn"
                onClick={toggleAllThreads}
                title={anyExpanded ? 'Collapse all threads' : 'Expand all threads'}
              >
                {anyExpanded ? 'Collapse' : 'Expand'}
              </button>
            )}
            <button
              type="button"
              class={`cos-scroll-toolbar-btn${searchOpen ? ' cos-scroll-toolbar-btn-active' : ''}`}
              onClick={() => {
                const next = !searchOpen;
                setSearchOpen(next);
                if (!next) { setSearchQuery(''); setSearchMatchPos(0); }
                else requestAnimationFrame(() => searchInputRef.current?.focus());
              }}
              title={searchOpen ? 'Close message search' : 'Search messages in this agent'}
              aria-pressed={searchOpen}
            >
              Search
            </button>
          </>
        )}
        <button
          type="button"
          class={`cos-scroll-toolbar-btn${learningsButtonActive ? ' cos-scroll-toolbar-btn-active' : ''}`}
          onClick={() => {
            if (inPane) {
              const next = !showLearnings;
              setShowLearnings(next);
              if (next) void loadCosLearnings();
            } else {
              // Popout mode: toggle the learnings tab in the popout-local
              // pane-tree instead of opening a fixed-position side drawer.
              const opened = cosToggleLearningsTab('left');
              if (opened) void loadCosLearnings();
            }
          }}
          title="Wiggum self-reflection learnings"
          aria-pressed={learningsButtonActive}
        >
          Learnings{cosLearnings.value.length > 0 ? ` (${cosLearnings.value.length})` : ''}
        </button>
        <div class="cos-options-pill" ref={optionsMenuRef}>
          <button
            type="button"
            class={`cos-scroll-toolbar-btn${filtersActive ? ' cos-scroll-toolbar-btn-active' : ''}`}
            onClick={() => setOptionsMenuOpen(!optionsMenuOpen)}
            title="Toolbar options & filters"
            aria-haspopup="menu"
            aria-expanded={optionsMenuOpen}
          >
            Options{filtersActive ? ' •' : ''}
          </button>
          {optionsMenuOpen && (
            <div class="cos-search-filters-menu" role="menu">
              <div class="cos-search-filters-section">
                <div class="cos-search-filters-label">Display</div>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={slackMode}
                  class={`cos-search-filters-item${slackMode ? ' cos-search-filters-item-active' : ''}`}
                  onClick={() => setCosSlackMode(!slackMode)}
                  title="Hide thread replies inline; open them in a side panel"
                >
                  <span class="cos-search-filters-check">{slackMode ? '✓' : ''}</span>
                  <span>Slack mode</span>
                </button>
              </div>
              <div class="cos-search-filters-section">
                <div class="cos-search-filters-label">Filter threads</div>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={showResolved}
                  class={`cos-search-filters-item${showResolved ? ' cos-search-filters-item-active' : ''}`}
                  onClick={() => setCosShowResolved(!showResolved)}
                  title="Include resolved threads in the chat and rail"
                >
                  <span class="cos-search-filters-check">{showResolved ? '✓' : ''}</span>
                  <span>Show resolved</span>
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={showArchived}
                  class={`cos-search-filters-item${showArchived ? ' cos-search-filters-item-active' : ''}`}
                  onClick={() => setCosShowArchived(!showArchived)}
                  title="Include archived threads in the chat and rail"
                >
                  <span class="cos-search-filters-check">{showArchived ? '✓' : ''}</span>
                  <span>Show archived</span>
                </button>
                {hiddenThreadCount > 0 && (
                  <div class="cos-search-filters-hint">
                    {hiddenThreadCount} thread{hiddenThreadCount === 1 ? '' : 's'} hidden
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {searchOpen && (
        <div class="cos-scroll-search-row">
          <input
            ref={searchInputRef}
            type="text"
            class="cos-scroll-search-input"
            placeholder={searchPlaceholder}
            value={searchQuery}
            onInput={(e) => { setSearchQuery((e.target as HTMLInputElement).value); setSearchMatchPos(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); setSearchOpen(false); setSearchQuery(''); setSearchMatchPos(0); setSearchFiltersOpen(false); }
              else if (e.key === 'Enter') { e.preventDefault(); gotoSearchMatch(searchMatchPos + (e.shiftKey ? -1 : 1)); }
            }}
          />
          <span class="cos-scroll-search-count">
            {(() => {
              const t = searchQuery.trim();
              if (!t) return '';
              if (t.length < 2) return '2+ chars';
              if (searchMatchCount === 0) return '0';
              return `${searchMatchPos + 1} / ${searchMatchCount}`;
            })()}
          </span>
          <button
            type="button"
            class="cos-scroll-toolbar-btn"
            onClick={() => gotoSearchMatch(searchMatchPos - 1)}
            disabled={searchMatchCount === 0}
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            ↑
          </button>
          <button
            type="button"
            class="cos-scroll-toolbar-btn"
            onClick={() => gotoSearchMatch(searchMatchPos + 1)}
            disabled={searchMatchCount === 0}
            title="Next match (Enter)"
            aria-label="Next match"
          >
            ↓
          </button>
          <div class="cos-search-filters" ref={searchFiltersRef}>
            <button
              type="button"
              class={`cos-scroll-toolbar-btn${searchActive ? ' cos-scroll-toolbar-btn-active' : ''}`}
              onClick={() => setSearchFiltersOpen((v) => !v)}
              title="Search filters"
              aria-haspopup="menu"
              aria-expanded={searchFiltersOpen}
            >
              Filters{searchActive ? ' •' : ''}
            </button>
            {searchFiltersOpen && (
              <div class="cos-search-filters-menu" role="menu">
                <div class="cos-search-filters-section">
                  <div class="cos-search-filters-label">Role</div>
                  {([
                    ['all', 'All messages'],
                    ['user', 'You only'],
                    ['assistant', 'Ops only'],
                  ] as const).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      class={`cos-search-filters-item${searchRole === val ? ' cos-search-filters-item-active' : ''}`}
                      onClick={() => { setSearchRole(val); setSearchMatchPos(0); }}
                    >
                      <span class="cos-search-filters-check">{searchRole === val ? '✓' : ''}</span>
                      {label}
                    </button>
                  ))}
                </div>
                <div class="cos-search-filters-section">
                  <div class="cos-search-filters-label">Scope</div>
                  {([
                    ['text', 'Message text'],
                    ['tools', 'Tool calls (filenames, edits)'],
                    ['both', 'Both'],
                  ] as const).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      class={`cos-search-filters-item${searchScope === val ? ' cos-search-filters-item-active' : ''}`}
                      onClick={() => { setSearchScope(val); setSearchMatchPos(0); }}
                    >
                      <span class="cos-search-filters-check">{searchScope === val ? '✓' : ''}</span>
                      {label}
                    </button>
                  ))}
                </div>
                {searchActive && (
                  <button
                    type="button"
                    class="cos-search-filters-reset"
                    onClick={() => { setSearchRole('all'); setSearchScope('text'); setSearchMatchPos(0); }}
                  >
                    Reset filters
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
