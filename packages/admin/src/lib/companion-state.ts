import { signal } from '@preact/signals';
import { api } from './api.js';
import {
  openTabs,
  activeTabId,
  splitEnabled,
  rightPaneTabs,
  rightPaneActiveId,
  disableSplit,
  openSessionInRightPane,
  persistSplitState,
  persistTabs,
  loadJson,
} from './session-state.js';
import {
  findLeaf,
  findLeafWithTab,
  findCompanionSibling,
  addTabToLeaf,
  removeTabFromLeaf,
  splitLeaf,
  splitLeafAtPosition,
  focusedLeafId,
  showSessionsLeaf,
  ensureSessionsLeaf,
  setActiveTab,
  setFocusedLeaf,
  layoutTree,
  batch as batchTreeOps,
  PAGE_LEAF_ID,
  type PanePosition,
} from './pane-tree.js';

// --- Companion Types ---

export type CompanionType = 'jsonl' | 'feedback' | 'iframe' | 'terminal' | 'isolate' | 'url' | 'file' | 'wiggum-runs' | 'artifact';

// --- Terminal Companion Map ---

export const terminalCompanionMap = signal<Record<string, string>>(
  loadJson('pw-terminal-companion-map', {})
);

function persistTerminalCompanionMap() {
  localStorage.setItem('pw-terminal-companion-map', JSON.stringify(terminalCompanionMap.value));
}

export function getTerminalCompanion(sessionId: string): string | undefined {
  return terminalCompanionMap.value[sessionId];
}

export function setTerminalCompanion(parentSessionId: string, termSessionId: string) {
  terminalCompanionMap.value = { ...terminalCompanionMap.value, [parentSessionId]: termSessionId };
  persistTerminalCompanionMap();
}

export function setTerminalCompanionAndOpen(parentSessionId: string, termSessionId: string) {
  setTerminalCompanion(parentSessionId, termSessionId);
  const current = getCompanions(parentSessionId);
  if (!current.includes('terminal')) {
    sessionCompanions.value = { ...sessionCompanions.value, [parentSessionId]: [...current, 'terminal'] };
    persistCompanions();
  }
  openSessionInRightPane(companionTabId(parentSessionId, 'terminal'));
  if (activeTabId.value !== parentSessionId) {
    activeTabId.value = parentSessionId;
    persistTabs();
  }
}

export function removeTerminalCompanion(sessionId: string) {
  const { [sessionId]: _, ...rest } = terminalCompanionMap.value;
  terminalCompanionMap.value = rest;
  persistTerminalCompanionMap();
}

// --- Session Companions ---

export const sessionCompanions = signal<Record<string, CompanionType[]>>(
  loadJson('pw-session-companions', {})
);

const rightPaneMemory = new Map<string, { tabs: string[]; activeId: string | null }>();

export function companionTabId(sessionId: string, type: CompanionType): string {
  return `${type}:${sessionId}`;
}

export function extractSessionFromTab(tabId: string): string | null {
  const idx = tabId.indexOf(':');
  if (idx < 0) return null;
  return tabId.slice(idx + 1);
}

export function extractCompanionType(tabId: string): CompanionType | null {
  const idx = tabId.indexOf(':');
  if (idx < 0) return null;
  const prefix = tabId.slice(0, idx);
  if (prefix === 'jsonl' || prefix === 'feedback' || prefix === 'iframe' || prefix === 'terminal' || prefix === 'isolate' || prefix === 'url' || prefix === 'file' || prefix === 'wiggum-runs' || prefix === 'artifact') return prefix as CompanionType;
  return null;
}

export function getCompanions(sessionId: string): CompanionType[] {
  return sessionCompanions.value[sessionId] || [];
}

export function persistCompanions() {
  localStorage.setItem('pw-session-companions', JSON.stringify(sessionCompanions.value));
}

export function toggleCompanion(sessionId: string, type: CompanionType, position?: PanePosition) {
  const current = getCompanions(sessionId);
  const tabId = companionTabId(sessionId, type);

  const existingLeaf = findLeafWithTab(tabId);
  const isVisibleInTree = !!existingLeaf;

  if (current.includes(type) && isVisibleInTree) {
    // Toggle OFF
    const next = current.filter((t) => t !== type);
    if (next.length === 0) {
      const { [sessionId]: _, ...rest } = sessionCompanions.value;
      sessionCompanions.value = rest;
    } else {
      sessionCompanions.value = { ...sessionCompanions.value, [sessionId]: next };
    }
    persistCompanions();

    if (type === 'terminal') {
      removeTerminalCompanion(sessionId);
    }

    removeTabFromLeaf(existingLeaf.id, tabId);

    if (rightPaneTabs.value.includes(tabId)) {
      const remaining = rightPaneTabs.value.filter((id) => id !== tabId);
      rightPaneTabs.value = remaining;
      if (rightPaneActiveId.value === tabId) {
        rightPaneActiveId.value = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      }
      if (remaining.length === 0 && splitEnabled.value) {
        disableSplit();
        return;
      }
      persistSplitState();
    }
    if (openTabs.value.includes(tabId)) {
      openTabs.value = openTabs.value.filter((id) => id !== tabId);
      persistTabs();
    }
  } else {
    // Toggle ON
    if (!current.includes(type)) {
      sessionCompanions.value = { ...sessionCompanions.value, [sessionId]: [...current, type] };
      persistCompanions();
    }

    const sessionLeaf = findLeafWithTab(sessionId);
    if (sessionLeaf) {
      // If caller asked for a specific position, always split there — don't
      // reuse a sibling, since that would put the new pane in the existing
      // direction rather than the requested one.
      if (position) {
        splitLeafAtPosition(sessionLeaf.id, position, [tabId], 0.5);
      } else {
        const sibling = findCompanionSibling(sessionLeaf.id, sessionId);
        if (sibling) {
          addTabToLeaf(sibling.id, tabId, true);
        } else {
          splitLeaf(sessionLeaf.id, 'horizontal', 'second', [tabId], 0.5);
        }
      }
    } else {
      const leafId = ensureSessionsLeaf();
      addTabToLeaf(leafId, tabId, true);
    }

    openSessionInRightPane(tabId);
  }
}

// --- Companion Openers ---

export function openIsolateCompanion(componentName: string, position?: PanePosition) {
  const tabId = `isolate:${componentName}`;
  if (!openTabs.value.includes(tabId)) {
    openTabs.value = [...openTabs.value, tabId];
  }
  openSessionInRightPane(tabId);

  const focused = focusedLeafId.value;
  const focusedLeaf = focused ? findLeaf(layoutTree.value.root, focused) : null;
  if (focusedLeaf && focusedLeaf.panelType === 'tabs' && focusedLeaf.tabs.length > 0) {
    if (position) splitLeafAtPosition(focusedLeaf.id, position, [tabId], 0.5);
    else splitLeaf(focusedLeaf.id, 'horizontal', 'second', [tabId], 0.5);
  } else {
    batchTreeOps(() => {
      const leafId = ensureSessionsLeaf();
      addTabToLeaf(leafId, tabId, true);
      showSessionsLeaf();
    });
  }
}

export function openUrlCompanion(url: string, position?: PanePosition) {
  let normalized = url.trim();
  if (normalized && !/^https?:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  const tabId = `url:${normalized}`;
  if (!openTabs.value.includes(tabId)) {
    openTabs.value = [...openTabs.value, tabId];
  }
  openSessionInRightPane(tabId);

  const focused = focusedLeafId.value;
  const focusedLeaf = focused ? findLeaf(layoutTree.value.root, focused) : null;
  if (focusedLeaf && focusedLeaf.panelType === 'tabs' && focusedLeaf.tabs.length > 0) {
    if (position) splitLeafAtPosition(focusedLeaf.id, position, [tabId], 0.5);
    else splitLeaf(focusedLeaf.id, 'horizontal', 'second', [tabId], 0.5);
  } else {
    batchTreeOps(() => {
      const leafId = ensureSessionsLeaf();
      addTabToLeaf(leafId, tabId, true);
      showSessionsLeaf();
    });
  }
}

export function openArtifactCompanion(artifactId: string, position?: PanePosition) {
  const tabId = `artifact:${artifactId}`;

  // Toggle off if already open
  const existingLeaf = findLeafWithTab(tabId);
  if (existingLeaf) {
    removeTabFromLeaf(existingLeaf.id, tabId);
    if (openTabs.value.includes(tabId)) {
      openTabs.value = openTabs.value.filter((id) => id !== tabId);
      persistTabs();
    }
    if (rightPaneTabs.value.includes(tabId)) {
      const remaining = rightPaneTabs.value.filter((id) => id !== tabId);
      rightPaneTabs.value = remaining;
      if (rightPaneActiveId.value === tabId) {
        rightPaneActiveId.value = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      }
      if (remaining.length === 0 && splitEnabled.value) {
        disableSplit();
      } else {
        persistSplitState();
      }
    }
    return;
  }

  if (!openTabs.value.includes(tabId)) {
    openTabs.value = [...openTabs.value, tabId];
  }
  openSessionInRightPane(tabId);

  const focused = focusedLeafId.value;
  const focusedLeaf = focused ? findLeaf(layoutTree.value.root, focused) : null;
  if (focusedLeaf && focusedLeaf.panelType === 'tabs' && focusedLeaf.tabs.length > 0) {
    if (position) splitLeafAtPosition(focusedLeaf.id, position, [tabId], 0.5);
    else splitLeaf(focusedLeaf.id, 'horizontal', 'second', [tabId], 0.5);
  } else {
    batchTreeOps(() => {
      const leafId = ensureSessionsLeaf();
      addTabToLeaf(leafId, tabId, true);
      showSessionsLeaf();
    });
  }
}

export function openFileCompanion(filePath: string, position?: PanePosition) {
  const tabId = `file:${filePath}`;
  if (!openTabs.value.includes(tabId)) {
    openTabs.value = [...openTabs.value, tabId];
  }
  if (position) {
    const focused = focusedLeafId.value;
    const focusedLeaf = focused ? findLeaf(layoutTree.value.root, focused) : null;
    if (focusedLeaf && focusedLeaf.panelType === 'tabs' && focusedLeaf.tabs.length > 0) {
      splitLeafAtPosition(focusedLeaf.id, position, [tabId], 0.5);
      return;
    }
  }
  batchTreeOps(() => {
    const leafId = ensureSessionsLeaf();
    addTabToLeaf(leafId, tabId, true);
    showSessionsLeaf();
  });
}

// --- Settings Panel Tabs ---

const settingsLabelMap: Record<string, string> = {
  agents: 'Agents',
  infrastructure: 'Infrastructure',
  'user-guide': 'User Guide',
  'getting-started': 'Getting Started',
  preferences: 'Preferences',
};

export function getSettingsLabel(key: string): string {
  return settingsLabelMap[key] || key;
}

export function openPageView(viewId: string) {
  const existingLeaf = findLeafWithTab(viewId);
  if (existingLeaf) {
    setActiveTab(existingLeaf.id, viewId);
    setFocusedLeaf(existingLeaf.id);
    return;
  }
  // Try the canonical page leaf first; fall back to whichever leaf holds view:feedback
  const pageLeaf = findLeafWithTab('view:feedback') || findLeafWithTab('view:page');
  const targetLeafId = pageLeaf?.id || PAGE_LEAF_ID;
  addTabToLeaf(targetLeafId, viewId, true);
  setFocusedLeaf(targetLeafId);
}

export function openSettingsPanel(settingsKey: string) {
  const tabId = `settings:${settingsKey}`;

  const existingLeaf = findLeafWithTab(tabId);
  if (existingLeaf) {
    setActiveTab(existingLeaf.id, tabId);
    setFocusedLeaf(existingLeaf.id);
    return;
  }

  if (!openTabs.value.includes(tabId)) {
    openTabs.value = [...openTabs.value, tabId];
  }
  persistTabs();

  batchTreeOps(() => {
    const leafId = ensureSessionsLeaf();
    addTabToLeaf(leafId, tabId, true);
    showSessionsLeaf();
  });
}

// --- Feedback Item Tabs ---

export const feedbackTitleCache = signal<Record<string, string>>({});

export function openFeedbackItem(feedbackId: string) {
  const tabId = `fb:${feedbackId}`;

  const existingLeaf = findLeafWithTab(tabId);
  if (existingLeaf) {
    setActiveTab(existingLeaf.id, tabId);
    setFocusedLeaf(existingLeaf.id);
    showSessionsLeaf();
    return;
  }

  if (!openTabs.value.includes(tabId)) {
    openTabs.value = [...openTabs.value, tabId];
  }
  persistTabs();

  batchTreeOps(() => {
    const leafId = ensureSessionsLeaf();
    addTabToLeaf(leafId, tabId, true);
    showSessionsLeaf();
  });

  if (!feedbackTitleCache.value[feedbackId]) {
    api.getFeedbackById(feedbackId).then((fb: any) => {
      if (fb?.title) {
        feedbackTitleCache.value = { ...feedbackTitleCache.value, [feedbackId]: fb.title };
      }
    }).catch(() => {});
  }
}

// --- Companion Sync ---

export function syncCompanionsToRightPane(newSessionId: string, oldSessionId?: string | null) {
  if (extractCompanionType(newSessionId)) return;

  if (oldSessionId && !extractCompanionType(oldSessionId)) {
    rightPaneMemory.set(oldSessionId, {
      tabs: [...rightPaneTabs.value],
      activeId: rightPaneActiveId.value,
    });
  }

  const companions = getCompanions(newSessionId);
  const memory = rightPaneMemory.get(newSessionId);

  if (memory) {
    rightPaneTabs.value = memory.tabs;
    rightPaneActiveId.value = memory.activeId;
    if (memory.tabs.length > 0) {
      if (!splitEnabled.value) splitEnabled.value = true;
    } else if (splitEnabled.value) {
      splitEnabled.value = false;
    }
    for (const tab of memory.tabs) {
      if (!openTabs.value.includes(tab)) {
        openTabs.value = [...openTabs.value, tab];
      }
    }
    persistSplitState();
    persistTabs();
    return;
  }

  if (companions.length > 0) {
    const companionTabs = companions.map((type) => companionTabId(newSessionId, type));
    for (const tab of companionTabs) {
      if (!openTabs.value.includes(tab)) {
        openTabs.value = [...openTabs.value, tab];
      }
    }
    rightPaneTabs.value = companionTabs;
    rightPaneActiveId.value = companionTabs[0];
    if (!splitEnabled.value) splitEnabled.value = true;
    persistSplitState();
    persistTabs();
  }
  if (splitEnabled.value) {
    const allCompanion = rightPaneTabs.value.every((t) => extractCompanionType(t) !== null);
    if (allCompanion) {
      const companionSet = new Set(rightPaneTabs.value);
      openTabs.value = openTabs.value.filter((t) => !companionSet.has(t));
      rightPaneTabs.value = [];
      rightPaneActiveId.value = null;
      splitEnabled.value = false;
      persistSplitState();
      persistTabs();
    }
  }
}

// --- JSONL File Selection ---

export interface JsonlFileInfo {
  id: string;
  claudeSessionId: string;
  type: 'main' | 'continuation' | 'subagent';
  label: string;
  parentSessionId: string | null;
  agentId: string | null;
  order: number;
}

export const jsonlFilesCache = signal<Map<string, { files: JsonlFileInfo[]; claudeSessionId: string }>>(new Map());
export const jsonlSelectedFile = signal<Map<string, string | null>>(new Map());
export const jsonlDropdownOpen = signal<string | null>(null);

export async function fetchJsonlFiles(sessionId: string, force = false): Promise<{ files: JsonlFileInfo[]; claudeSessionId: string }> {
  if (!force) {
    const cached = jsonlFilesCache.value.get(sessionId);
    if (cached) return cached;
  }
  const result = await api.getJsonlFiles(sessionId);
  const entry = { files: result.files, claudeSessionId: result.claudeSessionId };
  jsonlFilesCache.value = new Map([...jsonlFilesCache.value, [sessionId, entry]]);
  return entry;
}

export function getJsonlSelectedFile(sessionId: string): string | null {
  return jsonlSelectedFile.value.get(sessionId) ?? null;
}

export function setJsonlSelectedFile(sessionId: string, fileId: string | null) {
  const next = new Map(jsonlSelectedFile.value);
  if (fileId === null) {
    next.delete(sessionId);
  } else {
    next.set(sessionId, fileId);
  }
  jsonlSelectedFile.value = next;
}
