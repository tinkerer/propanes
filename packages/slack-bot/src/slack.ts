/** Minimal Slack surface the bridge needs, plus a per-channel pacing queue
 * (Slack's chat.postMessage guidance is ~1 message/second/channel). */
import type { KnownBlock } from '@slack/bolt';

export interface PostArgs {
  channel: string; thread_ts?: string; text: string; blocks?: KnownBlock[];
  /** Display name for this message (Slack's chat:write.customize scope). */
  username?: string;
}
export interface UploadArgs { channel: string; thread_ts?: string; filename: string; title: string; bytes: Buffer; comment?: string; }

export interface SlackPoster {
  postMessage(args: PostArgs): Promise<unknown>;
  permalink(channel: string, ts: string): Promise<string>;
  addReaction(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  uploadFile(args: UploadArgs): Promise<unknown>;
}

export class SlackApiError extends Error {
  constructor(public readonly code: string) {
    super(`Slack API error: ${code}`);
    this.name = 'SlackApiError';
  }
}

/** Reduce an SDK error to its Slack error code; never surface the object. */
export function slackErrorCode(error: unknown): string {
  const code = (error as { data?: { error?: string }; code?: string })?.data?.error
    ?? (error as { code?: string })?.code;
  return typeof code === 'string' && code ? code : 'unknown_error';
}

type BoltClient = {
  chat: { postMessage(args: Record<string, unknown>): Promise<unknown>; getPermalink(args: { channel: string; message_ts: string }): Promise<{ permalink?: string }> };
  reactions: { add(args: { channel: string; timestamp: string; name: string }): Promise<unknown> };
  files: { uploadV2(args: Record<string, unknown>): Promise<unknown> };
};

export function posterFromClient(client: BoltClient): SlackPoster {
  return {
    postMessage: (args) => client.chat.postMessage({ ...args, unfurl_links: false, unfurl_media: false }),
    permalink: async (channel, ts) => {
      const result = await client.chat.getPermalink({ channel, message_ts: ts });
      if (!result.permalink) throw new Error('Slack did not return a thread link');
      return result.permalink;
    },
    addReaction: (args) => client.reactions.add(args),
    uploadFile: ({ bytes, comment, ...rest }) => client.files.uploadV2({
      channel_id: rest.channel,
      thread_ts: rest.thread_ts,
      file: bytes,
      filename: rest.filename,
      title: rest.title,
      initial_comment: comment,
    }),
  };
}

/** Serialises posts per channel with a minimum gap, so bursts of transcript
 * output never flood a channel or trip Slack's rate limiter. */
export class PacedPoster implements SlackPoster {
  private tails = new Map<string, Promise<unknown>>();
  private lastAt = new Map<string, number>();
  constructor(private readonly inner: SlackPoster, private readonly minGapMs = 1000, private readonly sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {}

  private run<T>(channel: string, op: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(channel) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      const wait = (this.lastAt.get(channel) ?? 0) + this.minGapMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      try {
        return await op();
      } finally {
        this.lastAt.set(channel, Date.now());
      }
    });
    this.tails.set(channel, next);
    return next;
  }

  postMessage(args: PostArgs) { return this.run(args.channel, () => this.inner.postMessage(args)); }
  permalink(channel: string, ts: string) { return this.inner.permalink(channel, ts); }
  addReaction(args: { channel: string; timestamp: string; name: string }) { return this.inner.addReaction(args); }
  uploadFile(args: UploadArgs) { return this.run(args.channel, () => this.inner.uploadFile(args)); }
}

/** Posts under a per-user display name. Without the chat:write.customize
 * scope Slack rejects the name; the persona is then dropped (once, logged)
 * and the message goes out under the bot's own name. */
export function personaPoster(inner: SlackPoster, persona: string | null | undefined, log: (message: string) => void): SlackPoster {
  if (!persona) return inner;
  let enabled = true;
  return {
    postMessage: async (args) => {
      if (!enabled) return inner.postMessage(args);
      try {
        return await inner.postMessage({ ...args, username: persona });
      } catch (error) {
        if (slackErrorCode(error) !== 'missing_scope') throw error;
        enabled = false;
        log(`posting as "${persona}" needs the chat:write.customize scope; using the bot's own name`);
        return inner.postMessage(args);
      }
    },
    permalink: (channel, ts) => inner.permalink(channel, ts),
    addReaction: (args) => inner.addReaction(args),
    uploadFile: (args) => inner.uploadFile(args),
  };
}
