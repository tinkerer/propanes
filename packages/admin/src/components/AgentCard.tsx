import { MODE_INFO, PROFILE_DESCRIPTIONS } from '../lib/agent-constants.js';

interface AgentCardProps {
  agent: any;
  applications: any[];
  onEdit: (agent: any) => void;
  onDelete: (id: string, name: string) => void;
  showAppBadge?: boolean;
}

export function AgentCard({ agent, applications, onEdit, onDelete, showAppBadge = true }: AgentCardProps) {
  const profile = PROFILE_DESCRIPTIONS[agent.permissionProfile] || PROFILE_DESCRIPTIONS.interactive;
  const mode = MODE_INFO[agent.mode] || MODE_INFO.interactive;
  const isWebhook = agent.mode === 'webhook';
  const app = agent.appId ? applications.find((a) => a.id === agent.appId) : null;

  return (
    <div class={`agent-card agent-card--${agent.mode || 'interactive'}`} key={agent.id}>
      <div class="agent-card-body">
        <div class="agent-card-top">
          <div class="agent-card-name">
            {agent.name}
            {agent.isDefault && <span class="agent-badge agent-badge--default">DEFAULT</span>}
          </div>
          <div class="agent-card-actions">
            <button class="btn btn-sm" onClick={() => onEdit(agent)}>Edit</button>
            <button class="btn btn-sm btn-danger" onClick={() => onDelete(agent.id, agent.name)}>Delete</button>
          </div>
        </div>
        <div class="agent-card-meta">
          <span class="agent-meta-tag" style={`border-color:${mode.color}40;color:${mode.color}`}>
            {mode.label}
          </span>
          {!isWebhook && (
            <span class="agent-meta-tag">
              {profile.icon} {profile.label}
            </span>
          )}
          {showAppBadge && (
            app ? (
              <span class="agent-meta-tag agent-meta-tag--app">{app.name}</span>
            ) : (
              <span class="agent-meta-tag agent-meta-tag--global">Global</span>
            )
          )}
          {!isWebhook && agent.autoPlan && (
            <span class="agent-meta-tag agent-meta-tag--plan">Auto-plan</span>
          )}
        </div>
        {isWebhook && agent.url && (
          <div class="agent-card-url">{agent.url}</div>
        )}
      </div>
    </div>
  );
}
