import { LearningsPanel } from './LearningsDrawer.js';
import { ThreadPanel } from './CosThreadPanel.js';
import { DEFAULT_VERBOSITY, type ChiefOfStaffVerbosity } from '../lib/chief-of-staff.js';
import { cosActiveThread } from '../lib/cos-popout-tree.js';

/**
 * Fixed-position side drawers that hover over the CoS pane in `mode='pane'`.
 *
 * In `mode='popout'` the learnings and thread panels live as tabs inside the
 * popout-local CosPopoutTreeView, so these drawers don't render. They only
 * matter when CoS is docked into the main pane tree, where there's no
 * popout-local splitter to anchor them.
 *
 * The parent computes the geometry (left/top/width/height/zIndex/side)
 * elsewhere, so the heuristics for picking which side stays out of this
 * file — these components are pure JSX shells.
 */
export type CosDrawerStyle = {
  position: 'fixed';
  top: number;
  height: number;
  left: number;
  width: number;
  zIndex: number;
  side: 'left' | 'right';
};

export function CosLearningsDrawer({
  style,
  setLearningsSide,
  onClose,
}: {
  style: CosDrawerStyle;
  setLearningsSide: (side: 'left' | 'right') => void;
  onClose: () => void;
}) {
  return (
    <div
      class={`cos-learnings-side cos-learnings-side-${style.side}`}
      style={{
        position: style.position,
        top: style.top,
        left: style.left,
        width: style.width,
        height: style.height,
        zIndex: style.zIndex,
      }}
    >
      <div class="cos-learnings-side-controls">
        <button
          type="button"
          class="cos-link-btn"
          onClick={() => setLearningsSide(style.side === 'left' ? 'right' : 'left')}
          title={`Move to ${style.side === 'left' ? 'right' : 'left'}`}
          aria-label="Flip drawer side"
        >
          {style.side === 'left' ? '→' : '←'}
        </button>
      </div>
      <LearningsPanel onClose={onClose} />
    </div>
  );
}

export function CosThreadDrawer({
  style,
  agentId,
  showTools,
  verbosity,
  onArtifactPopout,
  onReply,
  onClose,
}: {
  style: CosDrawerStyle;
  agentId: string;
  showTools: boolean;
  verbosity?: ChiefOfStaffVerbosity;
  onArtifactPopout: (artifactId: string) => void;
  onReply: (role: string, text: string, anchorTs?: number, threadServerId?: string | null) => void;
  onClose: () => void;
}) {
  return (
    <div
      class={`cos-thread-side cos-thread-side-${style.side}`}
      style={{
        position: style.position,
        top: style.top,
        left: style.left,
        width: style.width,
        height: style.height,
        zIndex: style.zIndex,
      }}
    >
      <ThreadPanel
        agentId={agentId}
        showTools={showTools}
        verbosity={verbosity || DEFAULT_VERBOSITY}
        onArtifactPopout={onArtifactPopout}
        onReply={onReply}
        onClose={() => {
          onClose();
          cosActiveThread.value = null;
        }}
      />
    </div>
  );
}
