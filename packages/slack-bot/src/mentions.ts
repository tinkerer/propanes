/** Acknowledge a human mention before dispatching work into its Slack thread. */
export type MentionEvent = {
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
};

type MentionClient = {
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
};

type Dispatch = (
  client: MentionClient,
  threadKey: string,
  channel: string,
  threadTs: string,
  text: string,
) => Promise<void>;

export async function handleMention(
  event: MentionEvent,
  client: MentionClient,
  dispatch: Dispatch,
  warn: (message: string) => void,
): Promise<void> {
  if (event.bot_id || event.subtype === 'bot_message') return;
  const text = (event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!text) return;

  try {
    // React to the actual mention, including a mention inside an existing thread.
    await client.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: 'eyes',
    });
  } catch (error: unknown) {
    // Missing reaction scope or a locked thread must not prevent the answer.
    // Never log the SDK error object: it can contain request credentials.
    const code = (error as { data?: { error?: string } })?.data?.error;
    if (code !== 'already_reacted') warn('Could not add eyes reaction; continuing with threaded reply.');
  }

  const threadTs = event.thread_ts ?? event.ts;
  await dispatch(client, threadTs, event.channel, threadTs, text);
}
