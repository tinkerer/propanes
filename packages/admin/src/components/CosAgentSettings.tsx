import { useState } from 'preact/hooks';
import {
  type ChiefOfStaffAgent,
  type ChiefOfStaffVerbosity,
  type ChiefOfStaffStyle,
  DEFAULT_VERBOSITY,
  DEFAULT_STYLE,
  renameActiveAgent,
  updateActiveAgentSystemPrompt,
  updateActiveAgentVerbosity,
  updateActiveAgentStyle,
  clearActiveAgentHistory,
  removeActiveAgent,
} from '../lib/chief-of-staff.js';

/**
 * Settings pane shown in place of the chat when the operator opens the gear
 * tab — agent name + system prompt + verbosity/tone + history clear + agent
 * reset/delete. All edit state is local; everything else dispatches through
 * the agent mutation helpers in lib/chief-of-staff.
 *
 * `onHistoryCleared` lets the parent reset its `collapsedThreads` set so the
 * thread-collapse state doesn't keep stale userIdx keys after a wipe.
 */
export function CosAgentSettings({
  activeAgent,
  agentCount,
  onHistoryCleared,
}: {
  activeAgent: ChiefOfStaffAgent;
  agentCount: number;
  onHistoryCleared: () => void;
}) {
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [promptEdit, setPromptEdit] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  function commitRename() {
    if (nameEdit !== null && nameEdit.trim()) renameActiveAgent(nameEdit.trim());
    setNameEdit(null);
  }

  function commitPrompt() {
    if (promptEdit !== null) updateActiveAgentSystemPrompt(promptEdit);
    setPromptEdit(null);
  }

  return (
    <div class="cos-settings cos-settings-full">
      <div class="cos-settings-row">
        <label>Name</label>
        {nameEdit === null ? (
          <button class="cos-link-btn" onClick={() => setNameEdit(activeAgent.name)}>{activeAgent.name} — edit</button>
        ) : (
          <div class="cos-inline-edit">
            <input
              type="text"
              autoFocus
              value={nameEdit}
              onInput={(e) => setNameEdit((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                if (e.key === 'Escape') { e.preventDefault(); setNameEdit(null); }
              }}
            />
            <button class="cos-link-btn" onClick={commitRename} disabled={!nameEdit.trim()}>save</button>
            <button class="cos-link-btn" onClick={() => setNameEdit(null)}>cancel</button>
          </div>
        )}
      </div>
      <div class="cos-settings-row cos-settings-row-stack">
        <label>
          System prompt
          {promptEdit === null && (
            <button
              class="cos-link-btn"
              onClick={() => setPromptEdit(activeAgent.systemPrompt || '')}
            >
              {activeAgent.systemPrompt ? 'edit custom' : 'override default'}
            </button>
          )}
        </label>
        {promptEdit === null ? (
          <div class="cos-prompt-preview">
            {activeAgent.systemPrompt || <em>Using default Ops prompt (direct, terse, operations-focused)</em>}
          </div>
        ) : (
          <>
            <textarea
              class="cos-prompt-textarea"
              autoFocus
              rows={5}
              value={promptEdit}
              onInput={(e) => setPromptEdit((e.target as HTMLTextAreaElement).value)}
              placeholder="Leave empty to use default"
            />
            <div class="cos-inline-actions">
              <button class="cos-link-btn" onClick={commitPrompt}>save</button>
              <button class="cos-link-btn" onClick={() => setPromptEdit(null)}>cancel</button>
            </div>
          </>
        )}
      </div>
      <div class="cos-settings-row">
        <label>Verbosity</label>
        <div class="cos-view-segmented" role="radiogroup" aria-label="Reply verbosity">
          {(['terse', 'normal', 'verbose'] as ChiefOfStaffVerbosity[]).map((v) => {
            const active = (activeAgent.verbosity || DEFAULT_VERBOSITY) === v;
            return (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={active}
                class={`cos-view-seg${active ? ' cos-view-seg-active' : ''}`}
                onClick={() => updateActiveAgentVerbosity(v)}
              >
                {v}
              </button>
            );
          })}
        </div>
      </div>
      <div class="cos-settings-row">
        <label>Tone</label>
        <div class="cos-view-segmented" role="radiogroup" aria-label="Reply tone">
          {(['dry', 'neutral', 'friendly'] as ChiefOfStaffStyle[]).map((s) => {
            const active = (activeAgent.style || DEFAULT_STYLE) === s;
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={active}
                class={`cos-view-seg${active ? ' cos-view-seg-active' : ''}`}
                onClick={() => updateActiveAgentStyle(s)}
              >
                {s}
              </button>
            );
          })}
        </div>
      </div>
      <div class="cos-settings-row">
        <label>History</label>
        {activeAgent.messages.length === 0 ? (
          <span class="cos-muted">empty</span>
        ) : !confirmClear ? (
          <button class="cos-link-btn" onClick={() => setConfirmClear(true)}>
            {activeAgent.messages.length} messages — clear
          </button>
        ) : (
          <div class="cos-inline-edit">
            <span class="cos-muted">Clear all?</span>
            <button
              class="cos-link-btn cos-danger-text"
              onClick={() => {
                void clearActiveAgentHistory();
                setConfirmClear(false);
                onHistoryCleared();
              }}
            >yes, clear</button>
            <button class="cos-link-btn" onClick={() => setConfirmClear(false)}>cancel</button>
          </div>
        )}
      </div>
      <div class="cos-settings-row">
        <label>Agent</label>
        {!confirmDelete ? (
          <button class="cos-link-btn cos-danger-text" onClick={() => setConfirmDelete(true)}>
            {agentCount <= 1 ? 'reset this agent' : 'delete this agent'}
          </button>
        ) : (
          <div class="cos-inline-edit">
            <span class="cos-muted">Sure?</span>
            <button class="cos-link-btn cos-danger-text" onClick={() => { removeActiveAgent(); setConfirmDelete(false); }}>yes</button>
            <button class="cos-link-btn" onClick={() => setConfirmDelete(false)}>cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}
