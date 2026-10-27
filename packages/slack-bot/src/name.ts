// The bot's Slack handle, used in help text, hints, feedback tags and logs.
// Each user's bot is its own Slack app (amirobot, seanbot, …) running the same
// code, so the name comes from the environment rather than the source.
export const BOT_NAME = process.env.SLACK_BOT_NAME?.trim() || 'amirobot';
