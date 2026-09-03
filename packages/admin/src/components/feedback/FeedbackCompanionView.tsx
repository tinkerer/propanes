import { selectedAppId } from '../../lib/state.js';
import { serverPath } from '../../lib/base-path.js';

export function FeedbackCompanionView({ feedbackId }: { feedbackId: string }) {
  const appId = selectedAppId.value;
  const route = appId
    ? `/app/${appId}/tickets/${feedbackId}`
    : `/tickets/${feedbackId}`;
  // serverPath(): an iframe src does not go through the fetch/WebSocket/
  // EventSource patches in base-path.ts, so under a prefixed mount a bare
  // '/admin/' loads the HOST app's page instead of ours.
  const src = `${serverPath('/admin/')}?companion=true#${route}`;

  return (
    <iframe
      src={src}
      class="companion-iframe"
      style="width:100%;height:100%;border:none;flex:1"
    />
  );
}
