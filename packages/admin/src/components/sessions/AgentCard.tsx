import { MODE_INFO, PROFILE_DESCRIPTIONS, RUNTIME_INFO } from '../../lib/agent-constants.js';

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
  const runtime = RUNTIME_INFO[agent.runtime || 'claude'] || RUNTIME_INFO.claude;
  const isWebhook = agent.mode === 'webhook';
  const app = agent.appId ? applications.find((a: any) => a.id === agent.appId) : null;
  const isDistilled = !!agent.sourceSessionIds;

  return (
    <div class={`agent-card agent-card--${agent.mode || 'interactive'}`} key={agent.id}>
      <div class="agent-card-body">
        <div class="agent-card-top">
          <div class="agent-card-name">
            {isDistilled && <span class="agent-card-icon" title="Distilled from sessions">{'\u2728'}</span>}
            {agent.name}
            {agent.isDefault && <span class="agent-badge agent-badge--default">DEFAULT</span>}
          </div>
          <div class="agent-card-actions">
            <button class="btn btn-sm" onClick={() => onEdit(agent)}>Edit</button>
            <button class="btn btn-sm btn-danger" onClick={() => onDelete(agent.id, agent.name)}>Delete</button>
          </div>
        </div>
        {agent.description && (
          <div class="agent-card-description">{agent.description}</div>
        )}
        <div class="agent-card-meta">
          {showAppBadge && (
            app ? (
              <span class="agent-meta-tag agent-meta-tag--app">{app.name}</span>
            ) : (
              <span class="agent-meta-tag agent-meta-tag--global">Global</span>
            )
          )}
          <span class="agent-meta-tag agent-meta-tag--subtle" title={`${mode.label} mode`}>
            {mode.label}
          </span>
          {!isWebhook && (
            <span class="agent-meta-tag agent-meta-tag--subtle" title={`${runtime.label} runtime`}>
              {runtime.icon} {runtime.label}
            </span>
          )}
          {!isWebhook && (
            <span class="agent-meta-tag agent-meta-tag--subtle" title={profile.desc}>
              {profile.icon} {profile.label}
            </span>
          )}
          {!isWebhook && agent.autoPlan && (
            <span class="agent-meta-tag agent-meta-tag--plan">Auto-plan</span>
          )}
          {isDistilled && (
            <span class="agent-meta-tag agent-meta-tag--distilled" title={`Distilled from ${agent.sourceSessionIds.split(',').length} session(s)`}>
              Distilled
            </span>
          )}
        </div>
        {isWebhook && agent.url && (
          <div class="agent-card-url">{agent.url}</div>
        )}
      </div>
    </div>
  );
}
