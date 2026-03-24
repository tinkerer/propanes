import { signal } from '@preact/signals';
import { useRef, useEffect } from 'preact/hooks';

interface TranscriptSegment {
  text: string;
  timestamp: number;
  isFinal: boolean;
}

interface InteractionEvent {
  type: string;
  timestamp: number;
  target: {
    tagName: string;
    id: string;
    classes: string[];
    textContent: string;
    selector: string;
  };
  details?: Record<string, unknown>;
}

interface ConsoleEntry {
  level: string;
  timestamp: number;
  args: string[];
}

interface VoicePlaybackProps {
  audioUrl: string;
  duration: number;
  transcript: TranscriptSegment[];
  interactions: InteractionEvent[];
  consoleLogs: ConsoleEntry[];
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

const TYPE_COLORS: Record<string, string> = {
  click: '#60a5fa',
  scroll: '#a78bfa',
  input: '#34d399',
  focus: '#fbbf24',
  navigation: '#f87171',
};

const CONSOLE_COLORS: Record<string, string> = {
  error: '#f87171',
  warn: '#fbbf24',
  info: '#60a5fa',
  log: '#94a3b8',
  debug: '#a78bfa',
};

export function VoicePlayback({ audioUrl, duration, transcript, interactions, consoleLogs }: VoicePlaybackProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const currentTime = signal(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handler = () => { currentTime.value = audio.currentTime * 1000; };
    audio.addEventListener('timeupdate', handler);
    return () => audio.removeEventListener('timeupdate', handler);
  }, []);

  const seekTo = (ms: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = ms / 1000;
      audioRef.current.play();
    }
  };

  const isActive = (timestamp: number, windowMs = 2000) => {
    const t = currentTime.value;
    return t >= timestamp && t < timestamp + windowMs;
  };

  return (
    <div class="voice-playback">
      <audio ref={audioRef} controls src={audioUrl} style="width:100%;margin-bottom:12px" />

      {transcript.length > 0 && (
        <div class="voice-section">
          <h5 style="margin:0 0 6px;font-size:12px;color:var(--pw-text-faint)">Transcript</h5>
          <div style="display:flex;flex-wrap:wrap;gap:4px">
            {transcript.map((seg, i) => (
              <span
                key={i}
                class={`voice-segment ${isActive(seg.timestamp) ? 'active' : ''}`}
                onClick={() => seekTo(seg.timestamp)}
                title={formatTime(seg.timestamp)}
              >
                <span class="voice-segment-time">{formatTime(seg.timestamp)}</span>
                {seg.text}
              </span>
            ))}
          </div>
        </div>
      )}

      {interactions.length > 0 && (
        <div class="voice-section">
          <h5 style="margin:0 0 6px;font-size:12px;color:var(--pw-text-faint)">Interactions ({interactions.length})</h5>
          <div style="max-height:200px;overflow-y:auto">
            {interactions.map((evt, i) => (
              <div
                key={i}
                class={`voice-event ${isActive(evt.timestamp) ? 'active' : ''}`}
                onClick={() => seekTo(evt.timestamp)}
              >
                <span class="voice-event-time">{formatTime(evt.timestamp)}</span>
                <span
                  class="voice-event-badge"
                  style={`background:${TYPE_COLORS[evt.type] || '#64748b'}20;color:${TYPE_COLORS[evt.type] || '#64748b'}`}
                >
                  {evt.type}
                </span>
                <span class="voice-event-target">
                  {evt.target.tagName}
                  {evt.target.id ? `#${evt.target.id}` : ''}
                  {evt.target.textContent ? ` "${evt.target.textContent.slice(0, 40)}"` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {consoleLogs.length > 0 && (
        <div class="voice-section">
          <h5 style="margin:0 0 6px;font-size:12px;color:var(--pw-text-faint)">Console ({consoleLogs.length})</h5>
          <div style="max-height:200px;overflow-y:auto">
            {consoleLogs.map((entry, i) => (
              <div
                key={i}
                class={`voice-console-entry ${isActive(entry.timestamp) ? 'active' : ''}`}
                onClick={() => seekTo(entry.timestamp)}
                style={`color:${CONSOLE_COLORS[entry.level] || '#94a3b8'}`}
              >
                <span class="voice-event-time">{formatTime(entry.timestamp)}</span>
                <span class="voice-console-level">[{entry.level}]</span>
                <span class="voice-console-msg">{entry.args.join(' ').slice(0, 200)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
