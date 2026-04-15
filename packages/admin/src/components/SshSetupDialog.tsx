import { useState } from 'preact/hooks';
import { sshSetupDialog, completeSshSetup } from '../lib/sessions.js';
import { localBridgeUrl } from '../lib/settings.js';

export function SshSetupDialog() {
  const state = sshSetupDialog.value;
  if (!state) return null;

  const { hostname, sessionId } = state;

  return <SshSetupForm hostname={hostname} sessionId={sessionId} />;
}

function SshSetupForm({ hostname, sessionId }: { hostname: string; sessionId: string }) {
  const [user, setUser] = useState('');
  const [host, setHost] = useState(hostname);
  const [port, setPort] = useState('');
  const [bridgeUrl, setBridgeUrl] = useState(localBridgeUrl.value);

  const handleSubmit = () => {
    if (!user.trim() || !host.trim()) return;
    localBridgeUrl.value = bridgeUrl;
    completeSshSetup(
      hostname,
      { sshUser: user.trim(), sshHost: host.trim(), ...(port.trim() ? { sshPort: parseInt(port.trim(), 10) } : {}) },
      sessionId,
    );
  };

  return (
    <div class="modal-overlay" onClick={() => { sshSetupDialog.value = null; }}>
      <div class="modal" onClick={(e) => e.stopPropagation()} style="max-width:420px">
        <h3>Set Up Terminal Bridge</h3>
        <p style="color:var(--pw-text-secondary);margin-bottom:16px;font-size:13px">
          Configure SSH to reach <strong>{hostname}</strong> from your local machine.
        </p>

        <div class="form-group" style="margin-bottom:12px">
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">SSH User</label>
          <input
            type="text"
            value={user}
            onInput={(e) => setUser((e.target as HTMLInputElement).value)}
            placeholder="e.g. azureuser"
            autoFocus
            style="width:100%;padding:6px 10px;font-size:13px"
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
          />
        </div>

        <div class="form-group" style="margin-bottom:12px">
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">SSH Host / IP</label>
          <input
            type="text"
            value={host}
            onInput={(e) => setHost((e.target as HTMLInputElement).value)}
            placeholder="e.g. 20.65.8.179"
            style="width:100%;padding:6px 10px;font-size:13px"
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
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
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
          />
        </div>

        <div class="form-group" style="margin-bottom:16px">
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Local Bridge URL</label>
          <input
            type="text"
            value={bridgeUrl}
            onInput={(e) => setBridgeUrl((e.target as HTMLInputElement).value)}
            style="width:100%;padding:6px 10px;font-size:13px"
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
          />
        </div>

        <div class="modal-actions">
          <button class="btn" onClick={() => { sshSetupDialog.value = null; }}>Cancel</button>
          <button class="btn btn-primary" disabled={!user.trim() || !host.trim()} onClick={handleSubmit}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
