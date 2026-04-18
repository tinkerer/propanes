import { useState, useEffect, useCallback } from 'preact/hooks';

interface GuideStep {
  selector: string;
  title: string;
  text: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export interface GuideDef {
  id: string;
  name: string;
  steps: GuideStep[];
}

export const GUIDES: GuideDef[] = [
  {
    id: 'welcome-tour',
    name: 'Welcome Tour',
    steps: [
      {
        selector: '.sidebar-title',
        title: 'Welcome to ProPanes',
        text: 'This is your admin dashboard for managing feedback, agents, and sessions. Now you\'re cooking with gases. Let\'s take a quick tour.',
        position: 'right',
      },
      {
        selector: '.sidebar nav',
        title: 'Navigation',
        text: 'Your apps and their sub-pages are listed here. Click an app to see its feedback, agents, and more.',
        position: 'right',
      },
      {
        selector: '.sidebar-sessions-header',
        title: 'Session Drawer',
        text: 'Terminal sessions appear here. Click to expand and see active agent sessions.',
        position: 'right',
      },
      {
        selector: '.main',
        title: 'Main Content',
        text: 'The main area shows the selected page. Try pressing Ctrl+Shift+/ at any time to see keyboard shortcuts.',
        position: 'left',
      },
    ],
  },
  {
    id: 'feedback-workflow',
    name: 'Feedback Workflow',
    steps: [
      {
        selector: '.table-wrap',
        title: 'Feedback List',
        text: 'All feedback items are shown here. Use filters at the top to narrow results. Select items with checkboxes for batch actions.',
        position: 'top',
      },
      {
        selector: '.btn-dispatch-quick',
        title: 'Quick Dispatch',
        text: 'Click the play button to quickly dispatch feedback to the default agent for this app.',
        position: 'left',
      },
    ],
  },
  {
    id: 'machines-harnesses',
    name: 'Machines & Harnesses',
    steps: [
      {
        selector: 'a[href="#/settings/machines"]',
        title: 'Machines',
        text: 'Register remote compute nodes here. Each machine needs a launcher daemon to accept dispatched sessions.',
        position: 'right',
      },
      {
        selector: '.btn-admin-assist',
        title: 'Admin Assist',
        text: 'Click the wrench icon to auto-provision a machine: install dependencies, configure Docker, and start the launcher.',
        position: 'bottom',
      },
      {
        selector: 'a[href="#/settings/harnesses"]',
        title: 'Harnesses',
        text: 'Harness configs define Docker Compose stacks for isolated agent testing. Link them to agent endpoints for safe dispatch.',
        position: 'right',
      },
    ],
  },
  {
    id: 'terminal-companions',
    name: 'Terminal & Companions',
    steps: [
      {
        selector: '.sidebar-sessions-header',
        title: 'Session Drawer',
        text: 'Active sessions appear here. Click to expand the drawer and see session status at a glance.',
        position: 'right',
      },
      {
        selector: '.terminal-panel',
        title: 'Terminal Panel',
        text: 'The terminal panel shows session output. Toggle with Ctrl+Shift+Space. Drag the top edge to resize.',
        position: 'top',
      },
      {
        selector: '.tab-bar',
        title: 'Companion Tabs',
        text: 'Right-click a session tab to open companions: JSONL log, iframe preview, terminal, or feedback detail.',
        position: 'bottom',
      },
    ],
  },
  {
    id: 'keyboard-power-user',
    name: 'Keyboard Power User',
    steps: [
      {
        selector: '.main',
        title: 'Hold Ctrl+Shift',
        text: 'Holding Ctrl+Shift reveals quick-action buttons on the active session tab: Kill, Resolve, and Close.',
        position: 'left',
      },
      {
        selector: '.sidebar-header',
        title: 'Spotlight Search',
        text: 'Press Cmd+K to open spotlight search. Find apps, feedback, sessions, and settings pages instantly.',
        position: 'right',
      },
      {
        selector: 'nav',
        title: 'Navigation Shortcuts',
        text: 'Ctrl+Shift+Arrow to cycle pages. Ctrl+Shift+N for new terminal. Ctrl+\\ to toggle sidebar. Press ? for the full list.',
        position: 'right',
      },
    ],
  },
];

function isGuideCompleted(id: string): boolean {
  try {
    const completed = JSON.parse(localStorage.getItem('pw-guides-completed') || '[]');
    return completed.includes(id);
  } catch {
    return false;
  }
}

function markGuideCompleted(id: string) {
  try {
    const completed = JSON.parse(localStorage.getItem('pw-guides-completed') || '[]');
    if (!completed.includes(id)) {
      completed.push(id);
      localStorage.setItem('pw-guides-completed', JSON.stringify(completed));
    }
  } catch { /* */ }
}

export function resetGuide(id: string) {
  try {
    const completed = JSON.parse(localStorage.getItem('pw-guides-completed') || '[]');
    const filtered = completed.filter((c: string) => c !== id);
    localStorage.setItem('pw-guides-completed', JSON.stringify(filtered));
  } catch { /* */ }
}

interface GuideProps {
  guide: GuideDef;
  onClose: () => void;
}

export function Guide({ guide, onClose }: GuideProps) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const current = guide.steps[step];

  const updateRect = useCallback(() => {
    if (!current) return;
    const el = document.querySelector(current.selector);
    if (el) {
      setRect(el.getBoundingClientRect());
    } else {
      setRect(null);
    }
  }, [current]);

  useEffect(() => {
    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [updateRect]);

  function next() {
    if (step < guide.steps.length - 1) {
      setStep(step + 1);
    } else {
      markGuideCompleted(guide.id);
      onClose();
    }
  }

  function prev() {
    if (step > 0) setStep(step - 1);
  }

  function skip() {
    markGuideCompleted(guide.id);
    onClose();
  }

  const pad = 8;
  const spotStyle = rect
    ? {
        top: `${rect.top - pad}px`,
        left: `${rect.left - pad}px`,
        width: `${rect.width + pad * 2}px`,
        height: `${rect.height + pad * 2}px`,
      }
    : { top: '50%', left: '50%', width: '0px', height: '0px' };

  const pos = current?.position || 'bottom';
  const popoverStyle: Record<string, string> = {};
  if (rect) {
    if (pos === 'bottom') {
      popoverStyle.top = `${rect.bottom + pad + 12}px`;
      popoverStyle.left = `${Math.max(16, rect.left)}px`;
    } else if (pos === 'top') {
      popoverStyle.bottom = `${window.innerHeight - rect.top + pad + 12}px`;
      popoverStyle.left = `${Math.max(16, rect.left)}px`;
    } else if (pos === 'right') {
      popoverStyle.top = `${rect.top}px`;
      popoverStyle.left = `${rect.right + pad + 12}px`;
    } else {
      popoverStyle.top = `${rect.top}px`;
      popoverStyle.right = `${window.innerWidth - rect.left + pad + 12}px`;
    }
  }

  return (
    <div class="guide-overlay">
      <div class="guide-backdrop" onClick={skip} />
      <div class="guide-spotlight" style={spotStyle} />
      <div class="guide-popover" style={popoverStyle}>
        <h4>{current?.title}</h4>
        <p>{current?.text}</p>
        <div class="guide-footer">
          <span class="guide-steps">{step + 1} / {guide.steps.length}</span>
          <div class="guide-actions">
            <button class="btn btn-sm" onClick={skip}>Skip</button>
            {step > 0 && <button class="btn btn-sm" onClick={prev}>Back</button>}
            <button class="btn btn-sm btn-primary" onClick={next}>
              {step < guide.steps.length - 1 ? 'Next' : 'Done'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
