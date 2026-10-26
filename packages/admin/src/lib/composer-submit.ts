/** Enter can send to a running process, but must never restart a stopped one.
 * Ignore IME confirmation and key repeats so they do not submit accidentally.
 */
export function composerEnterAction(
  event: { key: string; shiftKey: boolean; isComposing: boolean; repeat: boolean },
  isRunning: boolean,
): 'send' | 'explicit-resume-required' | null {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.repeat) return null;
  return isRunning ? 'send' : 'explicit-resume-required';
}

/** Programmatic .click()/dispatchEvent must not restart a stopped session. */
export function canExplicitlyResume(event: { isTrusted: boolean }): boolean {
  return event.isTrusted;
}
