/**
 * Voice transcript classifier.
 *
 * Given a rolling transcript window, decide whether it contains an
 * actionable dev idea that's worth spinning up an agent for. The
 * classifier is pluggable so tests can stub it; the default is a
 * lightweight heuristic that works without an API key.
 */

export interface VoiceClassificationInput {
  /** Concatenated transcript text for the window being classified. */
  text: string;
  /** Previous window's text, if any, for short context. */
  previousText?: string;
  /** App context the user is working against. */
  appId?: string | null;
  sourceUrl?: string | null;
}

export interface VoiceClassificationResult {
  actionable: boolean;
  /** Short imperative title suitable for a feedback item. */
  title: string;
  /** Longer description, typically echoing the ask in the user's words. */
  description: string;
  /** Why the classifier decided this. Shown in logs / debug. */
  reason: string;
  /** Optional tags to attach beyond the default voice-captured tag. */
  tags?: string[];
}

export type VoiceClassifier = (
  input: VoiceClassificationInput
) => Promise<VoiceClassificationResult>;

const ACTION_VERBS = [
  'add', 'build', 'fix', 'change', 'update', 'remove', 'rename',
  'make', 'create', 'refactor', 'let me', 'can you', 'we should',
  'please', 'need to', 'should be able', 'i want', 'wire up',
  'show', 'hide', 'implement',
];

const NON_ACTION_MARKERS = [
  'i think', 'maybe', 'hmm', 'um', 'huh',
];

function heuristicClassifier(
  input: VoiceClassificationInput
): VoiceClassificationResult {
  const trimmed = input.text.trim();
  if (trimmed.length < 30) {
    return {
      actionable: false,
      title: '',
      description: trimmed,
      reason: 'too-short',
    };
  }

  const lower = trimmed.toLowerCase();
  const hasVerb = ACTION_VERBS.some((v) => lower.includes(v));
  const hasNonActionOnly = !hasVerb &&
    NON_ACTION_MARKERS.some((m) => lower.startsWith(m));

  if (!hasVerb || hasNonActionOnly) {
    return {
      actionable: false,
      title: '',
      description: trimmed,
      reason: hasVerb ? 'hedged' : 'no-action-verb',
    };
  }

  // Cheap title extraction: first sentence or first 80 chars.
  const firstSentence = trimmed.split(/[.!?]\s+/)[0] || trimmed;
  const title = (firstSentence.length > 80
    ? firstSentence.slice(0, 77) + '...'
    : firstSentence).replace(/^(can you|please|let me|i want to?|we should)\s+/i, '');

  return {
    actionable: true,
    title: title.charAt(0).toUpperCase() + title.slice(1),
    description: trimmed,
    reason: 'heuristic-action-verb',
  };
}

let currentClassifier: VoiceClassifier = async (input) => heuristicClassifier(input);

export function setVoiceClassifier(fn: VoiceClassifier): void {
  currentClassifier = fn;
}

export function resetVoiceClassifier(): void {
  currentClassifier = async (input) => heuristicClassifier(input);
}

export async function classifyVoiceWindow(
  input: VoiceClassificationInput
): Promise<VoiceClassificationResult> {
  return currentClassifier(input);
}
