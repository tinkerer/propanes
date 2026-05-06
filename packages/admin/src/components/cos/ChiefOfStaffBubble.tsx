import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import { selectedAppId } from '../../lib/state.js';
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
  reclampCosPanelToViewport,
  COS_PANE_TAB_ID,
  cosThreadMeta,
  getThreadMeta,
  setThreadResolved,
  setThreadArchived,
  leavingThreadIds,
  isThreadLeaving,
} from '../../lib/chief-of-staff.js';
import { MessageRenderer } from '../terminal/MessageRenderer.js';
import { layoutTree as layoutTreeSignal, findLeafWithTab, setFocusedLeaf } from '../../lib/pane-tree.js';
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
} from '../../lib/sessions.js';
import { handleDragMove, handleResizeMove } from '../../lib/popout-physics.js';
import { detectExternalZone, openCosExternally, applyExternalGhostHint } from '../../lib/tab-drag.js';
import { isMobile } from '../../lib/viewport.js';
import {
  registerCosArtifact,
  artifactIdFor,
  cosArtifacts,
} from '../../lib/cos-artifacts.js';
import { openArtifactCompanion, openUrlCompanion } from '../../lib/companion-state.js';
import { ArtifactCompanionView } from '../files/ArtifactCompanionView.js';
import { PopupMenu } from '../pickers/PopupMenu.js';
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
  cosThreadFilter,
  cosActiveThread,
  cosOpenThreadTab,
  cosCloseThreadTab,
  cosFocusTabId,
  buildCosFocusTree,
} from '../../lib/cos-popout-tree.js';
import {
  cosSavedDrafts,
  saveCosDraft,
  deleteCosDraft,
  getThreadSavedDrafts,
  getRootSavedDrafts,
  getThreadIdsWithDrafts,
  type CosSavedDraft,
} from '../../lib/cos-saved-drafts.js';
import { cosFollowups, enqueueCosFollowup } from '../../lib/cos-followups.js';
import { CosSavedDraftsList } from './CosSavedDraftsList.js';
import { CosEnqueuedList } from './CosEnqueuedList.js';
import { CosPopoutTreeView } from './CosPopoutTreeView.js';
import { cosOpenArtifactTab } from '../../lib/cos-popout-tree.js';
import { runSlashCommandIfAny, parseAgentMentions } from '../../lib/cos-slash-commands.js';
import { api } from '../../lib/api.js';
import { activeChannel } from '../../lib/state.js';
import { cosLearnings, loadCosLearnings } from '../../lib/cos-learnings.js';
import {
  cosDrafts,
  getCosDraft,
  setCosDraft,
  clearCosDraft,
  loadCosDrafts,
  hasAnyCosDraftForAgent,
} from '../../lib/cos-drafts.js';
import { extractCosReply, stripCosReplyMarkers } from '../../lib/cos-reply-tags.js';
import { useCosSearch } from '../../lib/use-cos-search.js';
import {
  fetchFeedbackTitle,
  getCachedFeedbackTitle,
  feedbackTitlesVersion,
} from '../../lib/cos-feedback-titles.js';
import { LearningsPanel } from '../learnings/LearningsDrawer.js';
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
import { CosComposer, type CosComposerHandle } from './CosComposer.js';
import { CosTabList } from './CosTabList.js';
import { CosResizeHandles } from './CosResizeHandles.js';
import {
  CosLearningsDrawer,
  CosThreadDrawer,
  CosArtifactDrawer,
  MIN_DRAWER_WIDTH,
  MAX_DRAWER_WIDTH,
  MIN_DRAWER_HEIGHT,
  TAB_WIDTH,
  type CosDrawerStyle,
  type DrawerMode,
} from './CosBubbleDrawers.js';
import { CosBubbleWindowControls } from './CosBubbleHeader.js';

marked.setOptions({ gfm: true, breaks: false });

function hasAnyArtifactLeaf(node: import('../../lib/pane-tree.js').PaneNode): boolean {
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
    // If CoS is already open but another floating panel was raised over it,
    // a click should raise CoS rather than hide it — otherwise the toggle
    // looks broken ("the panel won't come to the front"). Use real z-order
    // (not activePanelId, which can drift from the visual stack) so we only
    // collapse when CoS is genuinely the topmost visible panel.
    if (open && !paneOpen) {
      const cosPanel = popoutPanels.value.find((p) => p.id === COS_PANEL_ID);
      const cosZ = cosPanel ? getPanelZIndex(cosPanel) : 0;
      const topZ = popoutPanels.value
        .filter((p) => p.visible)
        .reduce((max, p) => Math.max(max, getPanelZIndex(p)), 0);
      if (cosZ < topZ) {
        activePanelId.value = COS_PANEL_ID;
        bringToFront(COS_PANEL_ID);
        return;
      }
    }
    // Toggling the panel from closed → open is also our chance to rescue
    // persisted geometry that no longer fits the viewport (window shrank
    // since the position was saved). Otherwise the panel renders fully
    // off-screen and the click looks like a no-op.
    if (!open && !paneOpen) reclampCosPanelToViewport();
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

  // Live mirror of CosComposer's internal text state. The composer owns
  // text state + draft persistence; the bubble only needs a read-only copy
  // to drive the reply-pill "Save draft" affordance and the
  // closeReplyKeepText / saveReplyDraftClearInput scope-swap helpers below.
  const [composerText, setComposerText] = useState<string>('');
  const composerRef = useRef<CosComposerHandle | null>(null);
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
  const threadFilter = cosThreadFilter.value;
  // Subscribe to the saved-drafts signal so the list re-renders when drafts
  // are saved/deleted/swapped from anywhere (including peer windows).
  const _savedDraftsTick = cosSavedDrafts.value;
  void _savedDraftsTick;
  // Same for the enqueued-followups signal — the inline pending-message list
  // needs to re-render on enqueue, edit, status flip, or auto-dispatch prune.
  const _followupsTick = cosFollowups.value;
  void _followupsTick;
  const [editingAttachment, setEditingAttachment] = useState<{ id: string; dataUrl: string } | null>(null);
  const [learningsSide, setLearningsSide] = useState<'left' | 'right'>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-learnings-side') : null;
    return v === 'right' ? 'right' : 'left';
  });
  const [threadSide, setThreadSide] = useState<'left' | 'right'>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-thread-side') : null;
    return v === 'left' ? 'left' : 'right';
  });
  const [learningsMode, setLearningsMode] = useState<DrawerMode>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-learnings-mode') : null;
    if (v === 'overlay' || v === 'split' || v === 'outside') return v;
    // Migration: legacy `pw-cos-learnings-inside` boolean → 'overlay' if 1.
    const legacy = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-learnings-inside') : null;
    return legacy === '1' ? 'overlay' : 'outside';
  });
  const [threadMode, setThreadMode] = useState<DrawerMode>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-thread-mode') : null;
    if (v === 'overlay' || v === 'split' || v === 'outside') return v;
    const legacy = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-thread-inside') : null;
    return legacy === '1' ? 'overlay' : 'outside';
  });
  const [learningsWidth, setLearningsWidth] = useState<number>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-learnings-width') : null;
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n >= MIN_DRAWER_WIDTH && n <= MAX_DRAWER_WIDTH ? n : 340;
  });
  const [threadWidth, setThreadWidth] = useState<number>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-thread-width') : null;
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n >= MIN_DRAWER_WIDTH && n <= MAX_DRAWER_WIDTH ? n : 380;
  });
  // Vertical state — `topOffset` is delta from shellRect.top (negative pushes
  // drawer above the pane); `heightOverride` is an explicit pixel height (null
  // means "match pane height"). Both flip to explicit values once the operator
  // drags an N/S resize handle, after which the drawer no longer auto-tracks
  // pane height changes.
  const [learningsTopOffset, setLearningsTopOffset] = useState<number>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-learnings-top-offset') : null;
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  });
  const [learningsHeightOverride, setLearningsHeightOverride] = useState<number | null>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-learnings-height') : null;
    if (v == null) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= MIN_DRAWER_HEIGHT ? n : null;
  });
  const [threadTopOffset, setThreadTopOffset] = useState<number>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-thread-top-offset') : null;
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  });
  const [threadHeightOverride, setThreadHeightOverride] = useState<number | null>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-thread-height') : null;
    if (v == null) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= MIN_DRAWER_HEIGHT ? n : null;
  });
  // Artifact drawer — opens when handleArtifactPopout fires in pane mode
  // instead of routing to the main-tree companion. Single-artifact slot:
  // clicking another artifact swaps the active id; clicking the same artifact
  // toggles the drawer closed.
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [artifactSide, setArtifactSide] = useState<'left' | 'right'>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-artifact-side') : null;
    return v === 'left' ? 'left' : 'right';
  });
  const [artifactMode, setArtifactMode] = useState<DrawerMode>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-artifact-mode') : null;
    if (v === 'overlay' || v === 'split' || v === 'outside') return v;
    return 'outside';
  });
  const [artifactWidth, setArtifactWidth] = useState<number>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-artifact-width') : null;
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n >= MIN_DRAWER_WIDTH && n <= MAX_DRAWER_WIDTH ? n : 480;
  });
  const [artifactTopOffset, setArtifactTopOffset] = useState<number>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-artifact-top-offset') : null;
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  });
  const [artifactHeightOverride, setArtifactHeightOverride] = useState<number | null>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-artifact-height') : null;
    if (v == null) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= MIN_DRAWER_HEIGHT ? n : null;
  });
  // Hamburger slide position (0..1) along the cos pane's edge for each
  // drawer. Persisted so the operator's preferred location sticks.
  const readPos = (key: string, def: number) => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    const n = v ? parseFloat(v) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : def;
  };
  const [learningsHamburgerPos, setLearningsHamburgerPosState] = useState<number>(() => readPos('pw-cos-learnings-ham-pos', 0.5));
  const [threadHamburgerPos, setThreadHamburgerPosState] = useState<number>(() => readPos('pw-cos-thread-ham-pos', 0.5));
  const [artifactHamburgerPos, setArtifactHamburgerPosState] = useState<number>(() => readPos('pw-cos-artifact-ham-pos', 0.5));
  const setLearningsHamburgerPos = useCallback((pos: number) => {
    setLearningsHamburgerPosState(pos);
    try { localStorage.setItem('pw-cos-learnings-ham-pos', String(pos)); } catch { /* ignore */ }
  }, []);
  const setThreadHamburgerPos = useCallback((pos: number) => {
    setThreadHamburgerPosState(pos);
    try { localStorage.setItem('pw-cos-thread-ham-pos', String(pos)); } catch { /* ignore */ }
  }, []);
  const setArtifactHamburgerPos = useCallback((pos: number) => {
    setArtifactHamburgerPosState(pos);
    try { localStorage.setItem('pw-cos-artifact-ham-pos', String(pos)); } catch { /* ignore */ }
  }, []);
  // Live refs for the clamping math inside the resize callbacks. The
  // mousemove handler runs at ~60Hz; reading from refs keeps the callback
  // stable (no re-bind on every state change) and always uses fresh values.
  const learningsSideRef = useRef(learningsSide);
  const threadSideRef = useRef(threadSide);
  const learningsModeRef = useRef(learningsMode);
  const threadModeRef = useRef(threadMode);
  useEffect(() => { learningsSideRef.current = learningsSide; }, [learningsSide]);
  useEffect(() => { threadSideRef.current = threadSide; }, [threadSide]);
  useEffect(() => { learningsModeRef.current = learningsMode; }, [learningsMode]);
  useEffect(() => { threadModeRef.current = threadMode; }, [threadMode]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-thread-side', threadSide); } catch { /* ignore */ }
  }, [threadSide]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-learnings-mode', learningsMode); } catch { /* ignore */ }
  }, [learningsMode]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-thread-mode', threadMode); } catch { /* ignore */ }
  }, [threadMode]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-learnings-width', String(learningsWidth)); } catch { /* ignore */ }
  }, [learningsWidth]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-thread-width', String(threadWidth)); } catch { /* ignore */ }
  }, [threadWidth]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-learnings-top-offset', String(learningsTopOffset)); } catch { /* ignore */ }
  }, [learningsTopOffset]);
  useEffect(() => {
    try {
      if (learningsHeightOverride == null) localStorage.removeItem('pw-cos-learnings-height');
      else localStorage.setItem('pw-cos-learnings-height', String(learningsHeightOverride));
    } catch { /* ignore */ }
  }, [learningsHeightOverride]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-thread-top-offset', String(threadTopOffset)); } catch { /* ignore */ }
  }, [threadTopOffset]);
  useEffect(() => {
    try {
      if (threadHeightOverride == null) localStorage.removeItem('pw-cos-thread-height');
      else localStorage.setItem('pw-cos-thread-height', String(threadHeightOverride));
    } catch { /* ignore */ }
  }, [threadHeightOverride]);
  // Max width depends on side+mode+the live shellRect. Outside-mode is capped
  // to the viewport gap on the chosen side so the drawer never tries to spill
  // past the edge (used to trigger an auto-flip jump mid-drag). Overlay/split
  // are capped to pane width.
  function clampWidth(px: number, side: 'left' | 'right', mode: DrawerMode): number {
    const rect = shellRectRef.current;
    if (!rect) return Math.max(MIN_DRAWER_WIDTH, Math.min(MAX_DRAWER_WIDTH, px));
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
    let max: number;
    if (mode === 'outside') {
      max = side === 'right'
        ? Math.max(MIN_DRAWER_WIDTH, vw - (rect.left + rect.width))
        : Math.max(MIN_DRAWER_WIDTH, rect.left);
    } else {
      max = Math.max(MIN_DRAWER_WIDTH, rect.width);
    }
    return Math.max(MIN_DRAWER_WIDTH, Math.min(Math.min(MAX_DRAWER_WIDTH, max), px));
  }
  const setLearningsWidthClamped = useCallback((px: number) => {
    setLearningsWidth(clampWidth(px, learningsSideRef.current, learningsModeRef.current));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setThreadWidthClamped = useCallback((px: number) => {
    setThreadWidth(clampWidth(px, threadSideRef.current, threadModeRef.current));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Vertical resize: the handle passes us the absolute (top, height) it wants
  // post-drag; we clamp to viewport bounds and convert back to (offset,
  // override) for state. Mirrors the horizontal `setWidth` pattern.
  const setLearningsBounds = useCallback((top: number, height: number) => {
    const rect = shellRectRef.current;
    if (!rect) return;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
    const h = Math.max(MIN_DRAWER_HEIGHT, Math.min(vh - 4, height));
    const t = Math.max(0, Math.min(vh - h, top));
    setLearningsTopOffset(t - rect.top);
    setLearningsHeightOverride(h);
  }, []);
  const setThreadBounds = useCallback((top: number, height: number) => {
    const rect = shellRectRef.current;
    if (!rect) return;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
    const h = Math.max(MIN_DRAWER_HEIGHT, Math.min(vh - 4, height));
    const t = Math.max(0, Math.min(vh - h, top));
    setThreadTopOffset(t - rect.top);
    setThreadHeightOverride(h);
  }, []);
  // Cycle mode: outside → overlay → split → outside.
  const cycleMode = (m: DrawerMode): DrawerMode =>
    m === 'outside' ? 'overlay' : m === 'overlay' ? 'split' : 'outside';
  const artifactSideRef = useRef(artifactSide);
  const artifactModeRef = useRef(artifactMode);
  useEffect(() => { artifactSideRef.current = artifactSide; }, [artifactSide]);
  useEffect(() => { artifactModeRef.current = artifactMode; }, [artifactMode]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-artifact-side', artifactSide); } catch { /* ignore */ }
  }, [artifactSide]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-artifact-mode', artifactMode); } catch { /* ignore */ }
  }, [artifactMode]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-artifact-width', String(artifactWidth)); } catch { /* ignore */ }
  }, [artifactWidth]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-artifact-top-offset', String(artifactTopOffset)); } catch { /* ignore */ }
  }, [artifactTopOffset]);
  useEffect(() => {
    try {
      if (artifactHeightOverride == null) localStorage.removeItem('pw-cos-artifact-height');
      else localStorage.setItem('pw-cos-artifact-height', String(artifactHeightOverride));
    } catch { /* ignore */ }
  }, [artifactHeightOverride]);
  const setArtifactWidthClamped = useCallback((px: number) => {
    setArtifactWidth(clampWidth(px, artifactSideRef.current, artifactModeRef.current));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setArtifactBounds = useCallback((top: number, height: number) => {
    const rect = shellRectRef.current;
    if (!rect) return;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
    const h = Math.max(MIN_DRAWER_HEIGHT, Math.min(vh - 4, height));
    const t = Math.max(0, Math.min(vh - h, top));
    setArtifactTopOffset(t - rect.top);
    setArtifactHeightOverride(h);
  }, []);
  const [shellRect, setShellRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const shellRectRef = useRef<{ top: number; left: number; width: number; height: number } | null>(null);
  useEffect(() => { shellRectRef.current = shellRect; }, [shellRect]);
  const [inputHeight, setInputHeight] = useState<number | null>(null);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-show-tools', showTools ? '1' : '0'); } catch { /* ignore */ }
  }, [showTools]);
  // No auto-close when slackMode flips off — the thread companion is now
  // reachable in both modes via the inline Reply button. setCosSlackMode(false)
  // still explicitly clears cosActiveThread / closes the popout-tree tab when
  // the operator opts out, which is the right place for that decision.
  useEffect(() => {
    try { localStorage.setItem('pw-cos-learnings-side', learningsSide); } catch { /* ignore */ }
  }, [learningsSide]);
  useEffect(() => {
    if (!showLearnings && !showThreadPanel && !activeArtifactId) { setShellRect(null); return; }
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
  }, [showLearnings, showThreadPanel, activeArtifactId, inPane]);

  const [newAgentName, setNewAgentName] = useState<string | null>(null);

  // The active draft scope is (agent, app, threadId-or-empty). When the
  // operator is in "reply to thread" mode (replyTo set) this resolves to that
  // thread's server id; otherwise '' meaning the new-thread compose draft.
  // CosComposer drives all read/write/clear traffic through `draftBinding`
  // below, keyed off this scope.
  const draftScopeThreadId = replyTo?.threadServerId ?? '';
  // Subscribe to cosDrafts so binding identity bumps whenever the underlying
  // store changes — covers example-chip clicks (which write directly to the
  // store) and any peer-window updates. Keystrokes also bounce through this,
  // which CosComposer's prev-binding ref handles without looping.
  const cosDraftsTick = cosDrafts.value;
  const draftBinding = useMemo(
    () => ({
      read: () => getCosDraft(activeId, selectedAppId.value, draftScopeThreadId),
      write: (text: string) => setCosDraft(activeId, selectedAppId.value, draftScopeThreadId, text),
      clear: () => clearCosDraft(activeId, selectedAppId.value, draftScopeThreadId),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeId, selectedAppId.value, draftScopeThreadId, cosDraftsTick],
  );
  // Pull all drafts for the current app on mount and whenever the operator
  // switches app scope. Per-(agent, thread) values land in the cosDrafts
  // signal and CosComposer's draft binding picks them up via the tick above.
  useEffect(() => {
    void loadCosDrafts(selectedAppId.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAppId.value]);

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
  const threads = useMemo(
    () => groupIntoThreads(activeAgent?.messages || []),
    [activeAgent?.messages],
  );
  // Thread keys whose user message or any reply matches the active search
  // query. Threads in this set bypass the archived/resolved/draft visibility
  // filters so a hit inside an otherwise-hidden thread can never get swallowed
  // by the chip filters — the operator searched for it, they want to see it.
  const searchedThreadKeys = useMemo(() => {
    if (searchMatches.length === 0) return null;
    const matchSet = new Set(searchMatches);
    const out = new Set<string>();
    for (const t of threads) {
      const hit =
        (t.userIdx !== null && matchSet.has(t.userIdx)) ||
        t.replies.some((r) => matchSet.has(r.idx));
      if (hit) out.add(threadKeyOf(t));
    }
    return out;
  }, [threads, searchMatches]);
  const collapsibleThreads = threads.filter((t) => t.userIdx !== null);
  const anyExpanded = collapsibleThreads.some((t) => !collapsedThreads.has(t.userIdx!));
  const isAgentStreaming = (activeAgent?.messages || []).some((m) => m.streaming);
  // Read the per-thread meta signal so the rail re-renders when an operator
  // toggles `resolved` or the server pushes a new sessionStatus on hydrate.
  const _threadMetaVersion = cosThreadMeta.value;
  void _threadMetaVersion;
  // Subscribe to leavingThreadIds so the visibility filter re-runs when a
  // thread starts (or finishes) animating out. Without this read the Set
  // change wouldn't trigger a re-render of the bubble.
  const _leavingVersion = leavingThreadIds.value;
  void _leavingVersion;

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
    // Active streaming = a reply is being typed *right now*. The per-message
    // streaming flag is authoritative; sessionStatus alone is misleading
    // because headless-stream bridges stay status='running' for their entire
    // lifetime, even between turns.
    if (t.replies.some((r) => r.msg.streaming)) return 'streaming';
    if (unreadByThread.get(t.userIdx)) return 'unread';
    const s = meta?.sessionStatus;
    if (s === 'failed' || s === 'killed') return 'failed';
    if (s === null || s === undefined) return 'gc';
    if (s === 'running' || s === 'pending') {
      // A running session that's an interactive TTY ("Open as interactive
      // panel" was clicked) gets a distinct dot color so the operator can
      // see at a glance which threads are live driveable terminals vs
      // headless background turns.
      const profile = meta?.sessionPermissionProfile;
      if (profile === 'interactive-yolo' || profile === 'interactive-require') {
        return 'interactive';
      }
      return 'streaming';
    }
    // Agent finished a turn and the operator hasn't resolved it yet — the
    // reply is sitting awaiting triage. Distinct from 'idle' (no reply yet
    // / nothing to look at) and from 'unread' (louder, blinking).
    const lastReply = t.replies[t.replies.length - 1];
    if (lastReply && lastReply.msg.role === 'assistant') return 'attention';
    return 'idle';
  }

  const draftThreadIds = useMemo(
    () => getThreadIdsWithDrafts(activeId, selectedAppId.value),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeId, selectedAppId.value, _savedDraftsTick],
  );
  // Apply visibility filters to the thread list. The exclusive `threadFilter`
  // mode (drafts-only / archived-only) overrides the include-toggles when set.
  // Threads without a server id (still pending hydration) always show in the
  // default mode — they can't have meta.
  function isThreadVisible(t: Thread): boolean {
    const tid = threadServerIdFor(t);
    // Keep threads currently animating out mounted regardless of meta — the
    // CSS collapse transition needs the row in the DOM until it finishes.
    if (tid && isThreadLeaving(tid)) return true;
    // Search overrides chip filters: if the operator searched and a hit
    // landed in this thread, show it even if archived/resolved/non-draft.
    if (searchedThreadKeys && searchedThreadKeys.has(threadKeyOf(t))) return true;
    if (threadFilter === 'archived') {
      if (!tid) return false;
      const meta = getThreadMeta(tid);
      return !!meta?.archivedAt;
    }
    if (threadFilter === 'drafts') {
      if (!tid) return false;
      return draftThreadIds.has(tid);
    }
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

  // CosComposer's onSend callback. The composer has already trimmed text,
  // packaged attachments + element refs, cleared its internal state, and
  // cleared the active draft scope by the time this fires; the bubble only
  // attaches replyToTs from its own pill state and dispatches.
  async function handleSend(
    text: string,
    attachments: CosImageAttachment[],
    elementRefs: CosElementRef[],
  ): Promise<void> {
    if (!text.trim() && attachments.length === 0 && elementRefs.length === 0) return;
    // Slash commands: intercept locally, never send to the model.
    if (text.trim().startsWith('/') && attachments.length === 0 && elementRefs.length === 0) {
      const result = await runSlashCommandIfAny(text);
      if (result.handled) {
        if (result.error) chiefOfStaffError.value = result.error;
        else if (result.toast) chiefOfStaffError.value = result.toast;
        return;
      }
    }
    // @-mention auto-dispatch. Additive — the chat message still goes to the
    // model so the operator's CoS thread stays coherent. Each mentioned agent
    // gets a fire-and-forget /admin/dispatch with the message text as
    // instructions; channel policy (if any active channel) gates the call
    // server-side. Resolution requires both a linked feedback item and the
    // agentEndpoints listing — skip silently if either is missing instead of
    // bouncing the operator out of the chat send flow.
    const mentions = parseAgentMentions(text);
    if (mentions.length > 0) {
      void (async () => {
        try {
          const tid = cosActiveThread.value?.threadKey?.startsWith('tid:')
            ? cosActiveThread.value.threadKey.slice(4)
            : null;
          let feedbackId: string | null = null;
          if (tid) {
            const qs = selectedAppId.value ? `?appId=${encodeURIComponent(selectedAppId.value)}` : '';
            const token = localStorage.getItem('pw-admin-token');
            const headers: Record<string, string> = {};
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const res = await fetch(`/api/v1/admin/chief-of-staff/threads${qs}`, { headers });
            if (res.ok) {
              const data = await res.json();
              const found = (data?.threads || []).find((t: { id: string }) => t.id === tid);
              feedbackId = found?.feedbackId ?? null;
            }
          }
          if (!feedbackId) return;
          const allAgents = await api.getAgents(selectedAppId.value || undefined);
          const channelId = activeChannel.value?.id ?? null;
          const dispatched: string[] = [];
          for (const m of mentions) {
            const agent = allAgents.find((a: any) => {
              if (a.id === m.slug) return true;
              if (typeof a.name === 'string') {
                if (a.name.toLowerCase() === m.slug.toLowerCase()) return true;
                if (a.name.toLowerCase().replace(/\s+/g, '-') === m.slug.toLowerCase()) return true;
              }
              return false;
            });
            if (!agent) continue;
            try {
              const res = await api.dispatch({
                feedbackId,
                agentEndpointId: agent.id,
                instructions: text,
                channelId,
              });
              if (res?.dispatched !== false) dispatched.push(agent.name || agent.id);
            } catch { /* per-mention failure is non-fatal */ }
          }
          if (dispatched.length > 0) {
            chiefOfStaffError.value = `Auto-dispatched: ${dispatched.join(', ')}`;
          }
        } catch { /* swallow — chat send proceeds independently */ }
      })();
    }
    const replyToTs = replyTo?.anchorTs;
    setReplyTo(null);
    return sendChiefOfStaffMessage(text, selectedAppId.value, { attachments, elementRefs, replyToTs });
  }

  // CosComposer's onSaveDraft callback. Stash the payload as a saved draft
  // attached to the active scope (current reply-pill thread, or root). The
  // composer has already cleared its internal state by the time this fires.
  function handleSaveAsDraft(
    text: string,
    attachments: CosImageAttachment[],
    elementRefs: CosElementRef[],
  ) {
    if (!text.trim() && attachments.length === 0 && elementRefs.length === 0) return;
    saveCosDraft({
      agentId: activeId,
      appId: selectedAppId.value,
      threadId: replyTo?.threadServerId ?? '',
      replyToTs: replyTo?.anchorTs,
      text,
      attachments,
      elementRefs,
    });
    // Drop the reply pill so the next compose starts a fresh top-level thread
    // — matches the "I stashed this, moving on" mental model.
    setReplyTo(null);
  }

  // Click handler for a saved-draft row: stash the composer's current state
  // (if any) as a new draft pinned to the current scope, then load the clicked
  // draft into the composer. This is the "swap" the operator expects.
  function handleLoadSavedDraft(draft: CosSavedDraft) {
    const snap = composerRef.current?.getSnapshot();
    const hasText = !!snap?.text.trim();
    const hasAtts = (snap?.attachments?.length ?? 0) > 0;
    const hasRefs = (snap?.elementRefs?.length ?? 0) > 0;
    if (snap && (hasText || hasAtts || hasRefs)) {
      saveCosDraft({
        agentId: activeId,
        appId: selectedAppId.value,
        threadId: replyTo?.threadServerId ?? '',
        replyToTs: replyTo?.anchorTs,
        text: snap.text,
        attachments: snap.attachments,
        elementRefs: snap.elementRefs,
      });
    }
    deleteCosDraft(draft.id);
    // Pull reply scope onto the loaded draft's thread so the next send routes
    // back to the right anchor. If the draft was top-level, drop reply scope.
    if (draft.threadId && typeof draft.replyToTs === 'number') {
      const anchor = activeAgent?.messages.find(
        (m) => m.role === 'user' && m.timestamp === draft.replyToTs,
      );
      const excerpt = anchor?.text
        ? (anchor.text.length > 120 ? anchor.text.slice(0, 120) : anchor.text)
        : '';
      setReplyTo({
        role: 'user',
        text: excerpt,
        anchorTs: draft.replyToTs,
        threadServerId: draft.threadId,
      });
    } else {
      setReplyTo(null);
    }
    composerRef.current?.loadSnapshot({
      text: draft.text,
      attachments: draft.attachments,
      elementRefs: draft.elementRefs,
    });
  }

  // Reply-pill "Close" button: drop the in-thread scope but keep the operator's
  // text — it now becomes the agent's new-thread compose draft. Implemented by
  // copying the current text into the new-thread scope before clearing the
  // thread-scoped row; the cosDrafts signal tick rebuilds CosComposer's
  // binding identity and re-hydrates from the new scope so the textarea
  // shows the same text under the new key.
  function closeReplyKeepText() {
    const text = composerText;
    if (replyTo?.threadServerId && text.length > 0) {
      setCosDraft(activeId, selectedAppId.value, '', text);
      clearCosDraft(activeId, selectedAppId.value, replyTo.threadServerId);
    }
    setReplyTo(null);
  }

  // Reply-pill "Save draft" button: thread scope already has the live text
  // (composer's continuous draft.write keeps it current). Just drop reply
  // scope; CosComposer's binding-identity bump re-hydrates from the new-
  // thread scope, matching the original's setInput('') + scope-drop flow
  // where the box reflected whatever new-thread draft existed.
  function saveReplyDraftClearInput() {
    if (replyTo?.threadServerId && composerText.length === 0) {
      clearCosDraft(activeId, selectedAppId.value, replyTo.threadServerId);
    }
    setReplyTo(null);
  }

  function handleReply(role: string, text: string, anchorTs?: number, threadServerId?: string | null) {
    const excerpt = text.length > 120 ? text.slice(0, 120) : text;
    setReplyTo({ role, text: excerpt, anchorTs, threadServerId: threadServerId ?? null });
    if (!isMobile.value) inputRef.current?.focus();
  }

  function handleArtifactPopout(artifactId: string) {
    // In pane mode artifacts open as a *drawer* attached to the cos pane —
    // matching the thread/learnings drawer surface so the operator can
    // resize/dock it the same way. Toggle off if the same artifact is
    // already showing; otherwise swap the active id.
    if (inPane) {
      setActiveArtifactId((prev) => (prev === artifactId ? null : artifactId));
      return;
    }
    // Popout mode: open the artifact as a first-class tab in the cos popout
    // tree. ChiefOfStaffBubble's chat scroll is preserved across leaf
    // re-mounts via lastScrollTopRef (see scroll-restore effect below).
    const wasEmpty = !hasAnyArtifactLeaf(cosPopoutTree.value.root);
    cosOpenArtifactTab(artifactId);
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
  // In focus-mode (popped-out single-tab window), substitute a synthetic
  // single-leaf tree so the popped window renders just the focused tab
  // fullscreen rather than mirroring the parent's persisted multi-pane layout.
  const _focusTabId = cosFocusTabId.value;
  const _cosTree = _focusTabId ? buildCosFocusTree(_focusTabId) : cosPopoutTree.value;
  // In popout mode the learnings panel is a tab in the popout-local tree, so
  // the toolbar button's "open" state is derived from the tree — not from the
  // local `showLearnings` state (which only drives the pane-mode side drawer).
  const learningsPopoutOpen = !inPane && cosIsLearningsOpen();
  const learningsButtonActive = inPane ? showLearnings : learningsPopoutOpen;

  const shouldRenderShell = inPane
    ? !!activeAgent
    : !!(open && activeAgent && panel && panel.visible && !hasCosTabInTree);

  // overlay/split: drawer occupies a slot inside the pane bounds (split also
  // pushes cos content over via padding so it doesn't sit *under* the
  // drawer). outside: drawer is adjacent to the pane on the chosen side.
  // We only flip sides if the chosen side has *zero* room left — relaxing
  // the old "flip if desired width doesn't fit" rule that caused jumpy
  // mid-drag flips.
  function placeDrawer(
    desiredSide: 'left' | 'right',
    desiredWidth: number,
    mode: DrawerMode,
    rect: { top: number; left: number; width: number; height: number },
  ): { side: 'left' | 'right'; width: number; left: number } {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
    if (mode !== 'outside') {
      const width = Math.min(desiredWidth, Math.max(MIN_DRAWER_WIDTH, rect.width));
      const left = desiredSide === 'left' ? rect.left : rect.left + rect.width - width;
      return { side: desiredSide, width, left };
    }
    const leftRoom = Math.max(0, rect.left);
    const rightRoom = Math.max(0, vw - (rect.left + rect.width));
    let side: 'left' | 'right' = desiredSide;
    if (side === 'left' && leftRoom < MIN_DRAWER_WIDTH && rightRoom >= MIN_DRAWER_WIDTH) side = 'right';
    if (side === 'right' && rightRoom < MIN_DRAWER_WIDTH && leftRoom >= MIN_DRAWER_WIDTH) side = 'left';
    const room = side === 'left' ? leftRoom : rightRoom;
    const width = Math.max(MIN_DRAWER_WIDTH, Math.min(desiredWidth, Math.max(MIN_DRAWER_WIDTH, room)));
    const left = side === 'left' ? rect.left - width : rect.left + rect.width;
    return { side, width, left };
  }

  // Compute drawer top+height from the live pane rect plus the operator's
  // vertical resize state. heightOverride=null means "auto-track pane height";
  // any explicit drag flips it to a pixel value.
  function placeVertical(rect: { top: number; height: number }, topOffset: number, heightOverride: number | null) {
    const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
    const h = Math.max(MIN_DRAWER_HEIGHT, Math.min(vh - 4, heightOverride ?? rect.height));
    const t = Math.max(0, Math.min(vh - h, rect.top + topOffset));
    return { top: t, height: h };
  }

  let learningsDrawerStyle: CosDrawerStyle | null = null;
  if (showLearnings && shellRect) {
    const placed = placeDrawer(learningsSide, learningsWidth, learningsMode, shellRect);
    const v = placeVertical(shellRect, learningsTopOffset, learningsHeightOverride);
    const zIdx = !inPane && panel ? getPanelZIndex(panel) + 1 : 900;
    learningsDrawerStyle = {
      position: 'fixed',
      top: v.top,
      height: v.height,
      left: placed.left,
      width: placed.width,
      zIndex: zIdx,
      side: placed.side,
      mode: learningsMode,
    };
  }

  let threadDrawerStyle: CosDrawerStyle | null = null;
  if (showThreadPanel && shellRect) {
    // If learnings is open on the same side and outside, prefer the opposite
    // side for the thread drawer so they don't stack on each other.
    let desiredSide: 'left' | 'right' = threadSide;
    if (
      learningsDrawerStyle &&
      learningsDrawerStyle.mode === 'outside' &&
      threadMode === 'outside' &&
      learningsDrawerStyle.side === desiredSide
    ) {
      desiredSide = desiredSide === 'left' ? 'right' : 'left';
    }
    const placed = placeDrawer(desiredSide, threadWidth, threadMode, shellRect);
    const v = placeVertical(shellRect, threadTopOffset, threadHeightOverride);
    const zIdx = !inPane && panel ? getPanelZIndex(panel) + 1 : 900;
    threadDrawerStyle = {
      position: 'fixed',
      top: v.top,
      height: v.height,
      left: placed.left,
      width: placed.width,
      zIndex: zIdx,
      side: placed.side,
      mode: threadMode,
    };
  }

  let artifactDrawerStyle: CosDrawerStyle | null = null;
  if (activeArtifactId && inPane && shellRect) {
    // Artifacts are companions of the *thread*, not the pane — when the
    // thread drawer is open in outside mode, the artifact anchors to
    // thread's outer edge (one column further out). Otherwise it anchors to
    // the cos pane like any other drawer. Vertical extent matches thread
    // when present so the two read as a stacked column.
    const anchor = (threadDrawerStyle && threadDrawerStyle.mode === 'outside')
      ? threadDrawerStyle
      : null;
    let placed: { side: 'left' | 'right'; width: number; left: number };
    let v: { top: number; height: number };
    if (anchor) {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
      const side = anchor.side;
      // Available room past the thread drawer's outer edge:
      //   side='right': from anchor.right to viewport right
      //   side='left':  from 0 to anchor.left
      const room = side === 'right' ? Math.max(0, vw - (anchor.left + anchor.width)) : Math.max(0, anchor.left);
      const width = Math.max(MIN_DRAWER_WIDTH, Math.min(artifactWidth, Math.max(MIN_DRAWER_WIDTH, room)));
      const left = side === 'right' ? anchor.left + anchor.width : anchor.left - width;
      placed = { side, width, left };
      v = { top: anchor.top, height: anchor.height };
    } else {
      // Prefer the side opposite any drawer already on `artifactSide` to
      // keep them from overlapping when both are outside.
      let desiredSide: 'left' | 'right' = artifactSide;
      if (artifactMode === 'outside') {
        const occupied = [learningsDrawerStyle, threadDrawerStyle].filter(
          (d) => d && d.mode === 'outside' && d.side === desiredSide,
        );
        if (occupied.length > 0) desiredSide = desiredSide === 'left' ? 'right' : 'left';
      }
      placed = placeDrawer(desiredSide, artifactWidth, artifactMode, shellRect);
      v = placeVertical(shellRect, artifactTopOffset, artifactHeightOverride);
    }
    const zIdx = !inPane && panel ? getPanelZIndex(panel) + 2 : 901;
    artifactDrawerStyle = {
      position: 'fixed',
      top: v.top,
      height: v.height,
      left: placed.left,
      width: placed.width,
      zIndex: zIdx,
      side: placed.side,
      mode: anchor ? 'outside' : artifactMode,
    };
  }

  // Split-mode drawers reserve horizontal space inside the cos-pane so the
  // chat content doesn't render *under* the drawer. Sum widths-per-side of
  // every drawer in `split` mode and apply as padding.
  let splitPadLeft = 0;
  let splitPadRight = 0;
  for (const ds of [learningsDrawerStyle, threadDrawerStyle, artifactDrawerStyle]) {
    if (!ds || ds.mode !== 'split') continue;
    const slot = ds.width + TAB_WIDTH;
    if (ds.side === 'left') splitPadLeft = Math.max(splitPadLeft, slot);
    else splitPadRight = Math.max(splitPadRight, slot);
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

      {shouldRenderShell && activeAgent && inPane && showLearnings && learningsDrawerStyle && shellRect && (
        <CosLearningsDrawer
          style={learningsDrawerStyle}
          paneRect={shellRect}
          hamburgerPos={learningsHamburgerPos}
          setHamburgerPos={setLearningsHamburgerPos}
          setLearningsSide={setLearningsSide}
          setLearningsMode={(m) => setLearningsMode(m)}
          cycleLearningsMode={() => setLearningsMode(cycleMode(learningsMode))}
          setLearningsWidthClamped={setLearningsWidthClamped}
          setLearningsBounds={setLearningsBounds}
          onClose={() => setShowLearnings(false)}
        />
      )}

      {shouldRenderShell && activeAgent && inPane && showThreadPanel && threadDrawerStyle && shellRect && (
        <CosThreadDrawer
          style={threadDrawerStyle}
          agentId={activeAgent.id}
          showTools={showTools}
          verbosity={activeAgent.verbosity || DEFAULT_VERBOSITY}
          paneRect={shellRect}
          hamburgerPos={threadHamburgerPos}
          setHamburgerPos={setThreadHamburgerPos}
          onArtifactPopout={handleArtifactPopout}
          onReply={handleReply}
          onClose={() => setShowThreadPanel(false)}
          setThreadSide={setThreadSide}
          setThreadMode={(m) => setThreadMode(m)}
          cycleThreadMode={() => setThreadMode(cycleMode(threadMode))}
          setThreadWidthClamped={setThreadWidthClamped}
          setThreadBounds={setThreadBounds}
        />
      )}

      {shouldRenderShell && activeAgent && inPane && activeArtifactId && artifactDrawerStyle && shellRect && (
        <CosArtifactDrawer
          style={artifactDrawerStyle}
          artifactId={activeArtifactId}
          paneRect={shellRect}
          hamburgerPos={artifactHamburgerPos}
          setHamburgerPos={setArtifactHamburgerPos}
          setArtifactSide={setArtifactSide}
          cycleArtifactMode={() => setArtifactMode(cycleMode(artifactMode))}
          setArtifactWidthClamped={setArtifactWidthClamped}
          setArtifactBounds={setArtifactBounds}
          onClose={() => setActiveArtifactId(null)}
        />
      )}

      {shouldRenderShell && activeAgent && (
        <div
          ref={wrapperRef}
          class={inPane
            ? `cos-popout cos-pane${(splitPadLeft || splitPadRight) ? ' cos-pane-split' : ''}`
            : `${isDocked ? `popout-docked${isLeftDocked ? ' docked-left' : ''}` : 'popout-floating'}${isMinimized ? ' minimized' : ''}${isCosFocused ? ' panel-focused' : ''}${isCosActive ? ' panel-active' : ''}${panel!.alwaysOnTop ? ' always-on-top' : ''} cos-popout`}
          style={inPane
            ? (splitPadLeft || splitPadRight)
              ? ({ '--cos-split-pad-left': `${splitPadLeft}px`, '--cos-split-pad-right': `${splitPadRight}px` } as any)
              : undefined
            : (panelStyle as any)}
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
              <CosBubbleWindowControls
                panel={panel}
                isDocked={isDocked}
                isLeftDocked={isLeftDocked}
                isMinimized={isMinimized}
                menuOpen={menuOpen}
                setMenuOpen={setMenuOpen}
                menuButtonRef={menuButtonRef}
                onClosePanel={toggleChiefOfStaff}
              />
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
                      threadFilter={threadFilter}
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
                              <button
                                key={q}
                                class="cos-example"
                                onClick={() => setCosDraft(activeId, selectedAppId.value, draftScopeThreadId, q)}
                              >{q}</button>
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
                          // Render any saved drafts attached to this thread
                          // immediately after its block. In slack mode the
                          // ThreadPanel hosts its own copy of this list, so
                          // skip inline rendering for collapsed threads.
                          const tid = threadServerIdFor(t);
                          if (tid && !(slackMode && t.userMsg && t.replies.length > 0)) {
                            const threadDrafts = getThreadSavedDrafts(activeAgent.id, selectedAppId.value, tid);
                            if (threadDrafts.length > 0) {
                              nodes.push(
                                <CosSavedDraftsList
                                  key={`drafts-${tid}`}
                                  drafts={threadDrafts}
                                  onLoad={handleLoadSavedDraft}
                                  onDelete={(d) => { deleteCosDraft(d.id); }}
                                  scope="thread"
                                />,
                              );
                            }
                            const threadFollowups = cosFollowups.value.filter(
                              (f) => f.agentId === activeAgent.id && f.threadServerId === tid,
                            );
                            if (threadFollowups.length > 0) {
                              nodes.push(
                                <CosEnqueuedList
                                  key={`followups-${tid}`}
                                  followups={threadFollowups}
                                  scope="thread"
                                />,
                              );
                            }
                          }
                        });
                        // Top-level drafts (composed without a reply pill)
                        // render at the bottom of the chat stream so the
                        // operator sees their pending new-thread sends.
                        const rootDrafts = getRootSavedDrafts(activeAgent.id, selectedAppId.value);
                        if (rootDrafts.length > 0) {
                          nodes.push(
                            <CosSavedDraftsList
                              key="drafts-root"
                              drafts={rootDrafts}
                              onLoad={handleLoadSavedDraft}
                              onDelete={(d) => { deleteCosDraft(d.id); }}
                              scope="root"
                            />,
                          );
                        }
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
                        {replyTo.threadServerId && composerText.length > 0 && (
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
                          title={composerText.length > 0 ? 'Drop reply scope; text becomes a new-thread draft' : 'Clear reply'}
                          aria-label="Clear reply"
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
                            <path d="M6 6l12 12M18 6L6 18" />
                          </svg>
                        </button>
                      </div>
                    )}
                    {/* Pending lists rendered right above the composer so the
                        operator gets immediate visual feedback after enqueue /
                        save-draft actions — in slack mode the inline-below-
                        thread copies are suppressed for non-empty threads,
                        leaving this as the only on-bubble surface that shows
                        them. Always renders if the agent has any queued items
                        (regardless of whether a reply pill is set), so a
                        top-level "send when current finishes" still gives the
                        operator a visible row to confirm the enqueue. */}
                    {(() => {
                      const tid = replyTo?.threadServerId ?? null;
                      const drafts = tid
                        ? getThreadSavedDrafts(activeAgent.id, selectedAppId.value, tid)
                        : [];
                      const followups = cosFollowups.value.filter(
                        (f) => f.agentId === activeAgent.id
                          && (tid ? f.threadServerId === tid : true),
                      );
                      if (drafts.length === 0 && followups.length === 0) return null;
                      return (
                        <div class="cos-composer-pending">
                          {drafts.length > 0 && (
                            <CosSavedDraftsList
                              drafts={drafts}
                              onLoad={handleLoadSavedDraft}
                              onDelete={(d) => { deleteCosDraft(d.id); }}
                              scope="thread"
                            />
                          )}
                          {followups.length > 0 && (
                            <CosEnqueuedList followups={followups} scope="thread" />
                          )}
                        </div>
                      );
                    })()}
                    <CosComposer
                      ref={composerRef}
                      className="cos-input-row"
                      placeholder={mobile ? `Message ${activeAgent.name}…` : `Message ${activeAgent.name}… (paste images to attach)`}
                      draft={draftBinding}
                      onSend={handleSend}
                      onSaveDraft={handleSaveAsDraft}
                      onTextChange={setComposerText}
                      onEscape={() => {
                        if (replyTo) { setReplyTo(null); return true; }
                        return false;
                      }}
                      textareaRef={inputRef}
                      autoGrow={inputHeight === null ? { maxPx: 240 } : undefined}
                      inputStyle={inputHeight !== null ? { height: inputHeight + 'px', maxHeight: 'none' } : undefined}
                      onAttachmentClick={(id, dataUrl) => setEditingAttachment({ id, dataUrl })}
                      rows={1}
                      streaming={(() => {
                        // Stop only makes sense when scoped to a specific
                        // thread — top-level sends spawn fresh threads, so a
                        // composer-level Stop with no reply pill would
                        // interrupt some unrelated in-flight thread. Limit
                        // streaming/onStop to the active reply target.
                        const tid = replyTo?.threadServerId;
                        if (!tid) return false;
                        return activeAgent.messages.some((m) => m.threadId === tid && m.streaming);
                      })()}
                      onStop={replyTo?.threadServerId ? () => {
                        void interruptThread(replyTo.threadServerId!);
                      } : undefined}
                      onEnqueueAfterCurrent={(text, attachments, elementRefs) => {
                        // Pick a thread to scope the followup to:
                        //   1. Active reply pill — operator's explicit target.
                        //   2. Any thread with a streaming message — the
                        //      "current" turn the queued item should follow.
                        //   3. Most recent thread the agent has — keeps
                        //      grouping consistent with the conversation.
                        // If none of those exist (fresh agent), enqueue with
                        // a synthetic key — the dispatcher will fire it
                        // immediately as a top-level send (replyToTs is unset
                        // so sendChiefOfStaffMessage spawns a new thread).
                        const streamingMsg = activeAgent.messages
                          .slice()
                          .reverse()
                          .find((m) => m.streaming && m.threadId);
                        const recentThreadMsg = activeAgent.messages
                          .slice()
                          .reverse()
                          .find((m) => m.threadId);
                        const tid = replyTo?.threadServerId
                          ?? streamingMsg?.threadId
                          ?? recentThreadMsg?.threadId
                          ?? `__pending:${activeId}`;
                        enqueueCosFollowup({
                          agentId: activeId,
                          appId: selectedAppId.value,
                          threadServerId: tid,
                          replyToTs: replyTo?.anchorTs,
                          text,
                          attachments,
                          elementRefs,
                        });
                      }}
                      onSendAndInterrupt={(() => {
                        const tid = replyTo?.threadServerId
                          ?? (activeAgent.messages.slice().reverse().find((m) => m.streaming)?.threadId);
                        if (!tid) return undefined;
                        return async (text: string, attachments: CosImageAttachment[], elementRefs: CosElementRef[]) => {
                          const replyToTs = replyTo?.anchorTs;
                          setReplyTo(null);
                          await interruptThread(tid);
                          await sendChiefOfStaffMessage(text, selectedAppId.value, { attachments, elementRefs, replyToTs });
                        };
                      })()}
                      fanOutAgents={chiefOfStaffAgents.value.map((a) => ({ id: a.id, name: a.name, current: a.id === activeId }))}
                      onSaveDraftToAgents={(agentIds, text, attachments, elementRefs) => {
                        for (const aid of agentIds) {
                          saveCosDraft({
                            agentId: aid,
                            appId: selectedAppId.value,
                            threadId: replyTo?.threadServerId ?? '',
                            replyToTs: replyTo?.anchorTs,
                            text,
                            attachments,
                            elementRefs,
                          });
                        }
                        // Also save for the current agent (the main "Save draft"
                        // path normally handles it, but the fan-out flow bypasses
                        // saveDraft → so do it here for symmetry).
                        saveCosDraft({
                          agentId: activeId,
                          appId: selectedAppId.value,
                          threadId: replyTo?.threadServerId ?? '',
                          replyToTs: replyTo?.anchorTs,
                          text,
                          attachments,
                          elementRefs,
                        });
                        setReplyTo(null);
                      }}
                      prefix={
                        <div
                          class="cos-resize-handle"
                          onMouseDown={onInputResizeHandleMouseDown}
                          role="separator"
                          aria-orientation="horizontal"
                          aria-label="Resize input"
                          title="Drag to resize"
                        />
                      }
                    />
                  </div>
                );
                // Focus mode (popped-out single-tab window) ignores inPane —
                // we want CosPopoutTreeView with the synthetic single-leaf tree
                // even when CoS embed mode would normally render in pane mode.
                if (inPane && !_focusTabId) return chatPane;
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
            composerRef.current?.updateAttachmentDataUrl(editingAttachment!.id, newDataUrl);
            setEditingAttachment(null);
          }}
          onClose={() => setEditingAttachment(null)}
        />
      )}
    </>
  );
}

