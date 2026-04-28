import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import { selectedAppId } from '../lib/state.js';
import {
  chiefOfStaffOpen,
  chiefOfStaffAgents,
  chiefOfStaffActiveId,
  chiefOfStaffError,
  toggleChiefOfStaff,
  setChiefOfStaffOpen,
  sendChiefOfStaffMessage,
  getActiveAgent,
  addAgent,
  interruptActiveAgent,
  interruptThread,
  getSessionIdForThread,
  ensureCosPanel,
  retryFailedAssistantMessage,
  dismissFailedAssistantMessage,
  DEFAULT_VERBOSITY,
  type ChiefOfStaffMsg,
  type ChiefOfStaffVerbosity,
  type CosImageAttachment,
  type CosElementRef,
  extractDispatchInfo,
  type DispatchInfo,
  openCosInPane,
  isCosInPane,
  closeCosPane,
  COS_PANE_TAB_ID,
  cosThreadMeta,
  getThreadMeta,
  setThreadResolved,
  setThreadArchived,
} from '../lib/chief-of-staff.js';
import { MessageRenderer } from './MessageRenderer.js';
import { layoutTree as layoutTreeSignal, findLeafWithTab, setFocusedLeaf } from '../lib/pane-tree.js';
import { startPicker, type SelectedElementInfo } from '@propanes/widget/element-picker';
import { ImageEditor } from '@propanes/widget/image-editor';
import {
  popoutPanels,
  persistPopoutState,
  bringToFront,
  getDockedPanelTop,
  getPanelZIndex,
  panelZOrders,
  sidebarWidth,
  sidebarCollapsed,
  dockedOrientation,
  COS_PANEL_ID,
  snapGuides,
  openSession,
  openFeedbackItem,
  updatePanel,
  toggleCompanion,
  activePanelId,
  focusedPanelId,
} from '../lib/sessions.js';
import { handleDragMove, handleResizeMove } from '../lib/popout-physics.js';
import { detectExternalZone, openCosExternally, applyExternalGhostHint } from '../lib/tab-drag.js';
import { isMobile } from '../lib/viewport.js';
import {
  registerCosArtifact,
  artifactIdFor,
  cosArtifacts,
} from '../lib/cos-artifacts.js';
import { openArtifactCompanion, openUrlCompanion } from '../lib/companion-state.js';
import { ArtifactCompanionView } from './ArtifactCompanionView.js';
import { PopupMenu } from './PopupMenu.js';
import { WindowMenu } from './PopoutPanelContent.js';
import {
  cosPopoutTree,
  cosToggleLearningsTab,
  cosIsLearningsOpen,
  cosSlackMode,
  setCosSlackMode,
  cosShowResolved,
  setCosShowResolved,
  cosShowArchived,
  setCosShowArchived,
  cosActiveThread,
  cosOpenThreadTab,
  cosCloseThreadTab,
  cosIsThreadTabOpen,
} from '../lib/cos-popout-tree.js';
import { CosPopoutTreeView } from './CosPopoutTreeView.js';
import { openArtifactDrawerTab, isArtifactDrawerOpen } from '../lib/cos-artifact-drawer.js';
import { cosLearnings, loadCosLearnings } from '../lib/cos-learnings.js';
import {
  cosDrafts,
  getCosDraft,
  setCosDraft,
  clearCosDraft,
  loadCosDrafts,
  hasAnyCosDraftForAgent,
} from '../lib/cos-drafts.js';
import { extractCosReply, stripCosReplyMarkers } from '../lib/cos-reply-tags.js';
import { useCosSearch } from '../lib/use-cos-search.js';
import { useCosVoice } from '../lib/use-cos-voice.js';
import { useCosScreenshot } from '../lib/use-cos-screenshot.js';
import {
  fetchFeedbackTitle,
  getCachedFeedbackTitle,
  feedbackTitlesVersion,
} from '../lib/cos-feedback-titles.js';
import { LearningsPanel } from './LearningsDrawer.js';
import {
  MessageAvatar,
  MessageAttachments,
  MessageBubble,
  Timestamp,
  HighlightedText,
  DayDivider,
  dayKeyOf,
  getAgentAvatarSrc,
} from './CosMessage.js';
import { ThreadBlock, groupIntoThreads, threadKeyOf, type Thread } from './CosThread.js';
import { ThreadPanel } from './CosThreadPanel.js';
import { AttachmentEditorModal } from './CosAttachmentEditor.js';
import { CosAgentSettings } from './CosAgentSettings.js';
import { CosScrollToolbar } from './CosScrollToolbar.js';
import { CosThreadRail, type RailStatus } from './CosThreadRail.js';
import { CosInputToolbar } from './CosInputToolbar.js';
import { CosTabList } from './CosTabList.js';
import { CosResizeHandles } from './CosResizeHandles.js';

marked.setOptions({ gfm: true, breaks: false });

function hasAnyArtifactLeaf(node: import('../lib/pane-tree.js').PaneNode): boolean {
  if (node.type === 'leaf') return node.tabs.some((t) => t.startsWith('artifact:'));
  return hasAnyArtifactLeaf(node.children[0]) || hasAnyArtifactLeaf(node.children[1]);
}




export function ChiefOfStaffToggle() {
  const open = chiefOfStaffOpen.value;
  // Read the layout tree signal so this button re-renders when the cos pane
  // is opened/closed via another entry point.
  const _layout = layoutTreeSignal.value;
  const paneOpen = isCosInPane();
  const mobile = isMobile.value;
  // On mobile the pane mode falls back to the popout (openCosInPane does the
  // redirect), so the toggle's "active" state must key off `open` too —
  // `paneOpen` stays false because we never add `cos:main` to the tree there.
  const active = open || paneOpen;

  function handleClick(e: MouseEvent) {
    // Shift-click → dock CoS into the pane tree for users who want it inline.
    // Close the popout first since the two surfaces are mutually exclusive.
    if (e.shiftKey) {
      if (open) setChiefOfStaffOpen(false);
      if (paneOpen) closeCosPane(); else openCosInPane();
      return;
    }
    // Default: always toggle the popout. Close any docked pane first so the
    // two surfaces don't fight over the same `cos:main` tab.
    if (paneOpen) closeCosPane();
    if (!open && mobile) {
      // If the user tapped the toggle while an input elsewhere still held
      // focus (e.g. the feedback widget textarea), the iOS keyboard stays
      // up and squeezes the popout to near-zero height via
      // --pw-keyboard-inset. Blur first so the keyboard retracts before
      // the popout positions itself.
      const el = document.activeElement as HTMLElement | null;
      if (el && typeof el.blur === 'function') el.blur();
    }
    setChiefOfStaffOpen(!open);
  }

  return (
    <button
      class={`control-bar-btn control-bar-cos-btn${active ? ' control-bar-cos-btn-open' : ''}`}
      onClick={handleClick}
      title="Ops (shift-click to dock in pane)"
      aria-label="Open Ops chat"
    >
      <span class="control-bar-icon" aria-hidden="true">
        {active ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l2.2 6.6L21 10.8l-5.6 3.6L17.2 22 12 18l-5.2 4 1.8-7.6L3 10.8l6.8-2.2z" />
          </svg>
        )}
      </span>
    </button>
  );
}

export type CosMode = 'popout' | 'pane';

export function ChiefOfStaffBubble({
  floatingButton = true,
  mode = 'popout',
}: { floatingButton?: boolean; mode?: CosMode } = {}) {
  const open = chiefOfStaffOpen.value;
  const agents = chiefOfStaffAgents.value;
  const activeId = chiefOfStaffActiveId.value;
  const activeAgent = getActiveAgent();
  const error = chiefOfStaffError.value;
  const mobile = isMobile.value;

  const allPanels = popoutPanels.value;
  const _zOrders = panelZOrders.value;
  const panel = allPanels.find((p) => p.id === COS_PANEL_ID);
  const inPane = mode === 'pane';

  const [input, setInput] = useState(() => getCosDraft(chiefOfStaffActiveId.value, selectedAppId.value));
  type PendingAttachment = { id: string; dataUrl: string; name?: string; mimeType: string };
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [pendingElementRefs, setPendingElementRefs] = useState<CosElementRef[]>([]);
  const [pickerActive, setPickerActive] = useState(false);
  const pickerCleanupRef = useRef<(() => void) | null>(null);
  const [cameraMenuOpen, setCameraMenuOpen] = useState(false);
  const [pickerMenuOpen, setPickerMenuOpen] = useState(false);
  const [cameraMenuPos, setCameraMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [pickerMenuPos, setPickerMenuPos] = useState<{ top: number; left: number } | null>(null);
  const cameraGroupRef = useRef<HTMLDivElement | null>(null);
  const pickerGroupRef = useRef<HTMLDivElement | null>(null);
  const [pickerMultiSelect, setPickerMultiSelect] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-pick-multi') : null;
    return v === '1';
  });
  const [pickerIncludeChildren, setPickerIncludeChildren] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-pick-children') : null;
    return v === '1';
  });
  useEffect(() => { try { localStorage.setItem('pw-cos-pick-multi', pickerMultiSelect ? '1' : '0'); } catch { /* ignore */ } }, [pickerMultiSelect]);
  useEffect(() => { try { localStorage.setItem('pw-cos-pick-children', pickerIncludeChildren ? '1' : '0'); } catch { /* ignore */ } }, [pickerIncludeChildren]);
  const [replyTo, setReplyTo] = useState<{ role: string; text: string; anchorTs?: number; threadServerId?: string | null } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [collapsedThreads, setCollapsedThreads] = useState<Set<number>>(new Set());
  const [showTools, setShowTools] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-show-tools') : null;
    return v === '1';
  });
  const [showLearnings, setShowLearnings] = useState(false);
  const [showThreadPanel, setShowThreadPanel] = useState(false);
  const slackMode = cosSlackMode.value;
  const showResolved = cosShowResolved.value;
  const showArchived = cosShowArchived.value;
  const [editingAttachment, setEditingAttachment] = useState<{ id: string; dataUrl: string } | null>(null);
  const [learningsSide, setLearningsSide] = useState<'left' | 'right'>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-learnings-side') : null;
    return v === 'right' ? 'right' : 'left';
  });
  const [shellRect, setShellRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [inputHeight, setInputHeight] = useState<number | null>(null);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-show-tools', showTools ? '1' : '0'); } catch { /* ignore */ }
  }, [showTools]);
  useEffect(() => {
    if (!slackMode && showThreadPanel) setShowThreadPanel(false);
  }, [slackMode, showThreadPanel]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-learnings-side', learningsSide); } catch { /* ignore */ }
  }, [learningsSide]);
  useEffect(() => {
    if (!showLearnings && !showThreadPanel) { setShellRect(null); return; }
    const el = wrapperRef.current;
    if (!el) return;
    let raf: number | null = null;
    const update = () => {
      const r = el.getBoundingClientRect();
      setShellRect((prev) => {
        if (prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height) return prev;
        return { top: r.top, left: r.left, width: r.width, height: r.height };
      });
    };
    const tick = () => { update(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => { if (raf !== null) cancelAnimationFrame(raf); };
  }, [showLearnings, showThreadPanel, inPane]);

  const [newAgentName, setNewAgentName] = useState<string | null>(null);

  // The active draft scope is (agent, app, threadId-or-empty). When the
  // operator is in "reply to thread" mode (replyTo set) this resolves to that
  // thread's server id; otherwise '' meaning the new-thread compose draft.
  // Putting it in a single derived const keeps the hydrate effect, applyInput,
  // submit, and reply-pill actions all looking at the same key.
  const draftScopeThreadId = replyTo?.threadServerId ?? '';
  // Hydrate the textarea from the server-backed draft store whenever the
  // active agent / app scope / reply-thread scope changes, OR when the draft
  // store itself gets refreshed (e.g. initial load after page refresh). We
  // only overwrite local input if it differs from the stored draft — this
  // keeps in-flight typing from being clobbered when our own optimistic write
  // makes the signal tick.
  useEffect(() => {
    const stored = getCosDraft(activeId, selectedAppId.value, draftScopeThreadId);
    setInput((prev) => (prev === stored ? prev : stored));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, selectedAppId.value, draftScopeThreadId, cosDrafts.value]);
  // Mirror operator typing into the server-backed draft store so the input
  // survives refresh and any peer tabs/windows pick it up.
  function applyInput(next: string): void {
    setInput(next);
    setCosDraft(activeId, selectedAppId.value, draftScopeThreadId, next);
  }
  // Pull all drafts for the current app on mount and whenever the operator
  // switches app scope. Per-(agent, thread) values land in the cosDrafts
  // signal and the hydrate effect above replays them into the textarea.
  useEffect(() => {
    void loadCosDrafts(selectedAppId.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAppId.value]);

  const threads = useMemo(
    () => groupIntoThreads(activeAgent?.messages || []),
    [activeAgent?.messages],
  );
  const collapsibleThreads = threads.filter((t) => t.userIdx !== null);
  const anyExpanded = collapsibleThreads.some((t) => !collapsedThreads.has(t.userIdx!));
  const isAgentStreaming = (activeAgent?.messages || []).some((m) => m.streaming);
  // Read the per-thread meta signal so the rail re-renders when an operator
  // toggles `resolved` or the server pushes a new sessionStatus on hydrate.
  const _threadMetaVersion = cosThreadMeta.value;
  void _threadMetaVersion;

  function threadServerIdFor(t: Thread): string | null {
    return (
      t.userMsg?.threadId ??
      t.replies.find((r) => r.msg.threadId)?.msg.threadId ??
      null
    );
  }

  function railStatusFor(t: Thread): RailStatus {
    const tid = threadServerIdFor(t);
    const meta = tid ? getThreadMeta(tid) : null;
    // Archived wins over resolved — both are terminal triage states but
    // archived is "stash further away".
    if (meta?.archivedAt) return 'archived';
    if (meta?.resolvedAt) return 'resolved';
    if (t.replies.some((r) => r.msg.streaming)) return 'streaming';
    if (unreadByThread.get(t.userIdx)) return 'unread';
    const s = meta?.sessionStatus;
    if (s === 'failed' || s === 'killed') return 'failed';
    if (s === null || s === undefined) return 'gc';
    if (s === 'running' || s === 'pending') return 'streaming';
    // 'idle' | 'completed' (or any other clean terminal) → solid green.
    return 'idle';
  }

  // Apply visibility filters to the thread list. Resolved/archived are hidden
  // by default; toggling the toolbar checkboxes restores them. Threads without
  // a server id (still pending hydration) always show — they can't have meta.
  function isThreadVisible(t: Thread): boolean {
    const tid = threadServerIdFor(t);
    if (!tid) return true;
    const meta = getThreadMeta(tid);
    if (meta?.archivedAt && !showArchived) return false;
    if (meta?.resolvedAt && !meta.archivedAt && !showResolved) return false;
    return true;
  }
  const visibleThreads = threads.filter(isThreadVisible);
  const hiddenThreadCount = threads.length - visibleThreads.length;
  const visibleCollapsibleThreads = visibleThreads.filter((t) => t.userIdx !== null);
  const hasMultipleThreads = visibleCollapsibleThreads.length >= 2;

  function threadKey(t: Thread): string {
    return t.userIdx !== null ? `t-${t.userIdx}` : 'pre';
  }
  function threadAnchorIdx(t: Thread): number | null {
    if (t.userIdx !== null) return t.userIdx;
    const first = t.replies[0];
    return first ? first.idx : null;
  }
  function threadTitle(t: Thread): string {
    const text = t.userMsg?.text?.trim();
    if (text) return text;
    const reply = t.replies[0]?.msg;
    const rt = (reply && extractCosReply(reply.text).displayText) || reply?.text || '';
    return (rt.trim() || 'Thread').slice(0, 80);
  }

  function toggleThread(userIdx: number) {
    setCollapsedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(userIdx)) next.delete(userIdx);
      else next.add(userIdx);
      return next;
    });
  }

  function toggleAllThreads() {
    if (anyExpanded) {
      setCollapsedThreads(new Set(collapsibleThreads.map((t) => t.userIdx!)));
    } else {
      setCollapsedThreads(new Set());
    }
  }

  const wrapperRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Tracking the scroll element as state (in addition to the ref) so effects
  // can re-bind when the chat re-mounts. The popout tree splits when a Thread
  // side panel opens, which causes Preact to mount a fresh `cos-scroll` DOM
  // node — the old listeners are bound to a detached element and the user
  // appears yanked to the top. lastScrollTopRef preserves position across
  // those remounts so we can restore where the user was.
  const [scrollEl, setScrollElState] = useState<HTMLDivElement | null>(null);
  const setScrollEl = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollElState(el);
  }, []);
  const lastScrollTopRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dragging = useRef(false);
  const dragMoved = useRef(false);
  const resizing = useRef<string | null>(null);
  const dragStart = useRef({ mx: 0, my: 0, x: 0, y: 0, w: 0, h: 0, dockedHeight: 0, dockedTopOffset: 0, dockedBaseTop: 0 });

  type ReplyNotification = {
    id: string;
    threadKey: string;
    userIdx: number | null;
    messageIdx: number;
    threadTitle: string;
    snippet: string;
  };
  const [replyNotifs, setReplyNotifs] = useState<ReplyNotification[]>([]);
  const [highlightMsgIdx, setHighlightMsgIdx] = useState<number | null>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const {
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
  } = useCosSearch(activeAgent?.messages);
  const [optionsMenuOpen, setOptionsMenuOpen] = useState(false);
  const optionsMenuRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const seenMsgsRef = useRef<Map<number, boolean>>(new Map());
  const seenInitializedRef = useRef(false);
  const notifTimersRef = useRef<Map<string, number>>(new Map());

  const isVisible = open || inPane;

  function isScrollAtBottom(el: HTMLElement | null): boolean {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  function scrollToBottom(behavior: ScrollBehavior = 'auto') {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }

  // Reset notification + seen state when the active agent changes; the next
  // run of the messages effect will repopulate `seen` without firing notifs
  // for already-loaded history.
  useEffect(() => {
    seenMsgsRef.current = new Map();
    seenInitializedRef.current = false;
    for (const t of notifTimersRef.current.values()) clearTimeout(t);
    notifTimersRef.current.clear();
    setReplyNotifs([]);
    setHighlightMsgIdx(null);
    wasAtBottomRef.current = true;
    lastScrollTopRef.current = 0;
  }, [activeId]);

  // Auto-scroll to bottom on load (panel open, agent switch, or when history
  // count changes while user is already pinned to the bottom). Also restores
  // the prior scrollTop when the chat re-mounts mid-session (popout tree
  // splits) — `scrollEl` in deps fires this on remount even when isVisible /
  // activeId / messages.length are unchanged.
  useEffect(() => {
    if (!isVisible) return;
    const el = scrollEl;
    if (!el) return;
    if (!seenInitializedRef.current || wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      wasAtBottomRef.current = true;
      setShowScrollDown(false);
    } else if (lastScrollTopRef.current > 0 && el.scrollTop === 0) {
      el.scrollTop = lastScrollTopRef.current;
    }
  }, [isVisible, activeId, activeAgent?.messages.length, scrollEl]);

  // Scroll listener: toggle the floating scroll-down button and remember the
  // user's "at bottom" state so new messages don't yank them around.
  useEffect(() => {
    if (!isVisible) return;
    const el = scrollEl;
    if (!el) return;
    const onScroll = () => {
      const atBottom = isScrollAtBottom(el);
      wasAtBottomRef.current = atBottom;
      lastScrollTopRef.current = el.scrollTop;
      setShowScrollDown(!atBottom);
      // Clear any pending notifications once the user is back at the bottom.
      if (atBottom) {
        for (const t of notifTimersRef.current.values()) clearTimeout(t);
        notifTimersRef.current.clear();
        setReplyNotifs((prev) => (prev.length === 0 ? prev : []));
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [isVisible, activeId, scrollEl]);

  // Detect newly-completed assistant replies that arrive while the user is
  // scrolled away from the bottom and surface a stackable notification chip.
  useEffect(() => {
    if (!isVisible) return;
    const agent = activeAgent;
    if (!agent) return;
    const seen = seenMsgsRef.current;

    if (!seenInitializedRef.current) {
      agent.messages.forEach((m, i) => {
        if (m.role === 'assistant') seen.set(i, !!m.streaming);
      });
      seenInitializedRef.current = true;
      return;
    }

    const atBottom = isScrollAtBottom(scrollRef.current);

    const newlyComplete: { idx: number; msg: ChiefOfStaffMsg }[] = [];
    for (let i = 0; i < agent.messages.length; i++) {
      const msg = agent.messages[i];
      if (msg.role !== 'assistant') continue;
      const wasStreaming = seen.get(i);
      const isStreaming = !!msg.streaming;
      seen.set(i, isStreaming);
      if (isStreaming) continue;
      // New completion: streaming→done OR previously-unseen complete msg.
      if (wasStreaming === true || wasStreaming === undefined) {
        newlyComplete.push({ idx: i, msg });
      }
    }

    if (atBottom || newlyComplete.length === 0) return;

    const notifsToAdd: ReplyNotification[] = [];
    for (const { idx, msg } of newlyComplete) {
      const thread = threads.find(
        (t) => t.replies.some((r) => r.idx === idx),
      );
      if (!thread) continue;
      const threadKey = thread.userIdx !== null ? `t-${thread.userIdx}` : 'pre';
      const userText = thread.userMsg?.text?.trim() || '(no prompt)';
      const threadTitle = userText.length > 48 ? userText.slice(0, 48) + '…' : userText;
      const reply = extractCosReply(msg.text);
      const replyText = (reply.displayText || msg.text || '').trim();
      const snippet = replyText.length > 90 ? replyText.slice(0, 90) + '…' : replyText;
      notifsToAdd.push({
        id: `n-${idx}-${Date.now()}`,
        threadKey,
        userIdx: thread.userIdx,
        messageIdx: idx,
        threadTitle,
        snippet,
      });
    }

    if (notifsToAdd.length === 0) return;

    setReplyNotifs((prev) => {
      const replacedKeys = new Set(notifsToAdd.map((n) => n.threadKey));
      const kept = prev.filter((n) => {
        if (!replacedKeys.has(n.threadKey)) return true;
        const t = notifTimersRef.current.get(n.id);
        if (t) { clearTimeout(t); notifTimersRef.current.delete(n.id); }
        return false;
      });
      return [...kept, ...notifsToAdd];
    });

    for (const n of notifsToAdd) {
      const handle = window.setTimeout(() => {
        notifTimersRef.current.delete(n.id);
        setReplyNotifs((prev) => prev.filter((p) => p.id !== n.id));
      }, 8000);
      notifTimersRef.current.set(n.id, handle);
    }
  }, [activeAgent?.messages, threads, isVisible]);

  useEffect(() => {
    return () => {
      for (const t of notifTimersRef.current.values()) clearTimeout(t);
      notifTimersRef.current.clear();
    };
  }, []);

  function dismissReplyNotif(id: string) {
    const handle = notifTimersRef.current.get(id);
    if (handle) { clearTimeout(handle); notifTimersRef.current.delete(id); }
    setReplyNotifs((prev) => prev.filter((n) => n.id !== id));
  }

  function activateReplyNotif(notif: ReplyNotification) {
    if (notif.userIdx !== null && collapsedThreads.has(notif.userIdx)) {
      setCollapsedThreads((prev) => {
        const next = new Set(prev);
        next.delete(notif.userIdx!);
        return next;
      });
    }
    // Wait for the expand re-render before measuring scroll target.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const root = scrollRef.current;
        if (!root) return;
        const sel = `[data-cos-msg-idx="${notif.messageIdx}"]`;
        const target = root.querySelector(sel) as HTMLElement | null;
        if (target) {
          target.scrollIntoView({ behavior: 'auto', block: 'center' });
          setHighlightMsgIdx(notif.messageIdx);
          window.setTimeout(() => {
            setHighlightMsgIdx((cur) => (cur === notif.messageIdx ? null : cur));
          }, 1200);
        }
      });
    });
    dismissReplyNotif(notif.id);
  }

  // Per-thread unread state derived from the in-memory replyNotifs queue.
  // Key is `t.userIdx` for normal threads, `null` for the orphan pre-thread.
  const unreadByThread = useMemo(() => {
    const map = new Map<number | null, { count: number; firstIdx: number; ids: string[] }>();
    for (const n of replyNotifs) {
      const cur = map.get(n.userIdx);
      if (cur) {
        cur.count += 1;
        cur.ids.push(n.id);
        if (n.messageIdx < cur.firstIdx) cur.firstIdx = n.messageIdx;
      } else {
        map.set(n.userIdx, { count: 1, firstIdx: n.messageIdx, ids: [n.id] });
      }
    }
    return map;
  }, [replyNotifs]);

  function scrollToMessageIdx(idx: number) {
    const root = scrollRef.current;
    // Try the fast path first — if the target is already mounted (no
    // collapsed-thread expansion needed), jump synchronously so the operator
    // sees the result on the same frame as their keystroke.
    const fastTarget = root?.querySelector(`[data-cos-msg-idx="${idx}"]`) as HTMLElement | null;
    if (fastTarget) {
      fastTarget.scrollIntoView({ behavior: 'auto', block: 'center' });
      setHighlightMsgIdx(idx);
      window.setTimeout(() => {
        setHighlightMsgIdx((cur) => (cur === idx ? null : cur));
      }, 1200);
      return;
    }
    // Slow path: target is in a collapsed thread. Expand it, then scroll on
    // the next frame once the DOM has the row.
    for (const t of threads) {
      if (t.userIdx === null) continue;
      if (!collapsedThreads.has(t.userIdx)) continue;
      const inThread = t.userIdx === idx || t.replies.some((r) => r.idx === idx);
      if (inThread) {
        setCollapsedThreads((prev) => {
          const next = new Set(prev);
          next.delete(t.userIdx!);
          return next;
        });
        break;
      }
    }
    requestAnimationFrame(() => {
      const r = scrollRef.current;
      if (!r) return;
      const target = r.querySelector(`[data-cos-msg-idx="${idx}"]`) as HTMLElement | null;
      if (!target) return;
      target.scrollIntoView({ behavior: 'auto', block: 'center' });
      setHighlightMsgIdx(idx);
      window.setTimeout(() => {
        setHighlightMsgIdx((cur) => (cur === idx ? null : cur));
      }, 1200);
    });
  }

  function gotoSearchMatch(pos: number) {
    if (searchMatches.length === 0) return;
    const wrapped = ((pos % searchMatches.length) + searchMatches.length) % searchMatches.length;
    setSearchMatchPos(wrapped);
    scrollToMessageIdx(searchMatches[wrapped]);
  }

  // Auto-scroll to first match when query produces a hit.
  useEffect(() => {
    if (searchOpen && searchMatches.length > 0) {
      scrollToMessageIdx(searchMatches[Math.min(searchMatchPos, searchMatches.length - 1)]);
    }
  }, [searchMatches]);

  // (search-filters dropdown outside-click is owned by CosScrollToolbar)

  useEffect(() => {
    if (!optionsMenuOpen) return;
    function onDoc(e: MouseEvent) {
      const root = optionsMenuRef.current;
      if (root && !root.contains(e.target as Node)) setOptionsMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [optionsMenuOpen]);

  // Handle "jump to message" requests from the global cmd-K spotlight. The
  // spotlight already switched the active agent + opened the bubble; we just
  // need to find the matching message index and scroll to it.
  useEffect(() => {
    if (!activeAgent) return;
    const agent = activeAgent;
    function onJump(e: Event) {
      const detail = (e as CustomEvent).detail as { agentId?: string; messageId?: string } | undefined;
      if (!detail || detail.agentId !== agent.id || !detail.messageId) return;
      const idx = agent.messages.findIndex((m) => m.serverId === detail.messageId);
      if (idx >= 0) scrollToMessageIdx(idx);
    }
    window.addEventListener('cos-jump-to-message', onJump as EventListener);
    return () => window.removeEventListener('cos-jump-to-message', onJump as EventListener);
  }, [activeAgent?.id, activeAgent?.messages]);

  function jumpToThread(t: Thread) {
    const unread = unreadByThread.get(t.userIdx);
    // If there are unread replies, jump to the first unread message (block:'start'
    // puts the last-seen content just above the viewport edge). Otherwise jump to
    // the top of the thread (the user-anchor message).
    let targetIdx: number | null;
    if (unread) {
      targetIdx = unread.firstIdx;
    } else {
      targetIdx = threadAnchorIdx(t);
    }
    if (targetIdx === null) return;
    const idx = targetIdx;

    // Fast path: row already mounted — jump synchronously, no RAF, no smooth.
    const root = scrollRef.current;
    const fastTarget = root?.querySelector(`[data-cos-msg-idx="${idx}"]`) as HTMLElement | null;
    if (fastTarget) {
      fastTarget.scrollIntoView({ behavior: 'auto', block: 'start' });
      setHighlightMsgIdx(idx);
      window.setTimeout(() => {
        setHighlightMsgIdx((cur) => (cur === idx ? null : cur));
      }, 1200);
    } else {
      // Slow path: target inside a collapsed thread. Expand, then scroll
      // on the next frame.
      if (t.userIdx !== null && collapsedThreads.has(t.userIdx)) {
        setCollapsedThreads((prev) => {
          const next = new Set(prev);
          next.delete(t.userIdx!);
          return next;
        });
      }
      requestAnimationFrame(() => {
        const r = scrollRef.current;
        if (!r) return;
        const target = r.querySelector(`[data-cos-msg-idx="${idx}"]`) as HTMLElement | null;
        if (!target) return;
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
        setHighlightMsgIdx(idx);
        window.setTimeout(() => {
          setHighlightMsgIdx((cur) => (cur === idx ? null : cur));
        }, 1200);
      });
    }

    if (unread) {
      for (const id of unread.ids) {
        const handle = notifTimersRef.current.get(id);
        if (handle) { clearTimeout(handle); notifTimersRef.current.delete(id); }
      }
      const dismissedIds = new Set(unread.ids);
      setReplyNotifs((prev) => prev.filter((n) => !dismissedIds.has(n.id)));
    }
  }

  useEffect(() => {
    if (open && inputRef.current && !showSettings && !isMobile.value) inputRef.current.focus();
  }, [open, activeId, showSettings]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (inputHeight !== null) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [input, open, inputHeight]);

  function onInputResizeHandleMouseDown(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const ta = inputRef.current;
    if (!ta) return;
    const startY = e.clientY;
    const startHeight = inputHeight ?? ta.clientHeight;
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      const next = Math.max(72, Math.min(600, startHeight + delta));
      setInputHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // CosAgentSettings owns its own edit state and remounts on agent switch
  // (key={activeId}), so the per-(agent,showSettings) reset is implicit.
  useEffect(() => {
    setCollapsedThreads(new Set());
  }, [activeId]);

  function submit() {
    const hasAttach = pendingAttachments.length > 0 || pendingElementRefs.length > 0;
    if (!input.trim() && !hasAttach) return;
    const text = input;
    const attachments: CosImageAttachment[] = pendingAttachments.map((a) => ({
      kind: 'image',
      dataUrl: a.dataUrl,
      name: a.name,
    }));
    const elementRefs: CosElementRef[] = pendingElementRefs.map((e) => ({ ...e }));
    const replyToTs = replyTo?.anchorTs;
    const submittedScopeThreadId = draftScopeThreadId;
    setInput('');
    // Clear whichever scope this submit consumed (the in-thread reply draft
    // OR the new-thread compose draft) so it doesn't reappear on next hydrate.
    clearCosDraft(activeId, selectedAppId.value, submittedScopeThreadId);
    setReplyTo(null);
    setPendingAttachments([]);
    setPendingElementRefs([]);
    sendChiefOfStaffMessage(text, selectedAppId.value, { attachments, elementRefs, replyToTs });
  }

  // Reply-pill "Close" button: drop the in-thread scope but keep the operator's
  // text — it now becomes the agent's new-thread compose draft. Implemented by
  // copying the current text into the new-thread scope before clearing the
  // thread-scoped row, so refresh shows the same text in the right scope.
  function closeReplyKeepText() {
    const text = input;
    if (replyTo?.threadServerId && text.length > 0) {
      // Stash under new-thread scope first so the hydrate effect (which fires
      // on replyTo change) reads back the same text and doesn't blank the box.
      setCosDraft(activeId, selectedAppId.value, '', text);
      clearCosDraft(activeId, selectedAppId.value, replyTo.threadServerId);
    }
    setReplyTo(null);
  }

  // Reply-pill "Save draft" button: persist the current text under the
  // thread's scope (which is already the active scope while replyTo is set),
  // then clear the input so the operator gets a clean canvas. Dropping the
  // reply scope after save means they're back at the new-thread compose with
  // an empty box, which matches Slack's "draft saved, fresh box" feel.
  function saveReplyDraftClearInput() {
    if (!replyTo?.threadServerId) {
      setReplyTo(null);
      return;
    }
    const text = input;
    if (text.length > 0) {
      // applyInput is debounced; force the write through synchronously so the
      // draft is durable before we leave the scope.
      setCosDraft(activeId, selectedAppId.value, replyTo.threadServerId, text);
    } else {
      clearCosDraft(activeId, selectedAppId.value, replyTo.threadServerId);
    }
    setInput('');
    setReplyTo(null);
  }

  function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  async function addImageBlob(blob: Blob, name?: string) {
    try {
      const dataUrl = await blobToDataUrl(blob);
      setPendingAttachments((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          dataUrl,
          name,
          mimeType: blob.type || 'image/png',
        },
      ]);
    } catch (err) {
      console.error('[cos] failed to read image blob:', err);
    }
  }

  async function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    let handled = false;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        handled = true;
        const ext = file.type.split('/')[1] || 'png';
        const name = (file as File).name && (file as File).name !== 'image.png'
          ? (file as File).name
          : `pasted-${Date.now()}.${ext}`;
        await addImageBlob(file, name);
      }
    }
    if (handled) e.preventDefault();
  }

  const {
    capturingScreenshot,
    screenshotExcludeWidget,
    setScreenshotExcludeWidget,
    screenshotExcludeCursor,
    setScreenshotExcludeCursor,
    screenshotMethod,
    setScreenshotMethod,
    screenshotKeepStream,
    setScreenshotKeepStream,
    captureAndAttachScreenshot,
    startTimedScreenshot,
  } = useCosScreenshot({
    onAttachBlob: (blob, name) => addImageBlob(blob, name),
    closeCameraMenu: () => setCameraMenuOpen(false),
  });

  const {
    recording: micRecording,
    elapsed: micElapsed,
    interim: micInterim,
    toggleRecord: toggleMicRecord,
  } = useCosVoice({
    getInputBase: () => input,
    onAppendInput: (next) => applyInput(next),
    focusInput: () => inputRef.current?.focus(),
  });

  function stopElementPicker() {
    if (pickerCleanupRef.current) {
      pickerCleanupRef.current();
      pickerCleanupRef.current = null;
    }
    setPickerActive(false);
  }

  function startElementPick() {
    if (pickerActive) {
      stopElementPicker();
      return;
    }
    const host = wrapperRef.current;
    if (!host) return;
    setPickerActive(true);
    setPickerMenuOpen(false);
    // On mobile the CoS panel fills the viewport, so it must be hidden to allow
    // picking anything else. On desktop the panel stays put and is selectable
    // like any other element — drag/minimize it if it's covering your target.
    const mobile = isMobile.value;
    const prevDisplay = host.style.display;
    if (mobile) host.style.display = 'none';
    const restoreHost = () => {
      if (mobile) host.style.display = prevDisplay;
    };
    const cleanup = startPicker(
      (infos: SelectedElementInfo[]) => {
        restoreHost();
        pickerCleanupRef.current = null;
        setPickerActive(false);
        if (infos.length === 0) return;
        const mapped: CosElementRef[] = infos.map((i) => ({
          selector: i.selector,
          tagName: i.tagName,
          id: i.id || undefined,
          classes: i.classes,
          textContent: i.textContent,
          boundingRect: i.boundingRect,
          attributes: i.attributes,
        }));
        setPendingElementRefs((prev) => [...prev, ...mapped]);
        inputRef.current?.focus();
      },
      host,
      { multiSelect: pickerMultiSelect, excludeWidget: false, includeChildren: pickerIncludeChildren },
    );
    pickerCleanupRef.current = cleanup;
  }

  useEffect(() => {
    return () => {
      if (pickerCleanupRef.current) {
        pickerCleanupRef.current();
        pickerCleanupRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!cameraMenuOpen && !pickerMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node | null;
      if (cameraMenuOpen && cameraGroupRef.current && target && !cameraGroupRef.current.contains(target)) {
        setCameraMenuOpen(false);
      }
      if (pickerMenuOpen && pickerGroupRef.current && target && !pickerGroupRef.current.contains(target)) {
        setPickerMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [cameraMenuOpen, pickerMenuOpen]);

  function handleReply(role: string, text: string, anchorTs?: number, threadServerId?: string | null) {
    const excerpt = text.length > 120 ? text.slice(0, 120) : text;
    setReplyTo({ role, text: excerpt, anchorTs, threadServerId: threadServerId ?? null });
    if (!isMobile.value) inputRef.current?.focus();
  }

  function handleArtifactPopout(artifactId: string) {
    // In pane mode the CoS is already a leaf in the main layout tree, so the
    // existing companion splitter gives the user the familiar left/right/
    // top/bottom pane placement.
    if (inPane) {
      // Anchor the split to the CoS leaf so the artifact becomes a companion
      // of the chat, no matter which leaf currently holds focus.
      const cosLeaf = findLeafWithTab(COS_PANE_TAB_ID);
      if (cosLeaf) setFocusedLeaf(cosLeaf.id);
      openArtifactCompanion(artifactId);
      return;
    }
    // Popout mode: open the artifact in the drawer overlay rather than
    // splitting the cos popout tree — splitting forced the chat to remount
    // under a new SplitPane parent and lost its scroll position.
    const wasEmpty = !isArtifactDrawerOpen() && !hasAnyArtifactLeaf(cosPopoutTree.value.root);
    openArtifactDrawerTab(artifactId);
    // When opening the first artifact, widen the floating panel so the chat
    // and the drawer both have room. Skip when docked — docked width is part
    // of the user's layout and shouldn't jump.
    if (wasEmpty && panel && !panel.docked) {
      const needed = 720;
      if (panel.floatingRect.w < needed) {
        const maxW = typeof window !== 'undefined' ? window.innerWidth - 32 : needed;
        const targetW = Math.max(panel.floatingRect.w, Math.min(needed, maxW));
        const rightEdge = panel.floatingRect.x + targetW;
        const overflow = typeof window !== 'undefined' ? Math.max(0, rightEdge - (window.innerWidth - 8)) : 0;
        updatePanel(COS_PANEL_ID, {
          floatingRect: {
            ...panel.floatingRect,
            w: targetW,
            x: Math.max(8, panel.floatingRect.x - overflow),
          },
        });
        persistPopoutState();
      }
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape' && replyTo) {
      e.preventDefault();
      setReplyTo(null);
    }
  }

  function commitNewAgent() {
    const name = (newAgentName || '').trim();
    if (name) addAgent(name);
    setNewAgentName(null);
  }

  const onHeaderDragStart = useCallback((e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, a, select, textarea')) return;
    e.preventDefault();
    ensureCosPanel();
    const cp = popoutPanels.value.find((p) => p.id === COS_PANEL_ID);
    if (!cp) return;
    dragging.current = true;
    dragMoved.current = false;
    wrapperRef.current?.classList.add('popout-dragging');
    const fr = cp.floatingRect;
    dragStart.current = {
      mx: e.clientX, my: e.clientY, x: fr.x, y: fr.y, w: fr.w, h: fr.h,
      dockedHeight: cp.dockedHeight, dockedTopOffset: cp.dockedTopOffset || 0,
      dockedBaseTop: cp.docked ? (e.clientY - getDockedPanelTop(COS_PANEL_ID)) : 0,
    };
    const ghostLabel = 'Ops chat';
    let ghost: HTMLElement | null = null;
    const ensureGhost = () => {
      if (ghost) return;
      ghost = document.createElement('div');
      ghost.className = 'tab-drag-ghost pane-drag-ghost';
      ghost.textContent = ghostLabel;
      document.body.appendChild(ghost);
    };
    const removeGhost = () => {
      if (ghost) { ghost.remove(); ghost = null; }
    };
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      handleDragMove(ev, COS_PANEL_ID, dragStart.current, dragMoved);
      if (detectExternalZone(ev.clientX, ev.clientY)) {
        ensureGhost();
        applyExternalGhostHint(ghost, ghostLabel, ev.clientX, ev.clientY);
      } else {
        removeGhost();
      }
    };
    const onUp = (ev: MouseEvent) => {
      dragging.current = false;
      wrapperRef.current?.classList.remove('popout-dragging');
      snapGuides.value = [];
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      removeGhost();

      const externalZone = detectExternalZone(ev.clientX, ev.clientY);
      if (externalZone && dragMoved.current) {
        openCosExternally(externalZone);
        setChiefOfStaffOpen(false);
        return;
      }
      persistPopoutState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const onResizeStart = useCallback((edge: string, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const cp = popoutPanels.value.find((p) => p.id === COS_PANEL_ID);
    if (!cp) return;
    resizing.current = edge;
    wrapperRef.current?.classList.add('popout-dragging');
    const fr = cp.floatingRect;
    const curOffset = cp.dockedTopOffset || 0;
    const curTop = getDockedPanelTop(COS_PANEL_ID);
    const baseTop = curTop - curOffset;
    dragStart.current = {
      mx: e.clientX, my: e.clientY, x: fr.x, y: fr.y, w: fr.w, h: fr.h,
      dockedHeight: cp.dockedHeight, dockedTopOffset: curOffset, dockedBaseTop: baseTop,
    };
    const startDockedW = cp.dockedWidth;
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      handleResizeMove(ev, COS_PANEL_ID, resizing.current, dragStart.current, startDockedW);
    };
    const onUp = () => {
      resizing.current = null;
      wrapperRef.current?.classList.remove('popout-dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistPopoutState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const isCosActive = !inPane && activePanelId.value === COS_PANEL_ID;
  const isCosFocused = !inPane && focusedPanelId.value === COS_PANEL_ID;

  let panelStyle: Record<string, string | number> | undefined;
  let isDocked = false;
  let isLeftDocked = false;
  let isMinimized = false;
  if (panel && !inPane) {
    isDocked = panel.docked;
    isLeftDocked = isDocked && panel.dockedSide === 'left';
    isMinimized = !isDocked && !!panel.minimized;
    const zIdx = getPanelZIndex(panel);
    const panelTop = isDocked ? getDockedPanelTop(panel.id) : undefined;
    const orientation = dockedOrientation.value;
    if (isDocked) {
      if (isLeftDocked) {
        panelStyle = {
          position: 'fixed', left: sidebarWidth.value + (sidebarCollapsed.value ? 0 : 3),
          top: panelTop as number, width: panel.dockedWidth, height: panel.dockedHeight, zIndex: zIdx,
        };
      } else if (orientation === 'horizontal') {
        const dockedPanels = popoutPanels.value.filter((p) => p.docked && p.visible && p.dockedSide !== 'left');
        const idx = dockedPanels.findIndex((p) => p.id === panel.id);
        const count = dockedPanels.length;
        const topStart = 40;
        const availH = window.innerHeight - topStart;
        const perPanel = count > 0 ? availH / count : availH;
        panelStyle = { position: 'fixed', right: 0, top: topStart + idx * perPanel, width: panel.dockedWidth, height: perPanel, zIndex: zIdx };
      } else {
        panelStyle = { position: 'fixed', right: 0, top: panelTop as number, width: panel.dockedWidth, height: panel.dockedHeight, zIndex: zIdx };
      }
    } else {
      panelStyle = {
        position: 'fixed', left: panel.floatingRect.x, top: panel.floatingRect.y,
        width: panel.floatingRect.w, height: isMinimized ? 34 : panel.floatingRect.h, zIndex: zIdx,
      };
    }
  }

  // Subscribe to layout signal so `isCosInPane()` re-evaluates when the tree
  // changes (keeps the popout hidden while the cos: tab is live in the tree).
  const _layout = layoutTreeSignal.value;
  const hasCosTabInTree = isCosInPane();
  // Subscribe to the popout-local tree so the CoS panel re-renders when
  // artifact/learnings leaves are added or split ratios change. We mirror the
  // signal into useState via an effect because relying on Preact's
  // signal-auto-subscription alone has missed re-renders when a collapsed
  // tree root happens to share node ids with a previously-rendered snapshot.
  // Subscribe to the popout-local tree so the CoS panel re-renders when
  // artifact/learnings leaves are added or split ratios change.
  const _cosTree = cosPopoutTree.value;
  // In popout mode the learnings panel is a tab in the popout-local tree, so
  // the toolbar button's "open" state is derived from the tree — not from the
  // local `showLearnings` state (which only drives the pane-mode side drawer).
  const learningsPopoutOpen = !inPane && cosIsLearningsOpen();
  const learningsButtonActive = inPane ? showLearnings : learningsPopoutOpen;

  const shouldRenderShell = inPane
    ? !!activeAgent
    : !!(open && activeAgent && panel && panel.visible && !hasCosTabInTree);

  const learningsDrawerWidth = 340;
  type DrawerStyle = {
    position: 'fixed';
    top: number;
    height: number;
    left: number;
    width: number;
    zIndex: number;
    side: 'left' | 'right';
  };
  let learningsDrawerStyle: DrawerStyle | null = null;
  if (showLearnings && shellRect) {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
    let side: 'left' | 'right' = learningsSide;
    const leftSpot = shellRect.left - learningsDrawerWidth;
    const rightSpot = shellRect.left + shellRect.width;
    if (side === 'left' && leftSpot < 0 && rightSpot + learningsDrawerWidth <= vw) side = 'right';
    if (side === 'right' && rightSpot + learningsDrawerWidth > vw && leftSpot >= 0) side = 'left';
    const leftPx = side === 'left'
      ? Math.max(0, leftSpot)
      : Math.min(vw - learningsDrawerWidth, rightSpot);
    const zIdx = !inPane && panel ? getPanelZIndex(panel) + 1 : 900;
    learningsDrawerStyle = {
      position: 'fixed',
      top: shellRect.top,
      height: shellRect.height,
      left: leftPx,
      width: learningsDrawerWidth,
      zIndex: zIdx,
      side,
    };
  }

  const threadDrawerWidth = 380;
  let threadDrawerStyle: DrawerStyle | null = null;
  if (showThreadPanel && shellRect) {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
    // Default to right; if learnings is open on right, slide thread to left.
    let side: 'left' | 'right' = 'right';
    if (learningsDrawerStyle && learningsDrawerStyle.side === 'right') side = 'left';
    const leftSpot = shellRect.left - threadDrawerWidth;
    const rightSpot = shellRect.left + shellRect.width;
    if (side === 'right' && rightSpot + threadDrawerWidth > vw && leftSpot >= 0) side = 'left';
    if (side === 'left' && leftSpot < 0 && rightSpot + threadDrawerWidth <= vw) side = 'right';
    const leftPx = side === 'left'
      ? Math.max(0, leftSpot)
      : Math.min(vw - threadDrawerWidth, rightSpot);
    const zIdx = !inPane && panel ? getPanelZIndex(panel) + 1 : 900;
    threadDrawerStyle = {
      position: 'fixed',
      top: shellRect.top,
      height: shellRect.height,
      left: leftPx,
      width: threadDrawerWidth,
      zIndex: zIdx,
      side,
    };
  }

  return (
    <>
      {!inPane && floatingButton && (
        <button
          class={`cos-bubble${open ? ' cos-bubble-open' : ''}`}
          onClick={toggleChiefOfStaff}
          title="Ops"
          aria-label="Open Ops chat"
        >
          {open ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2l2.2 6.6L21 10.8l-5.6 3.6L17.2 22 12 18l-5.2 4 1.8-7.6L3 10.8l6.8-2.2z" />
            </svg>
          )}
        </button>
      )}

      {shouldRenderShell && activeAgent && inPane && showLearnings && learningsDrawerStyle && (
        <div
          class={`cos-learnings-side cos-learnings-side-${learningsDrawerStyle.side}`}
          style={{
            position: learningsDrawerStyle.position,
            top: learningsDrawerStyle.top,
            left: learningsDrawerStyle.left,
            width: learningsDrawerStyle.width,
            height: learningsDrawerStyle.height,
            zIndex: learningsDrawerStyle.zIndex,
          }}
        >
          <div class="cos-learnings-side-controls">
            <button
              type="button"
              class="cos-link-btn"
              onClick={() => setLearningsSide(learningsDrawerStyle.side === 'left' ? 'right' : 'left')}
              title={`Move to ${learningsDrawerStyle.side === 'left' ? 'right' : 'left'}`}
              aria-label="Flip drawer side"
            >
              {learningsDrawerStyle.side === 'left' ? '→' : '←'}
            </button>
          </div>
          <LearningsPanel onClose={() => setShowLearnings(false)} />
        </div>
      )}

      {shouldRenderShell && activeAgent && inPane && showThreadPanel && threadDrawerStyle && (
        <div
          class={`cos-thread-side cos-thread-side-${threadDrawerStyle.side}`}
          style={{
            position: threadDrawerStyle.position,
            top: threadDrawerStyle.top,
            left: threadDrawerStyle.left,
            width: threadDrawerStyle.width,
            height: threadDrawerStyle.height,
            zIndex: threadDrawerStyle.zIndex,
          }}
        >
          <ThreadPanel
            agentId={activeAgent.id}
            showTools={showTools}
            verbosity={activeAgent.verbosity || DEFAULT_VERBOSITY}
            onArtifactPopout={handleArtifactPopout}
            onReply={handleReply}
            onClose={() => { setShowThreadPanel(false); cosActiveThread.value = null; }}
          />
        </div>
      )}

      {shouldRenderShell && activeAgent && (
        <div
          ref={wrapperRef}
          class={inPane
            ? 'cos-popout cos-pane'
            : `${isDocked ? `popout-docked${isLeftDocked ? ' docked-left' : ''}` : 'popout-floating'}${isMinimized ? ' minimized' : ''}${isCosFocused ? ' panel-focused' : ''}${isCosActive ? ' panel-active' : ''}${panel!.alwaysOnTop ? ' always-on-top' : ''} cos-popout`}
          style={inPane ? undefined : (panelStyle as any)}
          data-panel-id={COS_PANEL_ID}
          onMouseDown={inPane ? undefined : (() => {
            activePanelId.value = COS_PANEL_ID;
            bringToFront(COS_PANEL_ID);
            setFocusedLeaf(null);
          })}
        >
          <div class="popout-tab-bar" onMouseDown={inPane ? undefined : onHeaderDragStart}>
            <div class="popout-tab-scroll">
              <CosTabList
                agents={agents}
                activeId={activeId}
                showSettings={showSettings}
                onActivateAgent={(id) => {
                  chiefOfStaffActiveId.value = id;
                  setShowSettings(false);
                  if (!inPane) bringToFront(COS_PANEL_ID);
                }}
                onShowChat={() => setShowSettings(false)}
                setShowSettings={setShowSettings}
                appId={selectedAppId.value}
                newAgentName={newAgentName}
                setNewAgentName={setNewAgentName}
                onCommitNewAgent={commitNewAgent}
                inputRef={inputRef}
                isMobile={isMobile.value}
              />
            </div>
            {!inPane && panel && (
              <div class="popout-window-controls">
                <button
                  ref={menuButtonRef}
                  class="btn-close-panel cos-hamburger-draggable"
                  onClick={() => setMenuOpen((v) => !v)}
                  onMouseDown={(e) => {
                    // Drag-to-popout: if the user drags the hamburger >40px, open
                    // a standalone CoS window via ?embed=cos (chat-only, no admin
                    // chrome) so the popped-out window matches what the
                    // CosEmbedRoot renders. Click-only opens the menu instead.
                    const startX = (e as MouseEvent).clientX;
                    const startY = (e as MouseEvent).clientY;
                    let dragged = false;
                    const onMove = (ev: MouseEvent) => {
                      const dx = ev.clientX - startX;
                      const dy = ev.clientY - startY;
                      if (!dragged && Math.hypot(dx, dy) > 40) {
                        dragged = true;
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                        setMenuOpen(false);
                        // Decide window vs tab based on drop position: near screen
                        // edge → detached window, anywhere else → new tab.
                        const nearEdge =
                          ev.clientX < 20 ||
                          ev.clientX > window.innerWidth - 20 ||
                          ev.clientY < 20 ||
                          ev.clientY > window.innerHeight - 20;
                        openCosExternally(nearEdge ? 'new-window' : 'new-tab');
                      }
                    };
                    const onUp = () => {
                      document.removeEventListener('mousemove', onMove);
                      document.removeEventListener('mouseup', onUp);
                    };
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                  }}
                  title="Panel options (drag to pop out to new window/tab)"
                  aria-haspopup="true"
                  aria-expanded={menuOpen}
                >{'☰'}</button>
                <button class="btn-close-panel" onClick={toggleChiefOfStaff} title="Hide panel">&times;</button>
                {menuOpen && (
                  <WindowMenu
                    panel={panel}
                    activeId={COS_PANE_TAB_ID}
                    docked={isDocked}
                    isLeftDocked={isLeftDocked}
                    isMinimized={isMinimized}
                    anchorRef={menuButtonRef}
                    onClose={() => setMenuOpen(false)}
                  />
                )}
              </div>
            )}
          </div>

          {!isMinimized && (
            <div class="popout-body cos-popout-body">
              {showSettings ? (
                <CosAgentSettings
                  key={activeId}
                  activeAgent={activeAgent}
                  agentCount={agents.length}
                  onHistoryCleared={() => setCollapsedThreads(new Set())}
                />
              ) : ((() => {
                const mobileThreadActive = isMobile.value && showThreadPanel && !!cosActiveThread.value;
                const chatPane = (
                  <div class="cos-chat-pane">
                    {mobileThreadActive && (
                      <div class="cos-thread-inline">
                        <ThreadPanel
                          agentId={activeAgent.id}
                          showTools={showTools}
                          verbosity={activeAgent.verbosity || DEFAULT_VERBOSITY}
                          onArtifactPopout={handleArtifactPopout}
                          onReply={handleReply}
                          onClose={() => {
                            setShowThreadPanel(false);
                            cosActiveThread.value = null;
                            setReplyTo(null);
                          }}
                          compact
                        />
                      </div>
                    )}
                    <CosScrollToolbar
                      hasMessages={activeAgent.messages.length > 0}
                      hasMultipleThreads={hasMultipleThreads}
                      anyExpanded={anyExpanded}
                      hiddenThreadCount={hiddenThreadCount}
                      showTools={showTools}
                      setShowTools={setShowTools}
                      toggleAllThreads={toggleAllThreads}
                      searchOpen={searchOpen}
                      setSearchOpen={setSearchOpen}
                      searchQuery={searchQuery}
                      setSearchQuery={setSearchQuery}
                      searchMatchPos={searchMatchPos}
                      setSearchMatchPos={setSearchMatchPos}
                      searchMatchCount={searchMatches.length}
                      searchRole={searchRole}
                      setSearchRole={setSearchRole}
                      searchScope={searchScope}
                      setSearchScope={setSearchScope}
                      searchInputRef={searchInputRef}
                      gotoSearchMatch={gotoSearchMatch}
                      inPane={inPane}
                      showLearnings={showLearnings}
                      setShowLearnings={setShowLearnings}
                      learningsButtonActive={learningsButtonActive}
                      optionsMenuOpen={optionsMenuOpen}
                      setOptionsMenuOpen={setOptionsMenuOpen}
                      optionsMenuRef={optionsMenuRef}
                      slackMode={slackMode}
                      showResolved={showResolved}
                      showArchived={showArchived}
                    />

                    <div class="cos-scroll-wrap">
                    {hasMultipleThreads && (
                      <CosThreadRail
                        threads={visibleThreads}
                        unreadByThread={unreadByThread}
                        threadAnchorIdx={threadAnchorIdx}
                        threadTitle={threadTitle}
                        threadServerIdFor={threadServerIdFor}
                        railStatusFor={railStatusFor}
                        onJumpToThread={jumpToThread}
                      />
                    )}
                    <div class="cos-scroll-col">
                    <div class="cos-scroll" ref={setScrollEl}>
                      {activeAgent.messages.length === 0 && (
                        <div class="cos-empty">
                          <div class="cos-empty-title">{activeAgent.name}</div>
                          <div class="cos-empty-hint">
                            Ready. Ask about feedback, sessions, or infra — or tell me to dispatch something.
                          </div>
                          <div class="cos-empty-examples">
                            {[
                              "What's new in the queue?",
                              'Any sessions stuck or running long?',
                              'Are all launchers online?',
                            ].map((q) => (
                              <button key={q} class="cos-example" onClick={() => applyInput(q)}>{q}</button>
                            ))}
                          </div>
                        </div>
                      )}
                      {(() => {
                        const nodes: import('preact').VNode[] = [];
                        let lastDayKey: string | null = null;
                        visibleThreads.forEach((t, i) => {
                          const ts = t.userMsg?.timestamp ?? t.replies[0]?.msg.timestamp ?? null;
                          if (ts) {
                            const k = dayKeyOf(ts);
                            if (k !== lastDayKey) {
                              nodes.push(<DayDivider key={`day-${k}-${i}`} ts={ts} />);
                              lastDayKey = k;
                            }
                          }
                          const tKey = threadKeyOf(t);
                          const isActiveInPanel =
                            slackMode &&
                            cosActiveThread.value?.agentId === activeAgent.id &&
                            cosActiveThread.value?.threadKey === tKey;
                          nodes.push(
                            <ThreadBlock
                              key={t.userIdx ?? `pre-${i}`}
                              thread={t}
                              collapsed={t.userIdx !== null && collapsedThreads.has(t.userIdx)}
                              onToggle={() => t.userIdx !== null && toggleThread(t.userIdx)}
                              onStop={() => void interruptActiveAgent()}
                              showTools={showTools}
                              highlightMsgIdx={highlightMsgIdx}
                              onReply={handleReply}
                              onArtifactPopout={handleArtifactPopout}
                              hasUnread={!!unreadByThread.get(t.userIdx)}
                              agentId={activeAgent.id}
                              agentName={activeAgent.name}
                              verbosity={activeAgent.verbosity || DEFAULT_VERBOSITY}
                              searchHighlight={searchOpen && searchQuery.trim().length >= 2 ? searchQuery.trim() : null}
                              slackMode={slackMode}
                              isActiveInPanel={isActiveInPanel}
                              onOpenInPanel={() => {
                                cosActiveThread.value = { agentId: activeAgent.id, threadKey: tKey };
                                if (inPane || isMobile.value) {
                                  setShowThreadPanel(true);
                                  if (isMobile.value && t.userMsg?.text) {
                                    const tid = threadServerIdFor(t);
                                    handleReply('user', t.userMsg.text, t.userMsg.timestamp, tid);
                                  }
                                } else {
                                  cosOpenThreadTab('right');
                                }
                              }}
                            />
                          );
                        });
                        return nodes;
                      })()}
                      {error && (
                        <div class="cos-error">
                          <span>{error}</span>
                          <button
                            type="button"
                            class="cos-error-dismiss"
                            onClick={() => { chiefOfStaffError.value = null; }}
                            aria-label="Dismiss error"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                          </button>
                        </div>
                      )}
                    </div>

                    <div class="cos-floating-actions" aria-hidden={!showScrollDown}>
                      {showScrollDown && (
                        <button
                          type="button"
                          class={`cos-scroll-down-btn${replyNotifs.length > 0 ? ' cos-scroll-down-btn-unread' : ''}`}
                          onClick={() => scrollToBottom('auto')}
                          title={replyNotifs.length > 0 ? `${replyNotifs.length} new repl${replyNotifs.length === 1 ? 'y' : 'ies'} — scroll to latest` : 'Scroll to latest'}
                          aria-label="Scroll to latest message"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                          {replyNotifs.length > 0 && (
                            <span class="cos-scroll-down-badge" aria-hidden="true">{replyNotifs.length}</span>
                          )}
                        </button>
                      )}
                    </div>
                    </div>
                    </div>

                    {replyTo && (
                      <div class="cos-reply-pill" role="status">
                        <span class="cos-reply-pill-label">Replying to {replyTo.role}</span>
                        <span class="cos-reply-pill-text">{replyTo.text}</span>
                        {replyTo.threadServerId && input.length > 0 && (
                          <button
                            type="button"
                            class="cos-reply-pill-action"
                            onClick={saveReplyDraftClearInput}
                            title="Save this text as a draft for this thread, then start a clean new thread"
                            aria-label="Save draft"
                          >
                            Save draft
                          </button>
                        )}
                        <button
                          type="button"
                          class="cos-reply-pill-close"
                          onClick={closeReplyKeepText}
                          title={input.length > 0 ? 'Drop reply scope; text becomes a new-thread draft' : 'Clear reply'}
                          aria-label="Clear reply"
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
                            <path d="M6 6l12 12M18 6L6 18" />
                          </svg>
                        </button>
                      </div>
                    )}
                    <div class="cos-input-row">
                      <div
                        class="cos-resize-handle"
                        onMouseDown={onInputResizeHandleMouseDown}
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label="Resize input"
                        title="Drag to resize"
                      />
                      {(pendingAttachments.length > 0 || pendingElementRefs.length > 0) && (
                        <div class="cos-attach-strip">
                          {pendingAttachments.map((att) => (
                            <div class="cos-attach-thumb" key={att.id}>
                              <img
                                src={att.dataUrl}
                                alt={att.name || 'attachment'}
                                style="cursor:pointer"
                                title="Click to edit"
                                onClick={() => setEditingAttachment({ id: att.id, dataUrl: att.dataUrl })}
                              />
                              <button
                                type="button"
                                class="cos-attach-remove"
                                onClick={() => setPendingAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                                title="Remove attachment"
                                aria-label="Remove attachment"
                              >
                                &times;
                              </button>
                            </div>
                          ))}
                          {pendingElementRefs.map((ref, idx) => {
                            let display = ref.tagName || 'element';
                            if (ref.id) display += `#${ref.id}`;
                            const cls = (ref.classes || []).filter((c) => !c.startsWith('pw-')).slice(0, 2);
                            if (cls.length) display += '.' + cls.join('.');
                            return (
                              <div class="cos-element-chip" key={`ref-${idx}`} title={ref.selector}>
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                  <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
                                </svg>
                                <code>{display}</code>
                                <button
                                  type="button"
                                  class="cos-attach-remove"
                                  onClick={() => setPendingElementRefs((prev) => prev.filter((_, i) => i !== idx))}
                                  title="Remove element reference"
                                  aria-label="Remove element reference"
                                >
                                  &times;
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <textarea
                        ref={inputRef}
                        class="cos-input"
                        value={input}
                        placeholder={mobile ? `Message ${activeAgent.name}…` : `Message ${activeAgent.name}… (paste images to attach)`}
                        onInput={(e) => applyInput((e.target as HTMLTextAreaElement).value)}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        rows={1}
                        style={inputHeight !== null ? { height: inputHeight + 'px', maxHeight: 'none' } : undefined}
                      />
                      <CosInputToolbar
                        cameraGroupRef={cameraGroupRef}
                        pickerGroupRef={pickerGroupRef}
                        capturingScreenshot={capturingScreenshot}
                        captureAndAttachScreenshot={captureAndAttachScreenshot}
                        startTimedScreenshot={startTimedScreenshot}
                        cameraMenuOpen={cameraMenuOpen}
                        setCameraMenuOpen={setCameraMenuOpen}
                        cameraMenuPos={cameraMenuPos}
                        setCameraMenuPos={setCameraMenuPos}
                        screenshotExcludeWidget={screenshotExcludeWidget}
                        setScreenshotExcludeWidget={setScreenshotExcludeWidget}
                        screenshotExcludeCursor={screenshotExcludeCursor}
                        setScreenshotExcludeCursor={setScreenshotExcludeCursor}
                        screenshotMethod={screenshotMethod}
                        setScreenshotMethod={setScreenshotMethod}
                        screenshotKeepStream={screenshotKeepStream}
                        setScreenshotKeepStream={setScreenshotKeepStream}
                        pickerActive={pickerActive}
                        startElementPick={startElementPick}
                        pickerMenuOpen={pickerMenuOpen}
                        setPickerMenuOpen={setPickerMenuOpen}
                        pickerMenuPos={pickerMenuPos}
                        setPickerMenuPos={setPickerMenuPos}
                        pickerMultiSelect={pickerMultiSelect}
                        setPickerMultiSelect={setPickerMultiSelect}
                        pickerIncludeChildren={pickerIncludeChildren}
                        setPickerIncludeChildren={setPickerIncludeChildren}
                        micRecording={micRecording}
                        micElapsed={micElapsed}
                        micInterim={micInterim}
                        toggleMicRecord={toggleMicRecord}
                        canSend={!!input.trim() || pendingAttachments.length > 0 || pendingElementRefs.length > 0}
                        onSubmit={submit}
                      />
                    </div>
                  </div>
                );
                if (inPane) return chatPane;
                return (
                  <CosPopoutTreeView
                    tree={_cosTree}
                    chatContent={chatPane}
                    learningsContent={<LearningsPanel onClose={() => cosToggleLearningsTab('left')} />}
                    threadContent={
                      <ThreadPanel
                        agentId={activeAgent.id}
                        showTools={showTools}
                        verbosity={activeAgent.verbosity || DEFAULT_VERBOSITY}
                        onArtifactPopout={handleArtifactPopout}
                        onReply={handleReply}
                        onClose={() => { cosCloseThreadTab(); cosActiveThread.value = null; }}
                      />
                    }
                  />
                );
              })())}
            </div>
          )}

          {!inPane && !isMinimized && (
            <CosResizeHandles
              isDocked={isDocked}
              isLeftDocked={isLeftDocked}
              onResizeStart={onResizeStart}
            />
          )}
        </div>
      )}
      {editingAttachment && (
        <AttachmentEditorModal
          dataUrl={editingAttachment.dataUrl}
          onSave={(newDataUrl) => {
            setPendingAttachments((prev) =>
              prev.map((a) => a.id === editingAttachment!.id ? { ...a, dataUrl: newDataUrl } : a)
            );
            setEditingAttachment(null);
          }}
          onClose={() => setEditingAttachment(null)}
        />
      )}
    </>
  );
}

