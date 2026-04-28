// Shared label/color tables for the Wiggum learnings drawer.
// Both the list+graph view (LearningsDrawer) and the detail view
// (LearningDetail) consume these — keeping them in one module avoids drift
// and breaks the would-be circular import between the two component files.

import type { CosLearning, CosLearningRelType } from './cos-learnings.js';

export type LearningsView = 'list' | 'graph';

export const LEARNING_TYPE_LABELS: Record<CosLearning['type'], string> = {
  pitfall: 'Pitfalls',
  suggestion: 'Suggestions',
  tool_gap: 'Tool gaps',
};

export const LEARNING_TYPE_ORDER: CosLearning['type'][] = ['pitfall', 'suggestion', 'tool_gap'];

export const LEARNING_TYPE_COLOR: Record<CosLearning['type'], string> = {
  pitfall: '#e5484d',
  suggestion: '#3e63dd',
  tool_gap: '#d97706',
};

export const REL_TYPE_LABELS: Record<CosLearningRelType, string> = {
  related: 'related',
  caused_by: 'caused by',
  resolved_by: 'resolved by',
  duplicate_of: 'duplicate of',
};

export const REL_TYPE_COLOR: Record<CosLearningRelType, string> = {
  related: '#9ca3af',
  caused_by: '#e5484d',
  resolved_by: '#22c55e',
  duplicate_of: '#a855f7',
};
