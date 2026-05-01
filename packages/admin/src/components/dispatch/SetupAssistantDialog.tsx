import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { openSession, loadAllSessions } from '../lib/sessions.js';
import { cachedTargets, ensureTargetsLoaded, findTargetByKey, parseTargetKey, targetKey } from './DispatchTargetSelect.js';
import {
  buildSetupAssistantInstructions,
  type BranchStrategyChoice,
  type PlanFirstChoice,
  type RunModeChoice,
  type SetupAssistantAnswers,
  type TestStrategyChoice,
} from '../lib/agent-constants.js';

export interface SetupAssistantRequest {
  feedbackIds: string[];
  appId?: string | null;
  initialInstructions?: string;
  initialTarget?: string;
}

export const setupAssistantOpen = signal<SetupAssistantRequest | null>(null);

export function openSetupAssistant(req: SetupAssistantRequest) {
  setupAssistantOpen.value = req;
}

interface Agent {
  id: string;
  name: string;
  mode: string;
  url?: string | null;
  runtime?: 'claude' | 'codex';
  permissionProfile: 'interactive-require' | 'interactive-yolo' | 'headless-yolo' | 'headless-stream-yolo' | 'headless-stream-require';
  isDefault: boolean;
  appId?: string | null;
}

function isAgentUsable(a: Agent): boolean {
  return a.mode !== 'webhook' || !!a.url;
}

function pickAgent(
  agents: Agent[],
  profile: Agent['permissionProfile'],
  appId?: string | null,
): Agent | undefined {
  const usable = agents.filter(isAgentUsable);
  const match = (a: Agent) => a.permissionProfile === profile;
  return usable.find(a => match(a) && a.isDefault && a.appId === appId)
    || usable.find(a => match(a) && a.isDefault && !a.appId)
    || usable.find(a => match(a) && a.appId === appId)
    || usable.find(a => match(a))
    || usable.find(a => a.isDefault)
    || usable[0];
}

export function SetupAssistantDialog() {
  const req = setupAssistantOpen.value;
  if (!req) return null;
  return <SetupAssistantInner req={req} onClose={() => { setupAssistantOpen.value = null; }} />;
}

function SetupAssistantInner({ req, onClose }: { req: SetupAssistantRequest; onClose: () => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [planFirst, setPlanFirst] = useState<PlanFirstChoice>('plan_first');
  const [tests, setTests] = useState<TestStrategyChoice>('user_tests');
  const [branch, setBranch] = useState<BranchStrategyChoice>('current_branch');
  const [runMode, setRunMode] = useState<RunModeChoice>('interactive');
  const [instructions, setInstructions] = useState(req.initialInstructions || '');
  const [target, setTarget] = useState(req.initialTarget || '');
  const [running, setRunning] = useState(false);
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
  const selectedTarget = target ? findTargetByKey(targets, target) : null;
  const targetLabel = selectedTarget ? (selectedTarget.machineName || selectedTarget.name) : 'Local';
  const isBatch = req.feedbackIds.length > 1;

  const interactiveAgent = useMemo(() => pickAgent(agents, 'interactive-require', req.appId), [agents, req.appId]);
  const yoloAgent = useMemo(() => pickAgent(agents, 'interactive-yolo', req.appId), [agents, req.appId]);
  const chosenAgent = runMode === 'yolo' ? (yoloAgent || interactiveAgent) : (interactiveAgent || yoloAgent);

  // If user picks "isolated harness" but target is Local, surface a warning prompt to also pick a harness.
  const harnessChosen = !!selectedTarget?.isHarness;
  const wantsHarness = tests === 'isolated_harness';
  const harnessHint = wantsHarness && !harnessChosen
    ? 'Tip: pick a Harness target above so the agent runs against an isolated environment.'
    : '';

  async function dispatch() {
    if (!chosenAgent) {
      setError(`No ${runMode === 'yolo' ? 'YOLO' : 'interactive'} agent endpoint configured`);
      return;
    }
    setError('');
    setRunning(true);
    try {
      const answers: SetupAssistantAnswers = { planFirst, tests, branch, runMode };
      const fullInstructions = buildSetupAssistantInstructions(answers, instructions);
      const { launcherId, harnessConfigId } = parseTargetKey(target, targets);

      let firstSessionId: string | undefined;
      for (const feedbackId of req.feedbackIds) {
        const result = await api.dispatch({
          feedbackId,
          agentEndpointId: chosenAgent.id,
          instructions: fullInstructions,
          launcherId,
          harnessConfigId,
        });
        if (result.sessionId && !firstSessionId) firstSessionId = result.sessionId;
      }
      if (firstSessionId && !isBatch) openSession(firstSessionId);
      loadAllSessions();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Dispatch failed');
    } finally {
      setRunning(false);
    }
  }

  const batchSuffix = isBatch ? ` (${req.feedbackIds.length})` : '';

  return (
    <div class="spotlight-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="spotlight-container setup-assistant-dialog" style="max-width:620px">
        <div class="spotlight-input-row dispatch-dialog-topbar">
          <div class="dispatch-dialog-heading compact">
            <span class="spotlight-search-icon">{'\u{1F3AF}'}</span>
            <div class="dispatch-dialog-title-row compact">
              <div class="dispatch-dialog-title">Setup Assistant{batchSuffix}</div>
            </div>
          </div>
          <TargetChip
            label={targetLabel}
            value={target}
            onChange={setTarget}
          />
          <kbd class="spotlight-esc" onClick={onClose}>esc</kbd>
        </div>

        <div class="setup-assistant-body">
          <ChoiceGroup
            title="Plan first?"
            value={planFirst}
            onChange={(v) => setPlanFirst(v as PlanFirstChoice)}
            options={[
              { value: 'plan_first', icon: '\u{1F4DD}', label: 'Plan first', desc: 'Agent writes PLAN.md and waits for approval' },
              { value: 'just_code', icon: '\u{26A1}', label: 'Just code', desc: 'Skip the plan, start implementing' },
            ]}
          />

          <ChoiceGroup
            title="How will this be tested?"
            value={tests}
            onChange={(v) => setTests(v as TestStrategyChoice)}
            options={[
              { value: 'user_tests', icon: '\u{1F464}', label: 'User tests', desc: 'You\'ll verify manually after the change' },
              { value: 'playwright', icon: '\u{1F3AD}', label: 'Playwright e2e', desc: 'Add automated browser tests' },
              { value: 'isolated_harness', icon: '\u{1F9EA}', label: 'Isolated harness', desc: 'Run inside a harness Docker stack' },
            ]}
          />

          <ChoiceGroup
            title="Where should the work land?"
            value={branch}
            onChange={(v) => setBranch(v as BranchStrategyChoice)}
            options={[
              { value: 'current_branch', icon: '\u{1F33F}', label: 'Current branch', desc: 'Commit on the active branch' },
              { value: 'new_branch_pr', icon: '\u{1F33A}', label: 'New branch + PR', desc: 'Fresh branch, open a PR with gh' },
              { value: 'new_worktree_pr', icon: '\u{1F333}', label: 'New worktree + PR', desc: 'Isolated worktree, no impact on your tree' },
            ]}
          />

          <ChoiceGroup
            title="Run mode"
            value={runMode}
            onChange={(v) => setRunMode(v as RunModeChoice)}
            options={[
              { value: 'interactive', icon: '\u{1F441}', label: 'Interactive', desc: chosenAgent && runMode === 'interactive' ? chosenAgent.name : 'Approve each tool' },
              { value: 'yolo', icon: '\u{26A1}', label: 'YOLO', desc: chosenAgent && runMode === 'yolo' ? chosenAgent.name : 'Skip permission prompts' },
            ]}
            twoCol
          />

          <textarea
            ref={instructionsRef}
            class="dispatch-dialog-textarea dispatch-dialog-compose"
            placeholder="Extra instructions or context (optional)..."
            value={instructions}
            onInput={(e) => setInstructions((e.target as HTMLTextAreaElement).value)}
            rows={2}
          />

          {harnessHint && (
            <div style="font-size:12px;color:var(--pw-warning,#b45309);background:rgba(245,158,11,0.08);border:1px solid color-mix(in srgb,#f59e0b 28%,var(--pw-border));padding:6px 10px;border-radius:8px">
              {harnessHint}
            </div>
          )}

          {error && (
            <div style="color:var(--pw-danger);font-size:13px;padding:4px 0">{error}</div>
          )}

          <div style="display:flex;justify-content:flex-end;gap:8px;padding-top:4px">
            <button class="btn btn-sm" onClick={onClose} disabled={running}>Cancel</button>
            <button
              class="btn btn-sm btn-primary"
              onClick={dispatch}
              disabled={running || !chosenAgent}
            >
              {running ? 'Dispatching…' : `Dispatch ${runMode === 'yolo' ? 'YOLO' : 'Interactive'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChoiceGroup<T extends string>(props: {
  title: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; icon: string; label: string; desc: string }>;
  twoCol?: boolean;
}) {
  return (
    <div class="setup-assistant-group">
      <div class="setup-assistant-group-title">{props.title}</div>
      <div class={`setup-assistant-options ${props.twoCol ? 'two-col' : ''}`}>
        {props.options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            class={`setup-assistant-option ${props.value === opt.value ? 'selected' : ''}`}
            onClick={() => props.onChange(opt.value)}
          >
            <span class="setup-assistant-option-icon">{opt.icon}</span>
            <span class="setup-assistant-option-body">
              <span class="setup-assistant-option-label">{opt.label}</span>
              <span class="setup-assistant-option-desc">{opt.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TargetChip({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const targets = cachedTargets.value;
  const machines = targets.filter(t => !t.isHarness && !t.isSprite);
  const harnesses = targets.filter(t => t.isHarness);
  const sprites = targets.filter(t => t.isSprite);

  return (
    <div style="position:relative">
      <button
        class={`dispatch-target-chip ${open ? 'open' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="Change dispatch target"
      >
        {'\u{1F4CD}'} {label} {'▾'}
      </button>
      {open && (
        <div style="position:absolute;right:0;top:calc(100% + 4px);z-index:10;background:var(--pw-bg-surface);border:1px solid var(--pw-border);border-radius:8px;padding:6px;min-width:240px;box-shadow:0 8px 20px rgba(0,0,0,0.12)">
          <select
            class="dispatch-dialog-select"
            value={value}
            onChange={(e) => { onChange((e.target as HTMLSelectElement).value); setOpen(false); }}
            autofocus
          >
            <option value="">Local</option>
            {machines.length > 0 && (
              <optgroup label="Remote Machines">
                {machines.map(t => (
                  <option key={targetKey(t)} value={targetKey(t)} disabled={!t.online}>
                    {t.machineName || t.name}{t.online ? '' : ' (offline)'}
                  </option>
                ))}
              </optgroup>
            )}
            {harnesses.length > 0 && (
              <optgroup label="Harnesses">
                {harnesses.map(t => (
                  <option key={targetKey(t)} value={targetKey(t)} disabled={!t.online}>
                    {t.name}{t.online ? '' : ' (offline)'}
                  </option>
                ))}
              </optgroup>
            )}
            {sprites.length > 0 && (
              <optgroup label="Sprites">
                {sprites.map(t => (
                  <option key={targetKey(t)} value={targetKey(t)} disabled={!t.online}>
                    {t.name}{t.online ? '' : ' (offline)'}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      )}
    </div>
  );
}
