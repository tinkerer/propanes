import type { BlockAction } from '@slack/bolt';

export const OPEN_INFRA_TERMINAL_ACTION = 'amirobot_open_infra_terminal';

export interface InfraTerminalAction {
  eventId: string;
  teamId: string;
  channel: string;
  user: string;
  threadTs: string | null;
  launcherId: string;
}

/** Socket Mode retries retain action_ts; distinct clicks open distinct terminals. */
export function infraTerminalAction(body: BlockAction): InfraTerminalAction | undefined {
  const action = body.actions.find(a => a.action_id === OPEN_INFRA_TERMINAL_ACTION);
  const teamId = body.team?.id ?? body.user.team_id;
  if (!action || action.type !== 'button' || !action.value || !action.action_ts || !teamId || !body.channel?.id || !body.message?.ts) return;
  return {
    eventId: `infra-terminal:${teamId}:${body.channel.id}:${body.user.id}:${action.action_ts}`,
    teamId, channel: body.channel.id, user: body.user.id,
    threadTs: body.message.thread_ts ?? (body.channel.id.startsWith('D') ? null : body.message.ts),
    launcherId: action.value,
  };
}
