import { signal } from '@preact/signals';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { api } from '../../lib/api.js';
import { openSession, loadAllSessions } from '../../lib/sessions.js';
import { cachedTargets, ensureTargetsLoaded, localTargetLabel, targetKey, parseTargetKey } from './DispatchTargetSelect.js';
import { META_WIGGUM_TEMPLATE, FAFO_ASSISTANT_TEMPLATE, STRUCTURED_MODE_TEMPLATE, RUNTIME_INFO } from '../../lib/agent-constants.js';
import { formatAgentOption, agentSortCmp, isDispatchableAgent, pickYoloAgent } from '../../lib/agent-matrix.js';
import { openSetupAssistant } from './SetupAssistantDialog.js';

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

type ActionKind = 'interactive' | 'yolo' | 'wiggum' | 'fafo' | 'structured' | 'powwow' | 'assistant';

const MODE_OPTIONS: Array<{ value: ActionKind; label: string; icon: string }> = [
  { value: 'interactive', label: 'Interactive', icon: '\u{25B6}' },
  { value: 'yolo', label: 'YOLO', icon: '\u{26A1}' },
  { value: 'wiggum', label: 'Wiggum Swarm', icon: '\u{1F575}' },
  { value: 'fafo', label: 'FAFO Swarm', icon: '\u{1F9EC}' },
  { value: 'structured', label: 'Structured', icon: '\u{1F4CB}' },
  { value: 'powwow', label: 'Powwow', icon: '\u{1FAD6}' },
  { value: 'assistant', label: 'Setup Assistant', icon: '\u{1F3AF}' },
];

interface Agent {
  id: string;
  name: string;
  mode: string;
  url?: string | null;
  runtime?: 'claude' | 'codex';
  permissionProfile: 'interactive-require' | 'interactive-yolo' | 'headless-yolo' | 'headless-stream-yolo' | 'headless-stream-require';
  isDefault: boolean;
  appId?: string | null;
  harnessConfigId?: string | null;
}

function pickAgent(
  agents: Agent[],
  profile: Agent['permissionProfile'],
  appId?: string | null,
  runtimePreference: Array<'claude' | 'codex'> = ['claude', 'codex'],
): Agent | undefined {
  const ordered = [...agents].filter(isDispatchableAgent).sort((a, b) => {
    const ai = runtimePreference.indexOf(a.runtime || 'claude');
    const bi = runtimePreference.indexOf(b.runtime || 'claude');
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  const match = (a: Agent) => a.permissionProfile === profile;
  return ordered.find(a => match(a) && a.isDefault && a.appId === appId)
    || ordered.find(a => match(a) && a.isDefault && !a.appId)
    || ordered.find(a => match(a) && a.appId === appId)
    || ordered.find(a => match(a));
}

function defaultAgent(agents: Agent[], appId?: string | null): Agent | undefined {
  const usable = agents.filter(isDispatchableAgent);
  return usable.find(a => a.isDefault && a.appId === appId)
    || usable.find(a => a.isDefault && !a.appId)
    || usable[0];
}

function groupAgentsByRuntime(agents: Agent[]): Array<[string, Agent[]]> {
  const sorted = [...agents].filter(isDispatchableAgent).sort(agentSortCmp);
  const groups = new Map<string, Agent[]>();
  for (const a of sorted) {
    const key = a.runtime || 'claude';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }
  return Array.from(groups.entries());
}


function DispatchDialogInner({ req, onClose }: { req: DispatchDialogRequest; onClose: () => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [target, setTarget] = useState('');
  const [instructions, setInstructions] = useState('');
  const [mode, setMode] = useState<ActionKind>('interactive');
  const [overrideAgentId, setOverrideAgentId] = useState<string>('');
  const [running, setRunning] = useState<ActionKind | null>(null);
  const [error, setError] = useState('');
  const instructionsRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ensureTargetsLoaded();
    (async () => {
      const list = await api.getAgents(req.appId || undefined);
      setAgents(list as Agent[]);
    })();
  }, []);

  useEffect(() => {
    instructionsRef.current?.focus();
  }, []);

  useEffect(() => {
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onDocKeyDown, true);
    return () => document.removeEventListener('keydown', onDocKeyDown, true);
  }, [onClose]);

  const targets = cachedTargets.value;
  const machines = targets.filter(t => !t.isHarness && !t.isSprite);
  const harnesses = targets.filter(t => t.isHarness);
  const sprites = targets.filter(t => t.isSprite);
  const isBatch = req.feedbackIds.length > 1;
  const interactiveAgent = useMemo(() => pickAgent(agents, 'interactive-require', req.appId), [agents, req.appId]);
  const yoloAgent = useMemo(() => pickYoloAgent(agents, req.appId), [agents, req.appId]);
  const fallbackAgent = useMemo(() => defaultAgent(agents, req.appId), [agents, req.appId]);
  const structuredAgent = useMemo(
    () => pickAgent(agents, 'headless-yolo', req.appId, ['codex', 'claude']) || interactiveAgent || fallbackAgent,
    [agents, req.appId, interactiveAgent, fallbackAgent],
  );

  async function runAction(kind: ActionKind) {
    setError('');
    setRunning(kind);
    try {
      if (kind === 'assistant') {
        openSetupAssistant({
          feedbackIds: req.feedbackIds,
          appId: req.appId,
          initialInstructions: instructions,
          initialTarget: target,
        });
        onClose();
        return;
      }

      if (kind === 'powwow') {
        const moderator = overrideAgentId ? agents.find(a => a.id === overrideAgentId) : (structuredAgent || fallbackAgent);
        const participantAgents = agents.filter((a) => a.mode !== 'webhook' && a.id !== moderator?.id);
        if (!moderator) throw new Error('No moderator agent available');
        if (participantAgents.length === 0) throw new Error('Powwow needs at least one participant agent besides the moderator');

        const { launcherId, harnessConfigId } = parseTargetKey(target, targets);
        let firstSessionId: string | undefined;
        for (const feedbackId of req.feedbackIds) {
          const result = await api.powwow({
            feedbackId,
            moderatorAgentId: moderator.id,
            participantAgentIds: participantAgents.map((a) => a.id),
            instructions: instructions.trim() || undefined,
            launcherId,
            harnessConfigId,
            rounds: 2,
          });
          if (result.sessionId && !firstSessionId) firstSessionId = result.sessionId;
        }
        if (firstSessionId && !isBatch) openSession(firstSessionId);
        loadAllSessions();
        dispatchDialogResult.value = 'dispatched';
        onClose();
        return;
      }

      const override = overrideAgentId ? agents.find(a => a.id === overrideAgentId) : undefined;
      let agent: Agent | undefined;
      let baseInstructions: string | undefined = instructions.trim() || undefined;
      let permissionProfile: string | undefined;

      if (kind === 'interactive') {
        agent = override || interactiveAgent || fallbackAgent;
      } else if (kind === 'yolo') {
        agent = override || yoloAgent || fallbackAgent;
        if (override) permissionProfile = 'interactive-yolo';
      } else if (kind === 'wiggum') {
        agent = override || fallbackAgent;
        baseInstructions = baseInstructions
          ? `${META_WIGGUM_TEMPLATE}\n\n## Additional Instructions\n${baseInstructions}`
          : META_WIGGUM_TEMPLATE;
      } else if (kind === 'fafo') {
        agent = override || fallbackAgent;
        baseInstructions = baseInstructions
          ? `${FAFO_ASSISTANT_TEMPLATE}\n\n## Additional Instructions\n${baseInstructions}`
          : FAFO_ASSISTANT_TEMPLATE;
      } else if (kind === 'structured') {
        agent = override || structuredAgent || fallbackAgent;
        baseInstructions = baseInstructions
          ? `${STRUCTURED_MODE_TEMPLATE}\n\n## Additional Instructions\n${baseInstructions}`
          : STRUCTURED_MODE_TEMPLATE;
      }

      if (!agent) throw new Error('No agent endpoint available');

      const { launcherId, harnessConfigId } = parseTargetKey(target, targets);
      let firstSessionId: string | undefined;
      for (const feedbackId of req.feedbackIds) {
        const result = await api.dispatch({
          feedbackId,
          agentEndpointId: agent.id,
          instructions: baseInstructions,
          launcherId,
          harnessConfigId,
          permissionProfile,
        });
        if (result.sessionId && !firstSessionId) firstSessionId = result.sessionId;
      }
      if (firstSessionId && !isBatch) openSession(firstSessionId);
      loadAllSessions();
      dispatchDialogResult.value = 'dispatched';
      onClose();
    } catch (err: any) {
      setError(err.message || 'Cook failed');
      dispatchDialogResult.value = 'error';
    } finally {
      setRunning(null);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runAction(mode);
    }
  }

  const batchSuffix = isBatch ? ` (${req.feedbackIds.length})` : '';
  const modeOpt = MODE_OPTIONS.find(m => m.value === mode)!;

  return (
    <div class="spotlight-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="spotlight-container dispatch-dialog-v2" style="max-width:480px" onKeyDown={handleKeyDown}>
        <div class="spotlight-input-row dispatch-dialog-topbar">
          <div class="dispatch-dialog-heading compact">
            <span class="spotlight-search-icon">{'\u{1F525}'}</span>
            <div class="dispatch-dialog-title-row compact">
              <div class="dispatch-dialog-title">Cook It{batchSuffix}</div>
            </div>
          </div>
          <kbd class="spotlight-esc" onClick={onClose}>esc</kbd>
        </div>

        <div class="dispatch-dialog-body">
          <textarea
            ref={instructionsRef}
            class="dispatch-dialog-textarea dispatch-dialog-compose"
            placeholder="Instructions or context..."
            value={instructions}
            onInput={(e) => setInstructions((e.target as HTMLTextAreaElement).value)}
            rows={3}
          />

          <div class="dispatch-selectors">
            <div class="dispatch-selector-group">
              <label class="dispatch-selector-label">Mode</label>
              <select
                class="dispatch-selector-select"
                value={mode}
                onChange={(e) => setMode((e.target as HTMLSelectElement).value as ActionKind)}
              >
                {MODE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.icon} {opt.label}</option>
                ))}
              </select>
            </div>

            <div class="dispatch-selector-group">
              <label class="dispatch-selector-label">Agent</label>
              <select
                class="dispatch-selector-select"
                value={overrideAgentId}
                onChange={(e) => setOverrideAgentId((e.target as HTMLSelectElement).value)}
              >
                <option value="">Auto</option>
                {groupAgentsByRuntime(agents).map(([runtime, group]) => (
                  <optgroup key={runtime} label={(RUNTIME_INFO[runtime] || RUNTIME_INFO.claude).label}>
                    {group.map((a) => (
                      <option key={a.id} value={a.id}>
                        {formatAgentOption(a)}{a.appId ? ' (app)' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <div class="dispatch-selector-group">
              <label class="dispatch-selector-label">Target</label>
              <select
                class="dispatch-selector-select"
                value={target}
                onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}
              >
                <option value="">{localTargetLabel()}</option>
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
          </div>

          {error && (
            <div style="color:var(--pw-danger);font-size:13px;padding:4px 0">{error}</div>
          )}

          <div class="dispatch-submit-row">
            <button class="btn btn-sm" onClick={onClose}>Cancel</button>
            <button
              class={`dispatch-cook-btn ${mode === 'yolo' ? 'yolo' : ''}`}
              disabled={!fallbackAgent || !!running}
              onClick={() => runAction(mode)}
            >
              {running ? 'Cooking\u2026' : `${modeOpt.icon} ${modeOpt.label}`}{batchSuffix}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
