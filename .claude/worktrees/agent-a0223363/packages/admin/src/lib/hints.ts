import { signal, effect } from '@preact/signals';

export interface Hint {
  id: string;
  route: string | RegExp;
  title: string;
  body: string;
  priority: number;
  highlightSelector?: string;
  guideLink?: string;
}

function loadSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export const hintsEnabled = signal<boolean>(loadSetting('pw-hints-enabled', true));
export const dismissedHints = signal<string[]>(loadSetting('pw-dismissed-hints', []));

effect(() => {
  localStorage.setItem('pw-hints-enabled', JSON.stringify(hintsEnabled.value));
});

effect(() => {
  localStorage.setItem('pw-dismissed-hints', JSON.stringify(dismissedHints.value));
});

export function dismissHint(id: string) {
  if (!dismissedHints.value.includes(id)) {
    dismissedHints.value = [...dismissedHints.value, id];
  }
}

export function resetAllHints() {
  dismissedHints.value = [];
}

export function getHintsForRoute(route: string): Hint[] {
  if (!hintsEnabled.value) return [];
  const dismissed = new Set(dismissedHints.value);
  return HINTS
    .filter((h) => {
      if (dismissed.has(h.id)) return false;
      if (typeof h.route === 'string') {
        if (h.route === '*') return true;
        return route.startsWith(h.route);
      }
      return h.route.test(route);
    })
    .sort((a, b) => b.priority - a.priority);
}

export const HINTS: Hint[] = [
  // Global
  {
    id: 'keyboard-shortcuts',
    route: '*',
    title: 'Keyboard shortcuts',
    body: 'Press ? to see all keyboard shortcuts available on this page.',
    priority: 100,
    guideLink: '#keyboard-shortcuts',
  },
  {
    id: 'spotlight-search',
    route: '*',
    title: 'Spotlight search',
    body: 'Press Cmd+K to search across apps, feedback, and sessions instantly.',
    priority: 90,
    guideLink: '#spotlight-search',
  },
  {
    id: 'ctrl-shift-nav',
    route: '*',
    title: 'Quick navigation',
    body: 'Use Ctrl+Shift+Arrow to cycle between pages. Hold Ctrl+Shift to see quick actions on tabs.',
    priority: 80,
    guideLink: '#navigation',
  },

  // Feedback pages
  {
    id: 'feedback-dispatch',
    route: /^\/app\/[^/]+\/feedback$/,
    title: 'Quick dispatch',
    body: 'Click the play button on any feedback item to dispatch it to an agent immediately.',
    priority: 70,
    highlightSelector: '.btn-dispatch-quick',
    guideLink: '#feedback-workflow',
  },
  {
    id: 'feedback-batch',
    route: /^\/app\/[^/]+\/feedback$/,
    title: 'Batch actions',
    body: 'Select multiple feedback items with checkboxes, then use batch actions in the toolbar.',
    priority: 60,
    guideLink: '#feedback-workflow',
  },
  {
    id: 'feedback-filters',
    route: /^\/app\/[^/]+\/feedback$/,
    title: 'Filter feedback',
    body: 'Use the filter bar at the top to narrow feedback by status, type, or tags.',
    priority: 50,
    guideLink: '#feedback-workflow',
  },

  // Feedback detail
  {
    id: 'feedback-detail-dispatch',
    route: /^\/app\/[^/]+\/feedback\/.+/,
    title: 'Dispatch from detail',
    body: 'Click "Dispatch to Agent" to create a session that works on this specific feedback item.',
    priority: 70,
    guideLink: '#feedback-workflow',
  },

  // Aggregate
  {
    id: 'aggregate-clusters',
    route: /^\/app\/[^/]+\/aggregate$/,
    title: 'Aggregate clusters',
    body: 'Aggregate clusters group similar feedback items automatically. Click a cluster to see its members.',
    priority: 70,
    guideLink: '#aggregate',
  },

  // Sessions
  {
    id: 'sessions-page',
    route: /^\/app\/[^/]+\/sessions$/,
    title: 'Session management',
    body: 'Sessions show agent work history. Click a session to view its terminal output and conversation log.',
    priority: 60,
    guideLink: '#agent-sessions',
  },

  // Live connections
  {
    id: 'live-connections',
    route: /^\/app\/[^/]+\/live$/,
    title: 'Live connections',
    body: 'Live connections show all browsers with the widget active. Expand a row to see recent commands.',
    priority: 70,
    guideLink: '#live-connections',
  },

  // Machines
  {
    id: 'machines-admin-assist',
    route: '/settings/machines',
    title: 'Admin Assist',
    body: 'Click the wrench icon to auto-provision a machine with SSH, install dependencies, and configure launchers.',
    priority: 80,
    highlightSelector: '.btn-admin-assist',
    guideLink: '#machines',
  },
  {
    id: 'machines-add',
    route: '/settings/machines',
    title: 'Add a machine',
    body: 'Register remote compute nodes to run agent sessions. Machines need a launcher daemon to accept work.',
    priority: 60,
    guideLink: '#machines',
  },

  // Harnesses
  {
    id: 'harnesses-overview',
    route: '/settings/harnesses',
    title: 'Harnesses',
    body: 'Harness configs define Docker Compose stacks for isolated agent testing environments.',
    priority: 70,
    guideLink: '#harnesses',
  },
  {
    id: 'harnesses-admin-assist',
    route: '/settings/harnesses',
    title: 'Admin Assist for harnesses',
    body: 'Admin Assist can deploy launchers, configure Docker, and set up Claude auth on remote machines.',
    priority: 65,
    highlightSelector: '.btn-admin-assist',
    guideLink: '#harnesses',
  },

  // Agents
  {
    id: 'agents-config',
    route: '/settings/agents',
    title: 'Agent endpoints',
    body: 'Configure agent endpoints with custom prompts, models, and harness configs for different workflows.',
    priority: 70,
    guideLink: '#agents',
  },

  // Sprites
  {
    id: 'sprites-overview',
    route: '/settings/sprites',
    title: 'Sprites',
    body: 'Sprites are persistent agent personas. Assign sprites to sessions for consistent behavior across runs.',
    priority: 60,
    guideLink: '#sprites',
  },

  // Preferences
  {
    id: 'preferences-overview',
    route: '/settings/preferences',
    title: 'Customize your experience',
    body: 'Configure theme, keyboard shortcuts, terminal behavior, panel presets, and guided tours.',
    priority: 50,
    guideLink: '#tips',
  },

  // Terminal panel
  {
    id: 'terminal-companions',
    route: '*',
    title: 'Companion tabs',
    body: 'Click the session ID in the pane header to open companion views: JSONL conversation log, iframe preview, or terminal.',
    priority: 55,
    guideLink: '#companions',
  },
  {
    id: 'terminal-split',
    route: '*',
    title: 'Split pane',
    body: 'Click the session ID in the pane header and choose "Split Panes" to view two sessions side by side.',
    priority: 45,
    guideLink: '#terminal',
  },

  // Getting started
  {
    id: 'getting-started',
    route: '/settings/getting-started',
    title: 'First steps',
    body: 'Follow the getting started guide to register your first app and embed the feedback widget.',
    priority: 90,
    guideLink: '#getting-started',
  },

  // App settings
  {
    id: 'app-settings',
    route: /^\/app\/[^/]+\/settings$/,
    title: 'App configuration',
    body: 'Set the default agent, project directory, and tmux config for this application.',
    priority: 60,
    guideLink: '#app-settings',
  },
];
