/** The first-run guide a linked user gets in their DM: a terminal on their own
 * machine account to sign in to their agents and GitHub, then their apps'
 * dev environments set up by an agent running as them. */
import type { AppInfo } from './apps';
import { escapeMrkdwn } from './format';

export interface SetupGuideInput {
  /** Slack link to the setup terminal (already formatted). */
  terminal: string;
  apps: AppInfo[];
  /** Linked users granted `[operator]` get a line on how to use it. */
  operatorAccess?: boolean;
  /** First message after linking, rather than a `[setup]` request. */
  welcome?: boolean;
}

export function setupGuideText(input: SetupGuideInput): string {
  const lines: string[] = [];
  if (input.welcome) {
    lines.push('👋 Your Slack account is linked to ProPanes. Requests you send me run as you, on your own machine account, with your own Claude and Codex subscriptions. First, sign in to them once.');
    lines.push('');
  }
  lines.push(`*1. Open your setup terminal:* ${input.terminal} (sign in to ProPanes if it asks)`);
  lines.push('*2.* Run `claude`, pick how to log in, finish in the browser, then type `/exit`.');
  lines.push('*3.* Run `codex login` (or `codex login --device-auth` if the browser cannot reach this machine).');
  lines.push('*4.* Run `gh auth login`: GitHub.com → HTTPS → yes, authenticate Git.');
  lines.push('*5.* Run `bash ~/setup-apps.sh` to clone any of your apps that are still missing.');
  if (input.apps.length) {
    lines.push('');
    lines.push('*6. Set up each app* by asking me here; an agent does it as you, in your own checkout:');
    for (const app of input.apps) {
      lines.push(`• \`[app:${escapeMrkdwn(app.name)}] set up this repo's development environment: follow its README and AGENTS.md, install the dependencies, and tell me anything you need from me\``);
    }
    lines.push(`Your apps: ${input.apps.map((a) => `*${escapeMrkdwn(a.name)}*${a.projectDir ? ` (\`${escapeMrkdwn(a.projectDir)}\`)` : ''}`).join(', ')}.`);
  }
  lines.push('');
  if (input.operatorAccess) {
    lines.push('Need the operator\'s apps or subscriptions instead? Start a request with `[operator]`, e.g. `[operator] check the staging deploy`. That thread then runs as the operator.');
  }
  lines.push('Send `[setup]` any time for a fresh terminal and these steps · `[help]` for everything else.');
  return lines.join('\n');
}
