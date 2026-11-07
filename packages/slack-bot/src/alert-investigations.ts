/** Turns monitoring alerts this bot posted into ProPanes investigations.
 *
 * A systemd unit or cloud runbook posts an alert with the bot's token, and Bolt
 * drops the bot's own events, so the listener reads the channel's history
 * instead. A persisted cursor also means an alert posted while the listener
 * was restarting is still picked up. Each investigation is an ordinary thread:
 * a ticket (feedback item) plus a dispatched session, rooted on the alert.
 *
 * Failures come in bursts with one cause, and repairs on one host must not
 * race, so one investigation runs per channel; later alerts join it. A failure
 * that repeats after its investigation ended waits out a cooldown, and a daily
 * limit bounds the rest. */
import { decodeSlackText } from './options';
import { isLive, type PropanesClient } from './propanes';
import { threadKey, type AlertInvestigationRecord, type StateRepo, type ThreadRecord } from './state';

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_PER_DAY = 6;
const MAX_ALERT_CHARS = 3000;
/** Attempts to handle one alert before telling the channel and moving on. */
const MAX_ATTEMPTS = 3;

export interface AlertWatch {
  /** Slack channel id (C…). */
  channel: string;
  /** Anchored pattern; only matching top-level posts by this bot are alerts. */
  match: RegExp;
  /** ProPanes application to run in, as `[app:<name>]` would name it. */
  app?: string;
  /** What the agent should do; the alert text is placed above it. */
  task: string;
  cooldownMs: number;
  maxPerDay: number;
}

export interface AlertMessage {
  ts: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
  /** Set when a post overrides the display name, as linked users' personas do. */
  username?: string;
}

/** The bridge operations an investigation needs (see SlackBridge). */
export interface AlertBridge {
  startAlertInvestigation(alert: { teamId: string; channel: string; ts: string }, task: string, options: { app?: string; tags?: string[] }): Promise<ThreadRecord | undefined>;
  forwardAlert(key: string, text: string): Promise<boolean>;
}

export interface AlertInvestigatorDeps {
  watches: AlertWatch[];
  /** Top-level messages newer than `oldest`, in any order. */
  history(channel: string, oldest: string): Promise<AlertMessage[]>;
  bridge: AlertBridge;
  propanes: Pick<PropanesClient, 'getSession'>;
  state: StateRepo;
  post(args: { channel: string; thread_ts: string; text: string }): Promise<unknown>;
  permalink(channel: string, ts: string): Promise<string>;
  sessionUrl(sessionId: string): string;
  botId: string;
  teamId: string;
  log(message: string): void;
  now?: () => number;
}

/** Reads AMIROBOT_ALERT_WATCHES. A bad entry is logged and skipped, never widened. */
export function parseAlertWatches(raw: string | undefined, log: (message: string) => void): AlertWatch[] {
  if (!raw?.trim()) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    log('AMIROBOT_ALERT_WATCHES is not valid JSON; alert investigations are off');
    return [];
  }
  if (!Array.isArray(rows)) {
    log('AMIROBOT_ALERT_WATCHES must be a JSON array; alert investigations are off');
    return [];
  }
  const watches: AlertWatch[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const channel = row?.channel;
    const match = row?.match;
    const task = row?.task;
    if (typeof channel !== 'string' || !/^[CG][A-Z0-9]+$/.test(channel)
      || typeof match !== 'string' || !match.startsWith('^')
      || typeof task !== 'string' || !task.trim()
      || (row.app !== undefined && typeof row.app !== 'string')) {
      log('skipped an alert watch: it needs a channel id, a ^-anchored match and a task');
      continue;
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(match);
    } catch {
      log(`skipped the alert watch for ${channel}: its match is not a valid pattern`);
      continue;
    }
    if (watches.some((w) => w.channel === channel)) {
      log(`skipped a second alert watch for ${channel}: one watch per channel`);
      continue;
    }
    watches.push({
      channel,
      match: pattern,
      ...(row.app ? { app: row.app as string } : {}),
      task: task.trim(),
      cooldownMs: positive(row.cooldownHours) !== undefined ? positive(row.cooldownHours)! * 60 * 60_000 : DAY_MS,
      maxPerDay: positive(row.maxPerDay) ?? DEFAULT_MAX_PER_DAY,
    });
  }
  return watches;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The same failures in any order are one failure. */
export function alertSignature(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().split(/,\s*/).sort().join(',');
}

function isAlert(watch: AlertWatch, message: AlertMessage, botId: string): boolean {
  if (message.bot_id !== botId || message.username) return false;
  if (message.subtype && message.subtype !== 'bot_message') return false;
  return watch.match.test(message.text ?? '');
}

function byTs(a: AlertMessage, b: AlertMessage): number {
  return parseFloat(a.ts) - parseFloat(b.ts);
}

export class AlertInvestigator {
  private readonly attempts = new Map<string, number>();
  private readonly failing = new Set<string>();
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly d: AlertInvestigatorDeps) {
    this.now = d.now ?? Date.now;
  }

  start(pollMs: number): void {
    const tick = () => {
      this.pollOnce().finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, pollMs);
      });
    };
    tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async pollOnce(): Promise<void> {
    for (const watch of this.d.watches) {
      try {
        await this.pollWatch(watch);
        if (this.failing.delete(watch.channel)) this.d.log(`alert watch ${watch.channel} recovered`);
      } catch (err) {
        // Log the first failure of a streak only; the poll keeps running.
        if (!this.failing.has(watch.channel)) {
          this.failing.add(watch.channel);
          this.d.log(`alert watch ${watch.channel} failed: ${err instanceof Error ? err.name : 'error'}`);
        }
      }
    }
  }

  private async pollWatch(watch: AlertWatch): Promise<void> {
    const state = this.d.state;
    const cursor = state.getAlertWatch(watch.channel)?.cursor;
    if (!cursor) {
      // First run: start from now. Past alerts are history, not new work.
      state.putAlertWatch(watch.channel, { cursor: (this.now() / 1000).toFixed(6), investigations: [] });
      return;
    }
    const messages = (await this.d.history(watch.channel, cursor)).sort(byTs);
    for (const message of messages) {
      if (isAlert(watch, message, this.d.botId)) {
        try {
          await this.handleAlert(watch, message);
          this.attempts.delete(message.ts);
        } catch (err) {
          const attempts = (this.attempts.get(message.ts) ?? 0) + 1;
          if (attempts < MAX_ATTEMPTS) {
            this.attempts.set(message.ts, attempts);
            throw err; // The cursor stays put, so the next poll retries this alert.
          }
          this.attempts.delete(message.ts);
          this.d.log(`gave up on alert ${message.ts}: ${err instanceof Error ? err.name : 'error'}`);
          await this.note(watch, message, '⚠️ Could not start an investigation for this alert after several attempts. It needs a person.');
        }
      }
      const record = state.getAlertWatch(watch.channel)!;
      state.putAlertWatch(watch.channel, { ...record, cursor: message.ts });
    }
  }

  private async handleAlert(watch: AlertWatch, message: AlertMessage): Promise<void> {
    const text = decodeSlackText(message.text ?? '').slice(0, MAX_ALERT_CHARS);
    const signature = alertSignature(text);
    const key = threadKey(this.d.teamId, watch.channel, message.ts);
    const now = this.now();
    const record = this.d.state.getAlertWatch(watch.channel)!;
    const recent = record.investigations.filter((i) => now - i.startedAt < Math.max(DAY_MS, watch.cooldownMs));
    this.d.state.putAlertWatch(watch.channel, { ...record, investigations: recent });
    if (recent.some((i) => i.key === key)) return; // Handled before a restart or a failed note.

    const latest = recent[recent.length - 1];
    if (latest) {
      // A session that can no longer be read (deleted, say) must not block new alerts.
      const session = await this.d.propanes.getSession(latest.sessionId).catch(() => undefined);
      if (isLive(session?.status) && await this.d.bridge.forwardAlert(latest.key, `A further backup alert fired while you are working. Include it in this investigation: ${oneLine(text)}`)) {
        await this.note(watch, message, `Added to the running investigation: ${await this.describe(watch, latest)}.`);
        return;
      }
    }
    const repeat = recent.filter((i) => i.signature === signature).pop();
    if (repeat && now - repeat.startedAt < watch.cooldownMs) {
      const next = new Date(repeat.startedAt + watch.cooldownMs).toISOString().slice(0, 16).replace('T', ' ');
      await this.note(watch, message, `Same failure as ${await this.describe(watch, repeat)}, so it is still not fixed. No new investigation until ${next} UTC; reply in that thread to continue it.`);
      return;
    }
    if (recent.filter((i) => now - i.startedAt < DAY_MS).length >= watch.maxPerDay) {
      await this.note(watch, message, `⚠️ No investigation started: the limit of ${watch.maxPerDay} per day is reached. This alert needs a person, or mention me here to start one.`);
      return;
    }

    const task = `Investigate and fix this backup alert: ${text}\n\nPosted to Slack at ${new Date(parseFloat(message.ts) * 1000).toISOString()}.\n\n${watch.task}`;
    const started = await this.d.bridge.startAlertInvestigation(
      { teamId: this.d.teamId, channel: watch.channel, ts: message.ts },
      task,
      { app: watch.app, tags: ['backup-alert'] },
    );
    if (!started) return; // The bridge told the thread why (for example, no such app).
    const investigation: AlertInvestigationRecord = { key, ts: message.ts, signature, sessionId: started.sessionId, feedbackId: started.feedbackId, startedAt: now };
    const current = this.d.state.getAlertWatch(watch.channel)!;
    this.d.state.putAlertWatch(watch.channel, { ...current, investigations: [...current.investigations, investigation] });
  }

  private async describe(watch: AlertWatch, investigation: AlertInvestigationRecord): Promise<string> {
    const session = `<${this.d.sessionUrl(investigation.sessionId)}|session ${investigation.sessionId}>`;
    try {
      return `<${await this.d.permalink(watch.channel, investigation.ts)}|this thread>, ${session}`;
    } catch {
      return session;
    }
  }

  private note(watch: AlertWatch, message: AlertMessage, text: string): Promise<unknown> {
    return this.d.post({ channel: watch.channel, thread_ts: message.ts, text });
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
