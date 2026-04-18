import { useState } from 'preact/hooks';
import { Guide, GUIDES, resetGuide } from '../components/Guide.js';

interface Section {
  id: string;
  title: string;
  icon: string;
  content: () => any;
}

function Kbd({ children }: { children: string }) {
  return <kbd class="guide-kbd">{children}</kbd>;
}

function ShortcutRow({ keys, label }: { keys: string; label: string }) {
  const parts = keys.split('+');
  return (
    <div class="guide-shortcut-row">
      <span class="guide-shortcut-keys">
        {parts.map((p, i) => (
          <>{i > 0 && '+'}<Kbd>{p}</Kbd></>
        ))}
      </span>
      <span class="guide-shortcut-label">{label}</span>
    </div>
  );
}

function TourButton({ guideId, onStart }: { guideId: string; onStart: (g: typeof GUIDES[0]) => void }) {
  const guide = GUIDES.find((g) => g.id === guideId);
  if (!guide) return null;
  return (
    <button
      class="btn btn-sm btn-primary"
      style="margin-top:8px"
      onClick={() => { resetGuide(guide.id); onStart(guide); }}
    >
      Start "{guide.name}" Tour
    </button>
  );
}

export function UserGuidePage() {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [activeGuide, setActiveGuide] = useState<typeof GUIDES[0] | null>(null);

  function toggle(id: string) {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  const sections: Section[] = [
    {
      id: 'getting-started',
      title: 'Getting Started',
      icon: '\u{1F680}',
      content: () => (
        <div class="guide-section-body">
          <p>ProPanes is your admin dashboard for managing user feedback, dispatching agent sessions, and monitoring live connections. Now you&apos;re cooking with gases.</p>
          <ul>
            <li><strong>Register an app</strong> &mdash; Click the + button in the sidebar under "Apps" to register your first application.</li>
            <li><strong>Embed the widget</strong> &mdash; Add the feedback overlay to your site with a script tag or the bookmarklet (drag the bookmark icon from the sidebar header).</li>
            <li><strong>Configure an agent</strong> &mdash; Go to Agents to set up an endpoint that processes feedback items.</li>
            <li><strong>Submit feedback</strong> &mdash; Use the widget on your site or submit programmatically via the API.</li>
          </ul>
          <TourButton guideId="welcome-tour" onStart={setActiveGuide} />
        </div>
      ),
    },
    {
      id: 'navigation',
      title: 'Navigation',
      icon: '\u{1F9ED}',
      content: () => (
        <div class="guide-section-body">
          <p>The sidebar lists your apps and their sub-pages. Settings are at the bottom.</p>
          <ul>
            <li><strong>App sub-pages</strong> &mdash; Feedback, Aggregate, Sessions, Live, and per-app Settings.</li>
            <li><strong>Ctrl+Shift+Left/Right</strong> &mdash; Cycle between sub-pages within an app, or between settings pages.</li>
            <li><strong>Ctrl+\</strong> &mdash; Toggle the sidebar collapsed/expanded.</li>
            <li><strong>Session drawer</strong> &mdash; The bottom of the sidebar shows active agent sessions. Click to expand.</li>
          </ul>
        </div>
      ),
    },
    {
      id: 'keyboard-shortcuts',
      title: 'Keyboard Shortcuts',
      icon: '\u2328',
      content: () => (
        <div class="guide-section-body">
          <p>Press <Kbd>Ctrl+Shift+/</Kbd> at any time to see the full shortcut reference. Key shortcuts:</p>
          <div class="guide-shortcuts-grid">
            <ShortcutRow keys="Ctrl+Shift+/" label="Show shortcut help" />
            <ShortcutRow keys="Cmd+K" label="Spotlight search" />
            <ShortcutRow keys="Ctrl+Shift+Left" label="Previous page" />
            <ShortcutRow keys="Ctrl+Shift+Right" label="Next page" />
            <ShortcutRow keys="Ctrl+Shift+Up" label="Previous session tab" />
            <ShortcutRow keys="Ctrl+Shift+Down" label="Next session tab" />
            <ShortcutRow keys="Ctrl+Shift+N" label="New terminal" />
            <ShortcutRow keys="Ctrl+Shift+W" label="Close tab" />
            <ShortcutRow keys="Ctrl+Shift+K" label="Kill session" />
            <ShortcutRow keys="Ctrl+Shift+R" label="Resolve session" />
            <ShortcutRow keys="Ctrl+Shift+A" label="Jump to next waiting session" />
            <ShortcutRow keys="Ctrl+Shift+Space" label="Toggle terminal panel" />
            <ShortcutRow keys="Ctrl+Shift+B" label="Go back" />
            <ShortcutRow keys="Ctrl+\\" label="Toggle sidebar" />
            <ShortcutRow keys="Ctrl+Shift+T" label="Toggle theme" />
          </div>
          <TourButton guideId="keyboard-power-user" onStart={setActiveGuide} />
        </div>
      ),
    },
    {
      id: 'feedback-workflow',
      title: 'Feedback Workflow',
      icon: '\u{1F4CB}',
      content: () => (
        <div class="guide-section-body">
          <p>Feedback items flow through statuses: <strong>new</strong> &rarr; <strong>dispatched</strong> &rarr; <strong>resolved</strong> (or archived).</p>
          <ul>
            <li><strong>Quick dispatch</strong> &mdash; Click the play button on a feedback row to dispatch to the default agent.</li>
            <li><strong>Batch actions</strong> &mdash; Select items with checkboxes and use the toolbar for bulk dispatch, status changes, or deletion.</li>
            <li><strong>Filters</strong> &mdash; Filter by status, type, or tags using the bar at the top of the feedback list.</li>
            <li><strong>Detail view</strong> &mdash; Click a feedback item to see its full content, screenshots, and associated sessions.</li>
            <li><strong>Dispatch dialog</strong> &mdash; Choose agent, model, and target machine when dispatching manually.</li>
          </ul>
          <TourButton guideId="feedback-workflow" onStart={setActiveGuide} />
        </div>
      ),
    },
    {
      id: 'agent-sessions',
      title: 'Agent Sessions & Terminal',
      icon: '\u{1F4BB}',
      content: () => (
        <div class="guide-section-body">
          <p>When feedback is dispatched, an agent session is created. Sessions appear in the terminal panel at the bottom.</p>
          <ul>
            <li><strong>Terminal panel</strong> &mdash; Toggle with Ctrl+Shift+Space. Resize by dragging the top edge.</li>
            <li><strong>Tab bar</strong> &mdash; Each session gets a numbered tab. Use Ctrl+Shift+1-9 to jump to tabs.</li>
            <li><strong>Status indicators</strong> &mdash; Green = running, yellow = waiting for input, gray = exited.</li>
            <li><strong>Input mode</strong> &mdash; When a session is waiting, type in the input bar and press Enter to respond.</li>
            <li><strong>Auto-jump</strong> &mdash; Enable in Preferences to automatically jump to the next waiting session.</li>
            <li><strong>Popout</strong> &mdash; Right-click a tab to open in a panel, window, tab, or Terminal.app.</li>
          </ul>
          <TourButton guideId="terminal-companions" onStart={setActiveGuide} />
        </div>
      ),
    },
    {
      id: 'companions',
      title: 'Companions',
      icon: '\u{1F5C2}',
      content: () => (
        <div class="guide-section-body">
          <p>Companion tabs render alongside agent sessions, giving context without leaving the terminal.</p>
          <ul>
            <li><strong>JSONL viewer</strong> &mdash; See the structured conversation log with tool calls, code diffs, and results.</li>
            <li><strong>Iframe preview</strong> &mdash; View the page the agent is working on in a live iframe.</li>
            <li><strong>Terminal companion</strong> &mdash; A secondary terminal tied to the same machine.</li>
            <li><strong>URL companion</strong> &mdash; Open any URL in an iframe tab.</li>
            <li><strong>Feedback companion</strong> &mdash; View the feedback item associated with a session.</li>
          </ul>
          <p>Open companions from the tab bar context menu (right-click) or the companion picker.</p>
        </div>
      ),
    },
    {
      id: 'spotlight-search',
      title: 'Spotlight Search',
      icon: '\u{1F50D}',
      content: () => (
        <div class="guide-section-body">
          <p>Press <Kbd>Cmd+K</Kbd> to open spotlight search. It searches across:</p>
          <ul>
            <li>Applications (by name)</li>
            <li>Feedback items (by title and description)</li>
            <li>Agent sessions (by ID, feedback title, and status)</li>
            <li>Settings pages</li>
          </ul>
          <p>Recent results appear first. Use arrow keys to navigate and Enter to select.</p>
        </div>
      ),
    },
    {
      id: 'machines',
      title: 'Machines & Launchers',
      icon: '\u{1F5A5}',
      content: () => (
        <div class="guide-section-body">
          <p>Machines are remote compute nodes that run agent sessions via launcher daemons.</p>
          <ul>
            <li><strong>Register a machine</strong> &mdash; Add a machine with its hostname, SSH credentials, and connection details.</li>
            <li><strong>Admin Assist</strong> &mdash; Click the wrench button to auto-provision: install dependencies, start launcher, configure Docker.</li>
            <li><strong>Launchers</strong> &mdash; Daemon processes that accept session dispatches. They connect via WebSocket and spawn PTY sessions.</li>
            <li><strong>Session transfer</strong> &mdash; Move sessions between machines with their full JSONL history and artifacts.</li>
          </ul>
          <TourButton guideId="machines-harnesses" onStart={setActiveGuide} />
        </div>
      ),
    },
    {
      id: 'harnesses',
      title: 'Harnesses',
      icon: '\u{1F433}',
      content: () => (
        <div class="guide-section-body">
          <p>Harness configs define Docker Compose stacks for isolated agent testing.</p>
          <ul>
            <li><strong>Create a harness</strong> &mdash; Specify machine, Docker image, ports, env vars, and compose directory.</li>
            <li><strong>Start/stop</strong> &mdash; Launch the Docker stack from the UI or via API.</li>
            <li><strong>Agent routing</strong> &mdash; When an agent endpoint has a harness config, dispatch routes to that harness's launcher.</li>
            <li><strong>Isolation</strong> &mdash; Each harness gets its own container environment for safe testing.</li>
          </ul>
        </div>
      ),
    },
    {
      id: 'agents',
      title: 'Agent Endpoints',
      icon: '\u{1F916}',
      content: () => (
        <div class="guide-section-body">
          <p>Agent endpoints define how feedback gets processed.</p>
          <ul>
            <li><strong>Configure</strong> &mdash; Set command, model, system prompt, and harness config.</li>
            <li><strong>Default agent</strong> &mdash; Each app can have a default agent for quick dispatch.</li>
            <li><strong>Dispatch</strong> &mdash; Sessions are created when feedback is dispatched to an agent.</li>
          </ul>
        </div>
      ),
    },
    {
      id: 'aggregate',
      title: 'Aggregate Clusters',
      icon: '\u{1F4CA}',
      content: () => (
        <div class="guide-section-body">
          <p>Aggregate view groups similar feedback items into clusters automatically.</p>
          <ul>
            <li><strong>Clusters</strong> &mdash; Feedback with similar content is grouped together.</li>
            <li><strong>Action plans</strong> &mdash; Create plans for cluster-level work.</li>
            <li><strong>Filtering</strong> &mdash; Filter by app and minimum cluster size.</li>
          </ul>
        </div>
      ),
    },
    {
      id: 'live-connections',
      title: 'Live Connections',
      icon: '\u{1F310}',
      content: () => (
        <div class="guide-section-body">
          <p>The Live page shows all browsers with the feedback widget actively connected.</p>
          <ul>
            <li><strong>Status</strong> &mdash; Active/idle indicators with connected duration and last activity time.</li>
            <li><strong>Details</strong> &mdash; URL, browser, viewport size, and user identification.</li>
            <li><strong>Activity log</strong> &mdash; Expand a row to see the last 50 commands with timing and category.</li>
            <li><strong>Virtual mouse/keyboard</strong> &mdash; Agents can interact with connected pages via coordinate-based commands.</li>
          </ul>
        </div>
      ),
    },
    {
      id: 'tips',
      title: 'Tips & Tricks',
      icon: '\u{1F4A1}',
      content: () => (
        <div class="guide-section-body">
          <ul>
            <li><strong>Bookmarklet</strong> &mdash; Drag the bookmark icon from the sidebar header to your bookmarks bar. Click it on any site to load the feedback widget.</li>
            <li><strong>Panel presets</strong> &mdash; Save your tab/panel layout in Preferences and restore it later.</li>
            <li><strong>Split pane</strong> &mdash; View two sessions side by side by right-clicking a tab and choosing "Split pane".</li>
            <li><strong>Ctrl+Shift hold</strong> &mdash; Hold Ctrl+Shift to reveal quick actions (Kill, Resolve, Close) on the active session tab.</li>
            <li><strong>Multi-digit tabs</strong> &mdash; Press Ctrl+Shift+1 then 2 within 500ms to jump to tab 12.</li>
            <li><strong>Theme toggle</strong> &mdash; Press Ctrl+Shift+T to toggle between light and dark themes.</li>
            <li><strong>Contextual hints</strong> &mdash; Enable/disable hint toasts in Preferences. Reset dismissed hints to see them again.</li>
          </ul>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div class="page-header">
        <h2>User Guide</h2>
      </div>

      <div class="user-guide" style="max-width:900px">
        {sections.map((section) => {
          const isCollapsed = collapsed[section.id];
          return (
            <div key={section.id} id={section.id} class="guide-section-card">
              <div
                class="guide-section-header"
                onClick={() => toggle(section.id)}
              >
                <span class="guide-section-toggle">{isCollapsed ? '\u25B6' : '\u25BC'}</span>
                <span class="guide-section-icon">{section.icon}</span>
                <span class="guide-section-title">{section.title}</span>
              </div>
              {!isCollapsed && section.content()}
            </div>
          );
        })}
      </div>

      {activeGuide && (
        <Guide guide={activeGuide} onClose={() => setActiveGuide(null)} />
      )}
    </div>
  );
}
