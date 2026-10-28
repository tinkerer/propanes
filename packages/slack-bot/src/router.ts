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
import { takeOperatorOption } from './options';

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
  log?: (message: string) => void;
}

interface Owner { id: string; label: string; bridge: SlackBridge; operatorAccess?: boolean; }

export class SlackRouter {
  private bridges = new Map<string, { identity: SlackIdentity; bridge: SlackBridge }>();
  private noticed = new Set<string>();
  /** Users whose setup guide failed to send; logged once per failure streak. */
  private welcomeFailing = new Set<string>();

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

  /** DM each newly linked user who has their own launcher the setup guide
   * (once; a failure, such as an offline launcher, is retried next time).
   * Users without a launcher pin would get a terminal on the server's own
   * account, so they are skipped. */
  async welcomeNew(): Promise<number> {
    let sent = 0;
    for (const identity of this.d.directory.all()) {
      if (identity.userId === this.d.operatorUserId || !identity.launcherId) continue;
      try {
        if (await this.bridgeFor(identity).welcome(identity.slackUserId)) {
          sent++;
          this.d.log?.(`sent the setup guide to ${identity.username}`);
        }
        this.welcomeFailing.delete(identity.userId);
      } catch (err) {
        if (!this.welcomeFailing.has(identity.userId)) {
          this.welcomeFailing.add(identity.userId);
          this.d.log?.(`could not send the setup guide to ${identity.username}: ${err instanceof Error ? err.message : 'error'}`);
        }
      }
    }
    return sent;
  }

  private bridgeFor(identity: SlackIdentity): SlackBridge {
    const existing = this.bridges.get(identity.userId);
    if (existing) {
      existing.identity = identity;
      existing.bridge.setOperatorAccess(!!identity.operatorAccess);
      return existing.bridge;
    }
    const bridge = this.d.createBridge(identity);
    bridge.setOperatorAccess(!!identity.operatorAccess);
    this.bridges.set(identity.userId, { identity, bridge });
    return bridge;
  }

  private operatorOwner(): Owner {
    return { id: OPERATOR, label: 'the operator', bridge: this.d.operator };
  }

  private owner(key: string): Owner | undefined {
    if (this.d.operator.owns(key)) return this.operatorOwner();
    for (const [id, { identity, bridge }] of this.bridges) {
      if (bridge.owns(key)) return { id, label: identity.username, bridge };
    }
    return undefined;
  }

  /** Who the Slack member acts as: a linked user, the operator, or nobody. */
  private async actor(slackUserId: string | undefined): Promise<Owner | undefined> {
    const identity = await this.d.directory.lookup(slackUserId);
    if (identity && identity.userId !== this.d.operatorUserId) {
      return { id: identity.userId, label: identity.username, bridge: this.bridgeFor(identity), operatorAccess: !!identity.operatorAccess };
    }
    if (identity || !this.d.requireLink) return this.operatorOwner();
    return undefined;
  }

  /** Tell a member once per conversation why the bot is not acting for them. */
  private async notice(channel: string, threadTs: string | null, key: string, user: string | undefined, text: string): Promise<void> {
    const seen = `${key}|${user ?? ''}`;
    if (this.noticed.has(seen)) return;
    this.noticed.add(seen);
    await this.d.slack.postMessage({ channel, thread_ts: threadTs ?? undefined, text });
  }

  async handleEvent(incoming: IncomingSlackMessage): Promise<void> {
    if (!isHumanMessage(incoming)) return;
    const key = eventThreadKey(incoming);
    const threadTs = incoming.threadTs ?? (incoming.channelType === 'im' ? null : incoming.ts);
    const { text, operator: asOperator } = takeOperatorOption(incoming.text);
    const ev = asOperator ? { ...incoming, text } : incoming;
    const actor = await this.actor(ev.user);
    // A thread a linked user started as the operator stays theirs to drive.
    if (actor && actor.id !== OPERATOR && this.d.operator.delegateOf(key) === actor.id) {
      return this.d.operator.handleEvent(ev);
    }
    // A DM is one person's own conversation, so it always follows the sender —
    // including one they had with the bot before their account was linked.
    const owner = ev.channelType === 'im' ? undefined : this.owner(key);
    if (owner) {
      if (actor?.id === owner.id) return owner.bridge.handleEvent(ev);
      // Plain chatter between people in someone's thread stays unanswered;
      // addressing the bot there gets one explanation.
      if (ev.mentionsBot || asOperator) {
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
    if (asOperator && actor.id !== OPERATOR) {
      if (!actor.operatorAccess) {
        await this.notice(ev.channel, threadTs, key, ev.user,
          '`[operator]` runs a request as the operator, and your account is not allowed to. Ask an admin to allow it on the ProPanes Users page (Slack link). Nothing was started.');
        return;
      }
      await this.d.operator.handleEvent(ev);
      // Follow-ups in the thread (not the DM as a whole) keep running as the operator.
      if (threadTs !== null && this.d.operator.owns(key)) this.d.operator.delegate(key, actor.id);
      return;
    }
    return actor.bridge.handleEvent(ev);
  }

  async handleInfraTerminalAction(action: InfraTerminalAction): Promise<void> {
    const key = threadKey(action.teamId, action.channel, action.threadTs);
    const actor = await this.actor(action.user);
    const delegated = !!actor && actor.id !== OPERATOR && this.d.operator.delegateOf(key) === actor.id;
    const owner = this.owner(key);
    if (delegated) return this.d.operator.handleInfraTerminalAction(action);
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
