import { signal } from '@preact/signals';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { api } from '../lib/api.js';
import { openSession, loadAllSessions } from '../lib/sessions.js';
import { cachedTargets, ensureTargetsLoaded, targetKey, findTargetByKey, parseTargetKey } from './DispatchTargetSelect.js';
import { META_WIGGUM_TEMPLATE, FAFO_ASSISTANT_TEMPLATE, STRUCTURED_MODE_TEMPLATE } from '../lib/agent-constants.js';

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

interface Agent {
  id: string;
  name: string;
  mode: string;
  url?: string | null;
  runtime?: 'claude' | 'codex';
  permissionProfile: 'interactive' | 'auto' | 'yolo';
  isDefault: boolean;
  appId?: string | null;
  harnessConfigId?: string | null;
}

// A webhook endpoint with no URL can't be dispatched to — exclude from auto-pick
// so the picker doesn't silently land on a misconfigured endpoint.
function isAgentUsable(a: Agent): boolean {
  return a.mode !== 'webhook' || !!a.url;
}

function pickAgent(
  agents: Agent[],
  profile: Agent['permissionProfile'],
  appId?: string | null,
  runtimePreference: Array<'claude' | 'codex'> = ['claude', 'codex'],
): Agent | undefined {
  const ordered = [...agents].filter(isAgentUsable).sort((a, b) => {
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
  const usable = agents.filter(isAgentUsable);
  return usable.find(a => a.isDefault && a.appId === appId)
    || usable.find(a => a.isDefault && !a.appId)
    || usable[0];
}

function DispatchDialogInner({ req, onClose }: { req: DispatchDialogRequest; onClose: () => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [target, setTarget] = useState('');
  const [instructions, setInstructions] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [overrideAgentId, setOverrideAgentId] = useState<string>('');
  const [targetOpen, setTargetOpen] = useState(false);
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
  const selectedTarget = target ? findTargetByKey(targets, target) : null;
  const targetLabel = selectedTarget ? (selectedTarget.machineName || selectedTarget.name) : 'Local';

  const interactiveAgent = useMemo(() => pickAgent(agents, 'interactive', req.appId), [agents, req.appId]);
  const yoloAgent = useMemo(() => pickAgent(agents, 'yolo', req.appId, ['codex', 'claude']), [agents, req.appId]);
  const fallbackAgent = useMemo(() => defaultAgent(agents, req.appId), [agents, req.appId]);
  const structuredAgent = useMemo(
    () => pickAgent(agents, 'auto', req.appId, ['codex', 'claude']) || interactiveAgent || fallbackAgent,
    [agents, req.appId, interactiveAgent, fallbackAgent],
  );

  async function runAction(kind: ActionKind) {
    setError('');
    setRunning(kind);
    try {
      if (kind === 'assistant') {
        // Phase 2 — not implemented yet
        setError('Setup Assistant coming soon');
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

      if (kind === 'interactive') {
        agent = override || interactiveAgent || fallbackAgent;
      } else if (kind === 'yolo') {
        agent = override || yoloAgent || fallbackAgent;
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
      runAction('interactive');
    }
  }

  const batchSuffix = isBatch ? ` (${req.feedbackIds.length})` : '';

  return (
    <div class="spotlight-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="spotlight-container dispatch-dialog-v2" style="max-width:560px" onKeyDown={handleKeyDown}>
        <div class="spotlight-input-row dispatch-dialog-topbar">
          <div class="dispatch-dialog-heading compact">
            <span class="spotlight-search-icon">{'\u{1F525}'}</span>
            <div class="dispatch-dialog-title-row compact">
              <div class="dispatch-dialog-title">Cook It{batchSuffix}</div>
            </div>
          </div>
          <button
            class={`dispatch-target-chip ${targetOpen ? 'open' : ''}`}
            onClick={() => setTargetOpen(v => !v)}
            title="Change cooking target"
          >
            {'\u{1F4CD}'} {targetLabel} {'\u25BE'}
          </button>
          <kbd class="spotlight-esc">esc</kbd>
        </div>

        {targetOpen && (
          <div style="padding:8px 16px;border-bottom:1px solid var(--pw-border);background:var(--pw-bg-sunken)">
            <select
              class="dispatch-dialog-select"
              value={target}
              onChange={(e) => { setTarget((e.target as HTMLSelectElement).value); setTargetOpen(false); }}
              autofocus
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
        )}

        <div class="dispatch-dialog-body">
          <textarea
            ref={instructionsRef}
            class="dispatch-dialog-textarea dispatch-dialog-compose"
            placeholder="Instructions or context..."
            value={instructions}
            onInput={(e) => setInstructions((e.target as HTMLTextAreaElement).value)}
            rows={2}
          />

          <div class="dispatch-actions-grid">
            <ActionButton
              kind="interactive"
              icon={'\u{25B6}'}
              label={`Cook It${batchSuffix}`}
              subtitle={interactiveAgent ? interactiveAgent.name : 'Interactive'}
              accent="primary"
              disabled={!fallbackAgent}
              running={running}
              onClick={() => runAction('interactive')}
            />
            <ActionButton
              kind="yolo"
              icon={'\u{26A1}'}
              label={`YOLO Modex${batchSuffix}`}
              subtitle={yoloAgent ? yoloAgent.name : 'Autonomous'}
              accent="warning"
              disabled={!fallbackAgent}
              running={running}
              onClick={() => runAction('yolo')}
            />
            <ActionButton
              kind="wiggum"
              icon={'\u{1F575}'}
              label="Wiggum Swarm"
              subtitle="Iterative experiments"
              accent="neutral"
              disabled={!fallbackAgent}
              running={running}
              onClick={() => runAction('wiggum')}
            />
            <ActionButton
              kind="fafo"
              icon={'\u{1F9EC}'}
              label="FAFO Swarm"
              subtitle="Evolutionary search"
              accent="neutral"
              disabled={!fallbackAgent}
              running={running}
              onClick={() => runAction('fafo')}
            />
            <ActionButton
              kind="structured"
              icon={'\u{1F4CB}'}
              label="Structured Mode"
              subtitle={structuredAgent ? structuredAgent.name : 'Structured output'}
              accent="neutral"
              disabled={!fallbackAgent}
              running={running}
              onClick={() => runAction('structured')}
            />
            <ActionButton
              kind="powwow"
              icon={'\u{1FAD6}'}
              label="Powwow"
              subtitle="Multi-agent compare"
              accent="neutral"
              disabled={agents.filter((a) => a.mode !== 'webhook').length < 2}
              running={running}
              onClick={() => runAction('powwow')}
            />
            <ActionButton
              kind="assistant"
              icon={'\u{1F3AF}'}
              label="Plan First"
              subtitle="Guided setup"
              accent="neutral"
              disabled={!fallbackAgent}
              running={running}
              onClick={() => runAction('assistant')}
              full
            />
          </div>

          <button
            class="dispatch-advanced-toggle"
            onClick={() => setAdvancedOpen(v => !v)}
          >
            {advancedOpen ? '\u25BE' : '\u25B8'} Fine Tune
          </button>

          {advancedOpen && (
            <div style="display:flex;flex-direction:column;gap:6px">
              <label style="font-size:12px;color:var(--pw-text-muted)">Force a specific burner</label>
              <select
                class="dispatch-dialog-select"
                value={overrideAgentId}
                onChange={(e) => setOverrideAgentId((e.target as HTMLSelectElement).value)}
              >
                <option value="">Auto-pick for this mode</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} [{a.runtime || 'claude'} / {a.permissionProfile}]{a.isDefault && a.appId ? ' (app default)' : a.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {error && (
            <div style="color:var(--pw-danger);font-size:13px;padding:4px 0">{error}</div>
          )}

          <div style="display:flex;justify-content:flex-end;gap:8px;padding-top:4px">
            <button class="btn btn-sm" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionButton(props: {
  kind: ActionKind;
  icon: string;
  label: string;
  subtitle: string;
  accent: 'primary' | 'warning' | 'neutral';
  disabled?: boolean;
  running: ActionKind | null;
  onClick: () => void;
  full?: boolean;
}) {
  const isRunning = props.running === props.kind;
  const otherRunning = props.running && props.running !== props.kind;
  return (
    <button
      class={`dispatch-action-btn accent-${props.accent} ${props.full ? 'full' : ''}`}
      disabled={!!props.disabled || !!otherRunning || isRunning}
      onClick={props.onClick}
    >
      <span class="dispatch-action-icon">{props.icon}</span>
      <span class="dispatch-action-body">
        <span class="dispatch-action-label">{isRunning ? 'Cooking\u2026' : props.label}</span>
        <span class="dispatch-action-subtitle">{props.subtitle}</span>
      </span>
    </button>
  );
}
