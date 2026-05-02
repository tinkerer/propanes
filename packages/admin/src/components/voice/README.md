# `components/voice/`

Playback + diagnostic trace for voice-recorded feedback (recorded by `widget/voice-recorder`).

| File | Role | Key export | Mounted by |
|------|------|------------|------------|
| `VoicePlayback.tsx:60` | Audio player with clickable transcript segments and an event/console timeline overlaid on the seek bar | `VoicePlayback` | feedback detail page |
| `VoiceTracePanel.tsx:32` | Pipeline trace: rolling-window transcribe → per-chunk classify (heuristic + Claude haiku) → suggest. Shows reason/duration/linked feedback per chunk | `VoiceTracePanel` | feedback detail page |

## Notes

- `VoicePlayback` syncs a `currentTime` signal with the audio element's `timeupdate` and
  highlights any transcript segment within a 2s window of the current position.
- `VoiceTracePanel` fetches the trace from `/api/v1/feedback/.../voice-trace` and renders the
  three pipeline steps inline so an operator can see *why* a window became (or didn't become)
  a feedback item.
- Voice classification is documented server-side in `packages/server/src/voice/`.
