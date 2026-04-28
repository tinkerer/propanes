import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChiefOfStaffMsg } from './chief-of-staff.js';

/**
 * Owns the find-in-conversation state for the CoS bubble: open flag, query,
 * cursor position, role/scope filters, and the derived match set.
 *
 * Load-bearing: the cursor-clamp effect (`searchMatchPos >= matches.length`)
 * keeps the operator from running off the end when typing shrinks the match
 * count — must remain even though it looks redundant.
 */
export function useCosSearch(messages: ChiefOfStaffMsg[] | undefined) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatchPos, setSearchMatchPos] = useState(0);
  // 'all' | 'user' | 'assistant'
  const [searchRole, setSearchRole] = useState<'all' | 'user' | 'assistant'>('all');
  // 'text' (message body), 'tools' (tool call inputs incl. file paths/edits), 'both'
  const [searchScope, setSearchScope] = useState<'text' | 'tools' | 'both'>('text');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Indices in messages whose text contains the current search query.
  // Recomputed on every keystroke or message-list change. Empty when
  // search panel is closed or query is blank.
  const searchMatches = useMemo(() => {
    if (!searchOpen || !messages) return [] as number[];
    const q = searchQuery.trim().toLowerCase();
    // Require ≥2 chars: single-character queries match almost every word and
    // produce visual noise (a chunky highlight on every "e", "s", etc).
    if (q.length < 2) return [] as number[];
    const out: number[] = [];
    messages.forEach((m, i) => {
      if (searchRole !== 'all' && m.role !== searchRole) return;
      const wantText = searchScope === 'text' || searchScope === 'both';
      const wantTools = searchScope === 'tools' || searchScope === 'both';
      if (wantText && (m.text || '').toLowerCase().includes(q)) { out.push(i); return; }
      if (wantTools && m.toolCalls && m.toolCalls.length > 0) {
        const hay = m.toolCalls
          .map((c: any) => `${c.name} ${JSON.stringify(c.input || {})}`)
          .join('\n')
          .toLowerCase();
        if (hay.includes(q)) out.push(i);
      }
    });
    return out;
  }, [searchOpen, searchQuery, searchRole, searchScope, messages]);

  // Clamp the cursor position whenever the match set shrinks (e.g. typing).
  useEffect(() => {
    if (searchMatchPos >= searchMatches.length) setSearchMatchPos(0);
  }, [searchMatches.length]);

  return {
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchMatchPos,
    setSearchMatchPos,
    searchRole,
    setSearchRole,
    searchScope,
    setSearchScope,
    searchInputRef,
    searchMatches,
  };
}
