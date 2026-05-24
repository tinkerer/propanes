export function stripTerminalControl(data: string): string {
  return data
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\([A-Z]/g, '')
    .replace(/\x1b[>=][0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b[\x20-\x2F]*[\x30-\x7E]/g, '');
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
