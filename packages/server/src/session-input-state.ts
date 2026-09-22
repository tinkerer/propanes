// Claude Code signals state via OSC 0 (Set Window Title):
//   Spinner chars (⠐⠂⠈⠠ etc.) = actively working → 'active'
//   ✳ prefix = done working → 'idle' or 'waiting'
// We parse these from the onData stream for real-time detection.
// To distinguish idle vs waiting, we check the recent output buffer
// for permission prompt indicators ("Esc to cancel") as output arrives.

export const BRAILLE_SPINNERS = new Set('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠐⠂⠈⠠⡀⢀⠁⠄⠑⠒');

// Parse OSC 0 title sequences from raw PTY data.
// Returns the last title found in the chunk, or null.
export function extractOscTitle(data: string): string | null {
  let lastTitle: string | null = null;
  let idx = 0;
  while (idx < data.length) {
    // Look for ESC ] 0 ;
    const oscStart = data.indexOf('\x1b]0;', idx);
    if (oscStart === -1) break;
    const contentStart = oscStart + 4;
    // Find BEL terminator
    const belEnd = data.indexOf('\x07', contentStart);
    // Find ST terminator (ESC \)
    const stEnd = data.indexOf('\x1b\\', contentStart);
    let end = -1;
    if (belEnd !== -1 && stEnd !== -1) end = Math.min(belEnd, stEnd);
    else if (belEnd !== -1) end = belEnd;
    else if (stEnd !== -1) end = stEnd;
    if (end === -1) break;
    lastTitle = data.slice(contentStart, end);
    idx = end + 1;
  }
  return lastTitle;
}

// Classify a title as active, idle, or waiting.
// When the title indicates idle (✳), check the LAST FEW LINES of visible text
// for permission prompts or interactive selection prompts.
// Only checking the tail avoids false positives when an agent's output text
// *discusses* these patterns (e.g. "arrow keys" appearing in code analysis).
export function classifyFromTitle(title: string, visibleText: string): InputState {
  const firstChar = title.charAt(0);
  if (BRAILLE_SPINNERS.has(firstChar)) return 'active';
  if (firstChar !== '✳') return 'active'; // unknown title = assume active

  // Only check the last ~8 lines where actual prompts appear
  const lines = visibleText.trimEnd().split('\n');
  const tail = lines.slice(-8).join('\n');

  if (/Do you want to .+\?/.test(tail)) return 'waiting';
  if (tail.includes('Would you like to proceed')) return 'waiting';
  // Claude Code tool permission prompts (Allow/Deny buttons, Yes/No)
  if (/\bAllow\b.*\bDeny\b/.test(tail)) return 'waiting';
  if (/\bYes\b.*\bNo\b/.test(tail)) return 'waiting';
  if (/Esc to cancel/i.test(tail)) return 'waiting';
  // Interactive selection prompts (fzf, inquirer, Claude Code menus)
  if (/enter to select/i.test(tail)) return 'waiting';
  if (/arrow keys/i.test(tail)) return 'waiting';
  if (/use the arrows/i.test(tail)) return 'waiting';
  // Token counters also contain ↑ and ↓; only paired navigation hints
  // indicate a selection prompt.
  if (/↑\s*↓|↓\s*↑/.test(tail)) return 'waiting';
  return 'idle';
}

export type InputState = 'active' | 'idle' | 'waiting';

/** Recheck every output frame, including while waiting: Claude can keep the
 * same title when a prompt disappears or background agents resume. */
export function classifyOutput(title: string, output: string): InputState {
  const visibleTail = output.slice(-4000)
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\([A-Z]/g, '')
    .replace(/\x1b[>=][0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b[\x20-\x2F]*[\x30-\x7E]/g, '');
  return classifyFromTitle(title, visibleTail);
}
