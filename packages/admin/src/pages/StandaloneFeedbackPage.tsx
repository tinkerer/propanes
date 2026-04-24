import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { FeedbackDetailPage } from './FeedbackDetailPage.js';
import { api } from '../lib/api.js';
import { applyTheme } from '../lib/settings.js';
import { selectedAppId } from '../lib/state.js';

export function StandaloneFeedbackPage({ feedbackId }: { feedbackId: string }) {
  const appId = useSignal<string | null>(selectedAppId.value);
  const loading = useSignal(true);
  const error = useSignal<string | null>(null);

  useEffect(() => { applyTheme(); }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fb = await api.getFeedbackById(feedbackId);
        if (cancelled) return;
        if (fb?.appId) {
          appId.value = fb.appId;
          selectedAppId.value = fb.appId;
        }
      } catch (err: any) {
        if (!cancelled) error.value = err?.message || 'Failed to load feedback';
      } finally {
        if (!cancelled) loading.value = false;
      }
    })();
    return () => { cancelled = true; };
  }, [feedbackId]);

  useEffect(() => {
    document.title = `Feedback ${feedbackId.slice(-6)}`;
  }, [feedbackId]);

  if (loading.value) {
    return (
      <div class="standalone-session-root" style={{ background: 'var(--pw-bg)', color: 'var(--pw-text)', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--pw-text-muted)' }}>Loading feedback…</div>
      </div>
    );
  }

  if (error.value) {
    return (
      <div class="standalone-session-root" style={{ background: 'var(--pw-bg)', color: 'var(--pw-text)', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--pw-error, #c33)' }}>{error.value}</div>
      </div>
    );
  }

  return (
    <div class="standalone-session-root" style={{ background: 'var(--pw-bg)', color: 'var(--pw-text)', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <FeedbackDetailPage id={feedbackId} appId={appId.value} embedded />
    </div>
  );
}
