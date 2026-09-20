import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranscriptStream } from '../../lib/transcript-stream.js';
import { jsonlToCosMessages } from '../../lib/jsonl-to-cos.js';

/** Dispatched Inbox threads may have replies only in their session transcript.
 * Fetch once when the summary enters view, not one polling stream per thread. */
export function SessionReplySummary({ sessionId, onOpen }: { sessionId: string; onOpen?: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [sessionId]);
  const { messages, loading } = useTranscriptStream(visible ? sessionId : '', { pollMs: 0 });
  const conversation = jsonlToCosMessages(messages).filter(message => message.text?.trim());
  const count = Math.max(0, conversation.length - (conversation[0]?.role === 'user' ? 1 : 0));
  return <button ref={ref} type="button" class="cos-thread-summary" onClick={onOpen} aria-label="Open conversation replies">
    <span class="cos-thread-summary-count">{loading ? 'View replies…' : count ? `${count} ${count === 1 ? 'reply' : 'replies'}` : 'View conversation'}</span>
    <span class="cos-thread-summary-hint">View in panel →</span>
  </button>;
}
