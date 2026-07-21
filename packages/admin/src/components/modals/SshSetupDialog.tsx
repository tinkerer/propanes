import { useState } from 'preact/hooks';
import { sshSetupDialog, completeSshSetup, type KubeTerminalTarget } from '../../lib/sessions.js';
import { localBridgeUrl } from '../../lib/settings.js';

export function SshSetupDialog() {
  const state = sshSetupDialog.value;
  if (!state) return null;

  const { hostname, sessionId, kubernetes } = state;

  return <SshSetupForm hostname={hostname} sessionId={sessionId} kubernetes={kubernetes} />;
}

function SshSetupForm({ hostname, sessionId, kubernetes }: { hostname: string; sessionId: string; kubernetes: KubeTerminalTarget | null }) {
  // The CLI deep link is the default: no local bridge server, no cluster or
  // host credentials — just the @propanes/cli protocol handler.
  const [mode, setMode] = useState<'ssh' | 'kubectl' | 'cli'>('cli');
  const [user, setUser] = useState('');
  const [host, setHost] = useState(hostname);
  const [port, setPort] = useState('');
  const [kubeContext, setKubeContext] = useState('');
  const [bridgeUrl, setBridgeUrl] = useState(localBridgeUrl.value);

  const canSubmit = mode === 'cli' ? true : mode === 'kubectl' ? !!kubernetes : !!(user.trim() && host.trim());

  const handleSubmit = () => {
    if (!canSubmit) return;
    localBridgeUrl.value = bridgeUrl;
    if (mode === 'cli') {
      completeSshSetup(hostname, { mode: 'cli' }, sessionId);
    } else if (mode === 'kubectl') {
      completeSshSetup(hostname, { mode: 'kubectl', ...(kubeContext.trim() ? { kubeContext: kubeContext.trim() } : {}) }, sessionId);
    } else {
      completeSshSetup(
        hostname,
        { mode: 'ssh', sshUser: user.trim(), sshHost: host.trim(), ...(port.trim() ? { sshPort: parseInt(port.trim(), 10) } : {}) },
        sessionId,
      );
    }
  };

  const onEnter = (e: KeyboardEvent) => { if (e.key === 'Enter') handleSubmit(); };

  const tabStyle = (active: boolean) =>
    `flex:1;padding:6px 10px;font-size:12.5px;font-weight:600;cursor:pointer;border:1px solid var(--pw-border);border-radius:6px;text-align:center;` +
    (active
      ? 'background:var(--pw-accent-bg, rgba(250,204,21,0.12));border-color:var(--pw-accent, #facc15);color:var(--pw-text)'
      : 'background:var(--pw-bg-secondary);color:var(--pw-text-secondary)');

  return (
    <div class="modal-overlay" onClick={() => { sshSetupDialog.value = null; }}>
      <div class="modal" onClick={(e) => e.stopPropagation()} style="max-width:440px">
        <h3>Set Up Terminal Bridge</h3>
        <p style="color:var(--pw-text-secondary);margin-bottom:12px;font-size:13px">
          Configure how Terminal.app on your local machine attaches to sessions on <strong>{hostname}</strong>.
        </p>

        <div style="display:flex;gap:8px;margin-bottom:14px">
          <div style={tabStyle(mode === 'cli')} onClick={() => setMode('cli')}>
            propanes CLI (recommended)
          </div>
          <div style={tabStyle(mode === 'kubectl')} onClick={() => setMode('kubectl')}>kubectl</div>
          <div style={tabStyle(mode === 'ssh')} onClick={() => setMode('ssh')}>SSH</div>
        </div>

        {mode === 'cli' && (
          <div>
            <p style="color:var(--pw-text-secondary);margin-bottom:10px;font-size:12.5px">
              Opens Terminal.app through a <code>propanes://</code> link handled by the
              Propanes CLI — no local server, no cluster credentials. One-time setup:
            </p>
            <pre style="margin:0 0 12px;padding:8px 10px;border:1px solid var(--pw-border);border-radius:6px;background:var(--pw-bg-secondary);font-size:11.5px;overflow-x:auto">{`npm install -g @propanes/cli
propanes login --server ${location.origin}
propanes install-protocol`}</pre>
            <p style="color:var(--pw-text-muted);margin-bottom:12px;font-size:11.5px">
              Connect saves this choice for {hostname} and fires the link. If nothing
              opens, finish the setup above and click Open in Terminal.app again.
            </p>
          </div>
        )}

        {mode === 'kubectl' && (
          <div>
            {kubernetes ? (
              <div style="margin-bottom:12px;padding:8px 10px;border:1px solid var(--pw-border);border-radius:6px;background:var(--pw-bg-secondary);font-size:12px">
                <div style="font-weight:600;margin-bottom:2px">Detected target</div>
                <div style="font-family:ui-monospace,Menlo,monospace;color:var(--pw-text-secondary)">
                  -n {kubernetes.namespace}{kubernetes.container ? ` -c ${kubernetes.container}` : ''} {kubernetes.pod}
                </div>
              </div>
            ) : (
              <div style="margin-bottom:12px;padding:8px 10px;border:1px solid var(--pw-border);border-radius:6px;font-size:12px;color:var(--pw-error)">
                The server did not report a Kubernetes pod for this session — use SSH mode instead.
              </div>
            )}
            <div class="form-group" style="margin-bottom:12px">
              <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">
                kubectl context <span style="color:var(--pw-text-muted);font-weight:400">(optional)</span>
              </label>
              <input
                type="text"
                value={kubeContext}
                onInput={(e) => setKubeContext((e.target as HTMLInputElement).value)}
                placeholder="current kubeconfig context"
                autoFocus
                style="width:100%;padding:6px 10px;font-size:13px"
                onKeyDown={onEnter}
              />
            </div>
            <p style="color:var(--pw-text-muted);margin-bottom:12px;font-size:11.5px">
              Runs <code>kubectl exec</code> from your machine using your kubeconfig credentials
              (e.g. <code>az aks get-credentials</code>) — no sshd on the pod. The target pod is
              re-resolved on every open, so restarts are handled automatically.
            </p>
          </div>
        )}

        {mode === 'ssh' && (
          <div>
            <div class="form-group" style="margin-bottom:12px">
              <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">SSH User</label>
              <input
                type="text"
                value={user}
                onInput={(e) => setUser((e.target as HTMLInputElement).value)}
                placeholder="e.g. azureuser"
                autoFocus
                style="width:100%;padding:6px 10px;font-size:13px"
                onKeyDown={onEnter}
              />
            </div>
            <div class="form-group" style="margin-bottom:12px">
              <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">SSH Host / IP</label>
              <input
                type="text"
                value={host}
                onInput={(e) => setHost((e.target as HTMLInputElement).value)}
                placeholder="e.g. 192.0.2.10"
                style="width:100%;padding:6px 10px;font-size:13px"
                onKeyDown={onEnter}
              />
            </div>
            <div class="form-group" style="margin-bottom:12px">
              <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">SSH Port <span style="color:var(--pw-text-muted);font-weight:400">(optional)</span></label>
              <input
                type="text"
                value={port}
                onInput={(e) => setPort((e.target as HTMLInputElement).value)}
                placeholder="22"
                style="width:80px;padding:6px 10px;font-size:13px"
                onKeyDown={onEnter}
              />
            </div>
          </div>
        )}

        {mode !== 'cli' && (
          <div class="form-group" style="margin-bottom:16px">
            <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Local Bridge URL</label>
            <input
              type="text"
              value={bridgeUrl}
              onInput={(e) => setBridgeUrl((e.target as HTMLInputElement).value)}
              style="width:100%;padding:6px 10px;font-size:13px"
              onKeyDown={onEnter}
            />
          </div>
        )}

        <div class="modal-actions">
          <button class="btn" onClick={() => { sshSetupDialog.value = null; }}>Cancel</button>
          <button class="btn btn-primary" disabled={!canSubmit} onClick={handleSubmit}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
