export function stripTerminalControl(data: string): string {
  return data
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\([A-Z]/g, '')
    .replace(/\x1b[>=][0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b[\x20-\x2F]*[\x30-\x7E]/g, '');
}

// Detect Claude Code's first-run "trust this folder" safety prompt.
// This appears *before* Claude emits a ✳ idle OSC title, so the normal
// title-based classifier (classifyFromTitle) misses it and the session
// stays stuck at 'active' instead of surfacing as waiting-for-input.
//
// IMPORTANT: Ink renders the box content by positioning each word with
// cursor-move escape sequences rather than literal spaces, so once
// stripTerminalControl removes those sequences the inter-word whitespace is
// gone — "Yes, I trust this folder" collapses to "Yes,Itrustthisfolder".
// Patterns therefore use \s* (not \s+) so they still match the de-spaced text,
// and we key off "quick safety check" too to cover the current wording.
export function detectClaudeTrustPrompt(output: string): boolean {
  const visible = stripTerminalControl(output).slice(-4000);
  return [
    /yes,?\s*i\s*trust\s*this\s*folder/i,
    /do\s*you\s*trust\s*the\s*files\s*in\s*this\s*folder/i,
    /quick\s*safety\s*check/i,
  ].some((pattern) => pattern.test(visible));
}

export function detectClaudeAuthRequired(output: string): boolean {
  const visible = stripTerminalControl(output).slice(-8000);
  return [
    /not\s+(?:logged|signed)\s+in/i,
    /(?:log|sign)\s+in\s+to\s+(?:claude|anthropic)/i,
    /(?:login|sign in)\s+required/i,
    /please\s+(?:run\s+)?(?:\/login|claude\s+(?:auth\s+)?login)/i,
    /run\s+claude\s+(?:auth\s+)?login/i,
    /claude(?:\s+code)?\s+requires\s+(?:login|authentication)/i,
    /authentication\s+(?:required|failed).*claude/i,
    /invalid\s+(?:api\s+)?key.*(?:anthropic|claude)/i,
  ].some((pattern) => pattern.test(visible));
}
