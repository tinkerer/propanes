import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import type { MessageRole } from '../../lib/output-parser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationFilters {
  /** Hide messages with these roles */
  hiddenRoles: Set<MessageRole>;
  /** Hide tool_use messages with these tool names */
  hiddenTools: Set<string>;
  /** Text search query — highlights matching messages */
  searchQuery: string;
}

export const DEFAULT_FILTERS: ConversationFilters = {
  hiddenRoles: new Set(),
  hiddenTools: new Set(),
  searchQuery: '',
};

export function filtersActive(f: ConversationFilters): boolean {
  return f.hiddenRoles.size > 0 || f.hiddenTools.size > 0 || f.searchQuery.length > 0;
}

// ---------------------------------------------------------------------------
// Chip definitions
// ---------------------------------------------------------------------------

const ROLE_CHIPS: Array<{ id: MessageRole; label: string }> = [
  { id: 'assistant', label: 'Assistant' },
  { id: 'user_input', label: 'User' },
  { id: 'tool_use', label: 'Tools' },
  { id: 'thinking', label: 'Thinking' },
  { id: 'system', label: 'System' },
];

const TOOL_CHIPS: Array<{ id: string; label: string; tools: string[] }> = [
  { id: 'Bash', label: 'Bash', tools: ['Bash'] },
  { id: 'Edit', label: 'Edit', tools: ['Edit'] },
  { id: 'Write', label: 'Write', tools: ['Write'] },
  { id: 'Read', label: 'Read', tools: ['Read'] },
  { id: 'Glob', label: 'Glob', tools: ['Glob'] },
  { id: 'Grep', label: 'Grep', tools: ['Grep'] },
  { id: 'WebSearch', label: 'Web', tools: ['WebFetch', 'WebSearch'] },
  { id: 'Task', label: 'Task', tools: ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite', 'Task'] },
];

/** All tool names covered by TOOL_CHIPS (for the "other" catch-all). */
export const KNOWN_TOOL_NAMES = new Set(TOOL_CHIPS.flatMap(c => c.tools));

/** Resolve a tool name to its chip id, or null for "other". */
export function toolChipId(toolName: string): string | null {
  for (const c of TOOL_CHIPS) {
    if (c.tools.includes(toolName)) return c.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ConversationFilterProps {
  filters: ConversationFilters;
  onFiltersChange: (filters: ConversationFilters) => void;
  /** Total message count (before filtering) */
  totalCount: number;
  /** Filtered-out count */
  filteredCount: number;
}

export function ConversationFilter({ filters, onFiltersChange, totalCount, filteredCount }: ConversationFilterProps) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const active = filtersActive(filters);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popupRef.current && !popupRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const toggleRole = useCallback((role: MessageRole) => {
    const next = new Set(filters.hiddenRoles);
    if (next.has(role)) next.delete(role);
    else next.add(role);
    onFiltersChange({ ...filters, hiddenRoles: next });
  }, [filters, onFiltersChange]);

  const toggleTool = useCallback((toolId: string) => {
    const next = new Set(filters.hiddenTools);
    if (next.has(toolId)) next.delete(toolId);
    else next.add(toolId);
    onFiltersChange({ ...filters, hiddenTools: next });
  }, [filters, onFiltersChange]);

  const setSearch = useCallback((q: string) => {
    onFiltersChange({ ...filters, searchQuery: q });
  }, [filters, onFiltersChange]);

  const clearAll = useCallback(() => {
    onFiltersChange(DEFAULT_FILTERS);
  }, [onFiltersChange]);

  return (
    <div class="conv-header-bar">
      <button
        ref={btnRef}
        class={`conv-filter-btn${active ? ' conv-filter-btn-active' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Filter messages"
      >
        {/* Funnel icon (SVG) */}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ display: 'block' }}>
          <path
            d="M1.5 2h13l-5 6v4.5L7.5 14V8L1.5 2z"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
            fill={active ? 'currentColor' : 'none'}
          />
        </svg>
        {active && <span class="conv-filter-dot" />}
      </button>
      <span class="conv-header-count">{totalCount} messages</span>
      {filteredCount > 0 && (
        <span class="conv-header-filtered">{filteredCount} filtered</span>
      )}
      {filters.searchQuery && (
        <span class="conv-header-search-badge">search: "{filters.searchQuery}"</span>
      )}

      {open && (
        <div ref={popupRef} class="conv-filter-popup">
          {/* Search */}
          <div class="conv-filter-section">
            <input
              type="text"
              class="conv-filter-search"
              placeholder="Filter messages..."
              value={filters.searchQuery}
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
              autoFocus
            />
          </div>

          {/* Roles */}
          <div class="conv-filter-section">
            <div class="conv-filter-section-label">Roles</div>
            <div class="conv-filter-chips">
              {ROLE_CHIPS.map(c => {
                const hidden = filters.hiddenRoles.has(c.id);
                return (
                  <button
                    key={c.id}
                    class={`conv-filter-chip${hidden ? '' : ' conv-filter-chip-active'}`}
                    onClick={() => toggleRole(c.id)}
                    title={hidden ? `Show ${c.label}` : `Hide ${c.label}`}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tools */}
          <div class="conv-filter-section">
            <div class="conv-filter-section-label">Tools</div>
            <div class="conv-filter-chips">
              {TOOL_CHIPS.map(c => {
                const hidden = filters.hiddenTools.has(c.id);
                return (
                  <button
                    key={c.id}
                    class={`conv-filter-chip${hidden ? '' : ' conv-filter-chip-active'}`}
                    onClick={() => toggleTool(c.id)}
                    title={hidden ? `Show ${c.label}` : `Hide ${c.label}`}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Clear all */}
          {active && (
            <div class="conv-filter-section conv-filter-section-footer">
              <button class="conv-filter-clear" onClick={clearAll}>
                Clear all filters
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
