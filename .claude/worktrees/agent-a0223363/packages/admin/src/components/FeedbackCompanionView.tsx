import { selectedAppId } from '../lib/state.js';

export function FeedbackCompanionView({ feedbackId }: { feedbackId: string }) {
  const appId = selectedAppId.value;
  const route = appId
    ? `/app/${appId}/feedback/${feedbackId}`
    : `/feedback/${feedbackId}`;
  const src = `/admin/?companion=true#${route}`;

  return (
    <iframe
      src={src}
      class="companion-iframe"
      style="width:100%;height:100%;border:none;flex:1"
    />
  );
}
