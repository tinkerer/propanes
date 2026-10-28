/** One Slack app, many ProPanes users. Each linked user gets their own
 * SlackBridge (own token, own state file, own display name); the operator's
 * bridge serves everyone else. A conversation belongs to whoever started it:
 * replies from anyone else are not forwarded to that person's agent. */
import { eventThreadKey, isHumanMessage, type IncomingSlackMessage, type SlackBridge } from './bridge';
import type { SlackIdentity } from './identities';
import type { InfraTerminalAction } from './infra-actions';
import { threadKey } from './state';
import type { SlackPoster } from './slack';
import type { SlackHandoffRequest } from './propanes';
import { escapeMrkdwn } from './format';

export const OPERATOR = 'operator';

export interface RouterDeps {
  operator: SlackBridge;
  /** ProPanes user id behind PROPANES_TOKEN; linking it maps to the operator bridge. */
  operatorUserId: string;
  directory: {
    lookup(slackUserId: string | undefined): Promise<SlackIdentity | undefined>;
    all(): SlackIdentity[];
    refresh?(): Promise<void>;
  };
  createBridge(identity: SlackIdentity): SlackBridge;
  slack: SlackPoster;
  /** Unlinked Slack members are refused instead of acting as the operator. */
  requireLink: boolean;
}

interface Owner { id: string; label: string; bridge: SlackBridge; }

export class SlackRouter {
  private bridges = new Map<string, { identity: SlackIdentity; bridge: SlackBridge }>();
  private noticed = new Set<string>();

  constructor(private readonly d: RouterDeps) {}

  /** Build bridges for everyone linked now, so their threads are recognised
   * (and their watchers re-armed) after a restart. Returns re-armed watchers. */
  start(): number {
    let n = this.d.operator.recover();
    for (const identity of this.d.directory.all()) n += this.bridgeFor(identity).recover();
    return n;
  }

  stop(): void {
    this.d.operator.stop();
    for (const { bridge } of this.bridges.values()) bridge.stop();
  }

  /** The bot's Slack user and workspace, learned from auth.test. */
  setWorkspace(botUserId: string | undefined, teamId: string | undefined): void {
    for (const bridge of [this.d.operator, ...[...this.bridges.values()].map((b) => b.bridge)]) {
      bridge.setBotUserId(botUserId);
      bridge.setTeamId(teamId);
    }
  }

  /** "Continue in Slack" from the admin UI: the requester's own bridge posts it
   * (in their DM) and acts as them; the operator's requests keep using the
   * operator's handoff channel. */
  async handleHandoff(req: SlackHandoffRequest): Promise<void> {
    let identity = this.d.directory.all().find((i) => i.userId === req.requestedBy);
    if (!identity && req.requestedBy !== this.d.operatorUserId && this.d.directory.refresh) {
      await this.d.directory.refresh().catch(() => undefined); // linked moments ago
      identity = this.d.directory.all().find((i) => i.userId === req.requestedBy);
    }
    const bridge = identity && identity.userId !== this.d.operatorUserId ? this.bridgeFor(identity) : this.d.operator;
    return bridge.handleHandoff(req);
  }

  private bridgeFor(identity: SlackIdentity): SlackBridge {
    const existing = this.bridges.get(identity.userId);
    if (existing) {
      existing.identity = identity;
      return existing.bridge;
    }
    const bridge = this.d.createBridge(identity);
    this.bridges.set(identity.userId, { identity, bridge });
    return bridge;
  }

  private owner(key: string): Owner | undefined {
    if (this.d.operator.owns(key)) return { id: OPERATOR, label: 'the operator', bridge: this.d.operator };
    for (const [id, { identity, bridge }] of this.bridges) {
      if (bridge.owns(key)) return { id, label: identity.username, bridge };
    }
    return undefined;
  }

  /** Who the Slack member acts as: a linked user, the operator, or nobody. */
  private async actor(slackUserId: string | undefined): Promise<Owner | undefined> {
    const identity = await this.d.directory.lookup(slackUserId);
    if (identity && identity.userId !== this.d.operatorUserId) {
      return { id: identity.userId, label: identity.username, bridge: this.bridgeFor(identity) };
    }
    if (identity || !this.d.requireLink) return { id: OPERATOR, label: 'the operator', bridge: this.d.operator };
    return undefined;
  }

  /** Tell a member once per conversation why the bot is not acting for them. */
  private async notice(channel: string, threadTs: string | null, key: string, user: string | undefined, text: string): Promise<void> {
    const seen = `${key}|${user ?? ''}`;
    if (this.noticed.has(seen)) return;
    this.noticed.add(seen);
    await this.d.slack.postMessage({ channel, thread_ts: threadTs ?? undefined, text });
  }

  async handleEvent(ev: IncomingSlackMessage): Promise<void> {
    if (!isHumanMessage(ev)) return;
    const key = eventThreadKey(ev);
    const threadTs = ev.threadTs ?? (ev.channelType === 'im' ? null : ev.ts);
    // A DM is one person's own conversation, so it always follows the sender —
    // including one they had with the bot before their account was linked.
    const owner = ev.channelType === 'im' ? undefined : this.owner(key);
    const actor = await this.actor(ev.user);
    if (owner) {
      if (actor?.id === owner.id) return owner.bridge.handleEvent(ev);
      // Plain chatter between people in someone's thread stays unanswered;
      // addressing the bot there gets one explanation.
      if (ev.mentionsBot) {
        await this.notice(ev.channel, threadTs, key, ev.user,
          `This thread runs as *${escapeMrkdwn(owner.label)}*, so I only take instructions here from them. Mention me in a new message to start your own.`);
      }
      return;
    }
    if (!actor) {
      if (ev.mentionsBot || ev.channelType === 'im') {
        await this.notice(ev.channel, threadTs, key, ev.user,
          'Your Slack account is not linked to a ProPanes user, so I cannot start work for you. Ask an admin to link it on the ProPanes Users page.');
      }
      return;
    }
    return actor.bridge.handleEvent(ev);
  }

  async handleInfraTerminalAction(action: InfraTerminalAction): Promise<void> {
    const key = threadKey(action.teamId, action.channel, action.threadTs);
    const owner = this.owner(key);
    const actor = await this.actor(action.user);
    if (!actor || (owner && owner.id !== actor.id)) {
      await this.notice(action.channel, action.threadTs, key, action.user,
        owner ? `This thread runs as *${escapeMrkdwn(owner.label)}*; only they can open terminals from it.`
          : 'Your Slack account is not linked to a ProPanes user. Ask an admin to link it on the ProPanes Users page.');
      return;
    }
    return (owner ?? actor).bridge.handleInfraTerminalAction(action);
  }

  /** Watcher-drain for tests and shutdown. */
  async drain(): Promise<void> {
    await this.d.operator.drain();
    for (const { bridge } of this.bridges.values()) await bridge.drain();
  }
}
