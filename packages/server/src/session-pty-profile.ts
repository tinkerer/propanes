import { basename } from 'node:path';
import type { PermissionProfile } from '@propanes/shared';

/** Read agent arguments, never prompt text or an unrelated tool subprocess. */
export function livePtyProfile(
  stored: PermissionProfile,
  commands: string[][],
): PermissionProfile {
  if (!['headless-yolo', 'headless-stream-yolo', 'headless-stream-require'].includes(stored)) return stored;
  const argv = commands.find(([command, script]) =>
    command && (basename(command) === 'claude' ||
      (basename(command) === 'node' && script?.includes('/@anthropic-ai/claude-code/'))));
  if (!argv) return stored;
  const args = argv.slice(basename(argv[0]) === 'node' ? 2 : 1);
  // Prompts are single argv entries. Matching the flattened ps output also
  // matched flags mentioned in a prompt (or in a running Bash tool).
  if (args.includes('--print') || args.includes('-p') ||
      args.some((arg) => /^--(?:input|output)-format=stream-json$/.test(arg)) ||
      args.some((arg, i) => /^--(?:input|output)-format$/.test(arg) && args[i + 1] === 'stream-json')) {
    return stored;
  }
  return args.includes('--dangerously-skip-permissions') ? 'interactive-yolo' : 'interactive-require';
}
