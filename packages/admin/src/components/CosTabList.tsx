import { type RefObject } from 'preact';
import { type ChiefOfStaffAgent } from '../lib/chief-of-staff.js';
import { hasAnyCosDraftForAgent, getCosDraft } from '../lib/cos-drafts.js';

/**
 * Tab strip across the top of the bubble: one tab per agent + a "+" button
 * to add a new agent + the Settings tab. Activating a tab sets the active
 * agent and (when the agent has an unsent draft) focuses the input on the
 * next frame so the operator picks up where they left off.
 */
export function CosTabList({
  agents,
  activeId,
  showSettings,
  onActivateAgent,
  onShowChat: _onShowChat,
  setShowSettings,
  appId,
  newAgentName,
  setNewAgentName,
  onCommitNewAgent,
  inputRef,
  isMobile,
}: {
  agents: ChiefOfStaffAgent[];
  activeId: string;
  showSettings: boolean;
  onActivateAgent: (id: string) => void;
  onShowChat: () => void;
  setShowSettings: (v: boolean) => void;
  appId: string | null;
  newAgentName: string | null;
  setNewAgentName: (v: string | null) => void;
  onCommitNewAgent: () => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  isMobile: boolean;
}) {
  return (
    <>
      {agents.map((a) => {
        const isActiveTab = a.id === activeId && !showSettings;
        // "Has draft" lights up if *any* scope under this agent (the
        // new-thread compose draft OR any reply-in-thread draft) holds
        // unsent text. We hide the indicator on the active tab since
        // the operator is already looking at the textarea.
        const hasDraft = !isActiveTab && hasAnyCosDraftForAgent(a.id, appId);
        // Preview the new-thread compose draft when present; reply
        // drafts have no obvious one-line summary so we just show "·draft".
        const newThreadDraft = getCosDraft(a.id, appId, '');
        const previewSrc = newThreadDraft || '';
        const draftPreview = previewSrc ? previewSrc.replace(/\s+/g, ' ').slice(0, 80) : '';
        return (
          <button
            key={a.id}
            class={`popout-tab ${isActiveTab ? 'active' : ''}${hasDraft ? ' has-draft' : ''}`}
            onClick={() => {
              onActivateAgent(a.id);
              // Click on a tab w/ a stashed draft → focus the textarea so
              // the operator can pick up where they left off without an
              // extra click. Defer to after the activate-render commits.
              if (hasDraft && !isMobile) setTimeout(() => inputRef.current?.focus(), 0);
            }}
            title={hasDraft
              ? (draftPreview ? `Draft: ${draftPreview}${previewSrc.length > 80 ? '…' : ''}` : 'Has unsent draft')
              : a.name}
          >
            <span class="popout-tab-label">{a.name}</span>
            {hasDraft && (
              <span class="cos-tab-draft-badge" aria-label="unsent draft">·draft</span>
            )}
          </button>
        );
      })}
      {newAgentName === null ? (
        <button
          class="popout-tab cos-tab-add"
          title="New agent"
          onClick={() => setNewAgentName('')}
        >
          <span class="popout-tab-label">+</span>
        </button>
      ) : (
        <div class="popout-tab cos-tab-new" onMouseDown={(e) => e.stopPropagation()}>
          <input
            type="text"
            autoFocus
            placeholder="Agent name"
            value={newAgentName}
            onInput={(e) => setNewAgentName((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onCommitNewAgent(); }
              if (e.key === 'Escape') { e.preventDefault(); setNewAgentName(null); }
            }}
            onBlur={() => {
              if ((newAgentName || '').trim()) onCommitNewAgent();
              else setNewAgentName(null);
            }}
          />
        </div>
      )}
      <button
        class={`popout-tab ${showSettings ? 'active' : ''}`}
        onClick={() => setShowSettings(!showSettings)}
        title="Agent settings"
      >
        <span class="popout-tab-label">Settings</span>
      </button>
    </>
  );
}
