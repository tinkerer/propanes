import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { SetupAssistButton } from '../components/SetupAssistButton.js';
import { DeletedItemsPanel, trackDeletion } from '../components/DeletedItemsPanel.js';
import { AgentCard } from '../components/AgentCard.js';
import { AgentFormModal } from '../components/AgentFormModal.js';

const agents = signal<any[]>([]);
const applications = signal<any[]>([]);
const loading = signal(true);

async function loadAgents() {
  loading.value = true;
  try {
    const [agentsList, appsList] = await Promise.all([
      api.getAgents(),
      api.getApplications(),
    ]);
    agents.value = agentsList;
    applications.value = appsList;
  } catch (err) {
    console.error('Failed to load agents:', err);
  } finally {
    loading.value = false;
  }
}

async function deleteAgent(id: string, name: string) {
  await api.deleteAgent(id);
  trackDeletion('agents', id, name);
  await loadAgents();
}

let loaded = false;

export function AgentsPage() {
  const [modalAgent, setModalAgent] = useState<any | undefined>(undefined);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalFixedAppId, setModalFixedAppId] = useState<string | undefined>(undefined);

  if (!loaded) {
    loaded = true;
    loadAgents();
  }

  function openCreate(fixedAppId?: string) {
    setModalAgent(undefined);
    setModalFixedAppId(fixedAppId);
    setModalVisible(true);
  }

  function openEdit(agent: any) {
    setModalAgent(agent);
    setModalFixedAppId(undefined);
    setModalVisible(true);
  }

  const globalAgents = agents.value.filter(a => !a.appId);

  const appGroups: { app: any; agents: any[] }[] = [];
  for (const app of applications.value) {
    const appAgents = agents.value.filter(a => a.appId === app.id);
    if (appAgents.length > 0) {
      appGroups.push({ app, agents: appAgents });
    }
  }

  return (
    <div style="max-width:800px">
      <div class="page-header">
        <div>
          <h2>Agents</h2>
          <p style="font-size:13px;color:var(--pw-text-muted);margin-top:4px">
            Compute environments where Claude Code runs to handle dispatched feedback.
          </p>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <SetupAssistButton entityType="agent" entityLabel="Agents" />
          <button class="btn btn-primary" onClick={() => openCreate()}>+ Add Agent</button>
        </div>
      </div>

      {/* Global agents */}
      {globalAgents.length > 0 && (
        <div style="margin-bottom:20px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <h4 style="margin:0;font-size:13px;color:var(--pw-text-muted);text-transform:uppercase;letter-spacing:0.5px">Global Agents</h4>
          </div>
          <div class="agent-list">
            {globalAgents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                applications={applications.value}
                onEdit={openEdit}
                onDelete={deleteAgent}
              />
            ))}
          </div>
        </div>
      )}

      {/* Per-app agent groups */}
      {appGroups.map(({ app, agents: appAgents }) => (
        <div key={app.id} style="margin-bottom:20px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <h4 style="margin:0;font-size:13px;color:var(--pw-text-muted);text-transform:uppercase;letter-spacing:0.5px">{app.name}</h4>
            <button class="btn btn-sm" style="font-size:10px;padding:1px 8px" onClick={() => openCreate(app.id)}>+ Add</button>
          </div>
          <div class="agent-list">
            {appAgents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                applications={applications.value}
                onEdit={openEdit}
                onDelete={deleteAgent}
              />
            ))}
          </div>
        </div>
      ))}

      {agents.value.length === 0 && !loading.value && (
        <div class="agent-empty">
          <div class="agent-empty-icon">{'\u{1F916}'}</div>
          <div class="agent-empty-title">No agents configured</div>
          <div class="agent-empty-desc">Add an agent to start dispatching feedback to Claude Code.</div>
          <button class="btn btn-primary" style="margin-top:12px" onClick={() => openCreate()}>+ Add Agent</button>
        </div>
      )}

      <DeletedItemsPanel type="agents" />

      <AgentFormModal
        key={modalAgent?.id || (modalVisible ? 'new' : 'closed')}
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        onSaved={loadAgents}
        editAgent={modalAgent}
        applications={applications.value}
        fixedAppId={modalFixedAppId}
      />
    </div>
  );
}
