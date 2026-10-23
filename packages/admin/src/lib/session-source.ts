// session-source.ts — which channel a session was dispatched from.
//
// The amirobot Slack bridge tags the feedback it creates `slack` + `amirobot`
// (packages/slack-bot/src/bridge.ts); the sessions API surfaces those as
// `feedbackTags` on every session row (server/src/session-source.ts). That tag
// — not the "Slack: …" title prefix, which is just the bridge's default title
// and can be renamed away — is what marks a session as a Slack thread.

export const SLACK_FEEDBACK_TAG = 'slack';

export function parseFeedbackTags(raw: unknown): string[] {
  let arr: unknown = raw;
  if (typeof arr === 'string' && arr) {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((t): t is string => typeof t === 'string');
}

export function isSlackSession(s: { feedbackTags?: unknown } | null | undefined): boolean {
  return !!s && parseFeedbackTags(s.feedbackTags).includes(SLACK_FEEDBACK_TAG);
}
