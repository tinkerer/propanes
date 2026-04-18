import { signal } from '@preact/signals';
import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../lib/api.js';
import { openSession } from '../lib/sessions.js';
import { cachedTargets, ensureTargetsLoaded, targetKey, findTargetByKey, parseTargetKey } from './DispatchTargetSelect.js';

export interface DispatchDialogRequest {
  feedbackIds: string[];
  appId?: string | null;
}

export const dispatchDialogOpen = signal<DispatchDialogRequest | null>(null);
export const dispatchDialogResult = signal<'idle' | 'dispatched' | 'error'>('idle');

export function openDispatchDialog(feedbackIds: string[], appId?: string | null) {
  dispatchDialogResult.value = 'idle';
  dispatchDialogOpen.value = { feedbackIds, appId };
}

export function DispatchDialog() {
  const req = dispatchDialogOpen.value;
  if (!req) return null;

  return <DispatchDialogInner req={req} onClose={() => { dispatchDialogOpen.value = null; }} />;
}

function DispatchDialogInner({ req, onClose }: { req: DispatchDialogRequest; onClose: () => void }) {
  const [agents, setAgents] = useState<any[]>([]);
  const [agentId, setAgentId] = useState('');
  const [target, setTarget] = useState('');
  const [instructions, setInstructions] = useState('');
  const [mode, setMode] = useState<'standard' | 'assistant'>('standard');
  const [assistantPrompt, setAssistantPrompt] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const assistantRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ensureTargetsLoaded();
    (async () => {
      const list = await api.getAgents(req.appId || undefined);
      setAgents(list);
      const appDefault = list.find((a: any) => a.isDefault && a.appId === req.appId);
      const globalDefault = list.find((a: any) => a.isDefault && !a.appId);
      const def = appDefault || globalDefault || list[0];
      if (def) setAgentId(def.id);
    })();
  }, []);

  useEffect(() => {
    if (mode === 'assistant') assistantRef.current?.focus();
    else inputRef.current?.focus();
  }, [mode]);

  const targets = cachedTargets.value;
  const machines = targets.filter(t => !t.isHarness && !t.isSprite);
  const harnesses = targets.filter(t => t.isHarness);
  const sprites = targets.filter(t => t.isSprite);
  const isBatch = req.feedbackIds.length > 1;

  async function doDispatch() {
    if (!agentId) return;
    setDispatching(true);
    setError('');
    try {
      const finalInstructions = mode === 'assistant' && assistantPrompt.trim()
        ? `[Assistant mode] ${assistantPrompt.trim()}${instructions ? `\n\nAdditional instructions: ${instructions}` : ''}`
        : instructions || undefined;

      for (const feedbackId of req.feedbackIds) {
        const { launcherId, harnessConfigId } = parseTargetKey(target, targets);
        const result = await api.dispatch({
          feedbackId,
          agentEndpointId: agentId,
          instructions: finalInstructions,
          launcherId,
          harnessConfigId,
        });
        if (result.sessionId && !isBatch) {
          openSession(result.sessionId);
        }
      }
      dispatchDialogResult.value = 'dispatched';
      onClose();
    } catch (err: any) {
      setError(err.message || 'Dispatch failed');
      dispatchDialogResult.value = 'error';
    } finally {
      setDispatching(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doDispatch();
    }
  }

  const selectedAgent = agents.find(a => a.id === agentId);
  const selectedTarget = target ? findTargetByKey(targets, target) : null;
  const targetLabel = selectedTarget
    ? (selectedTarget.machineName || selectedTarget.name)
    : 'Local';

  return (
    <div class="spotlight-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="spotlight-container" style="max-width:520px" onKeyDown={handleKeyDown}>
        <div class="spotlight-input-row" style="border-bottom:1px solid var(--pw-border)">
          <span class="spotlight-search-icon">{'\u{1F680}'}</span>
          <div style="flex:1;font-weight:600;font-size:14px;padding:2px 0">
            Dispatch {isBatch ? `${req.feedbackIds.length} items` : 'Feedback'}
          </div>
          <kbd class="spotlight-esc">esc</kbd>
        </div>

        <div style="padding:12px 16px;display:flex;flex-direction:column;gap:12px">
          {/* Agent selection */}
          <div>
            <label style="font-size:12px;color:var(--pw-text-muted);display:block;margin-bottom:4px">Agent</label>
            <select
              class="dispatch-dialog-select"
              value={agentId}
              onChange={(e) => setAgentId((e.target as HTMLSelectElement).value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.isDefault && a.appId ? ' (app default)' : a.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Target selection */}
          <div>
            <label style="font-size:12px;color:var(--pw-text-muted);display:block;margin-bottom:4px">Target</label>
            <select
              class="dispatch-dialog-select"
              value={target}
              onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}
            >
              <option value="">Local</option>
              {machines.length > 0 && (
                <optgroup label="Remote Machines">
                  {machines.map(t => (
                    <option key={targetKey(t)} value={targetKey(t)} disabled={!t.online}>
                      {t.machineName || t.name}{t.online ? ` (${t.activeSessions}/${t.maxSessions})` : ' (offline)'}
                    </option>
                  ))}
                </optgroup>
              )}
              {harnesses.length > 0 && (
                <optgroup label="Harnesses">
                  {harnesses.map(t => (
                    <option key={targetKey(t)} value={targetKey(t)} disabled={!t.online}>
                      {t.name}{t.online ? ` (${t.activeSessions}/${t.maxSessions})` : ' (offline)'}
                    </option>
                  ))}
                </optgroup>
              )}
              {sprites.length > 0 && (
                <optgroup label="Sprites">
                  {sprites.map(t => (
                    <option key={targetKey(t)} value={targetKey(t)} disabled={!t.online}>
                      {t.name}{t.online ? ` (${t.activeSessions}/${t.maxSessions})` : ' (offline)'}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          {/* Mode tabs */}
          <div>
            <div class="dispatch-dialog-tabs">
              <button
                class={`dispatch-dialog-tab ${mode === 'standard' ? 'active' : ''}`}
                onClick={() => setMode('standard')}
              >
                Standard
              </button>
              <button
                class={`dispatch-dialog-tab ${mode === 'assistant' ? 'active' : ''}`}
                onClick={() => setMode('assistant')}
              >
                Assistant
              </button>
            </div>
          </div>

          {mode === 'assistant' && (
            <div>
              <textarea
                ref={assistantRef}
                class="dispatch-dialog-textarea"
                placeholder="Describe how you want to dispatch this feedback... e.g. 'Fix the CSS layout issue on the settings page, focus on the sidebar'"
                value={assistantPrompt}
                onInput={(e) => setAssistantPrompt((e.target as HTMLTextAreaElement).value)}
                rows={3}
              />
            </div>
          )}

          {/* Instructions */}
          <div>
            <label style="font-size:12px;color:var(--pw-text-muted);display:block;margin-bottom:4px">
              {mode === 'assistant' ? 'Additional instructions (optional)' : 'Instructions (optional)'}
            </label>
            <input
              ref={inputRef}
              type="text"
              class="dispatch-dialog-input"
              placeholder="Extra context for the agent..."
              value={instructions}
              onInput={(e) => setInstructions((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); doDispatch(); } }}
            />
          </div>

          {error && (
            <div style="color:var(--pw-danger);font-size:13px;padding:4px 0">{error}</div>
          )}

          {/* Footer */}
          <div style="display:flex;justify-content:flex-end;gap:8px;padding-top:4px">
            <button class="btn btn-sm" onClick={onClose}>Cancel</button>
            <button
              class="btn btn-sm btn-primary"
              disabled={!agentId || dispatching}
              onClick={doDispatch}
            >
              {dispatching ? 'Dispatching...' : `Dispatch${isBatch ? ` (${req.feedbackIds.length})` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
