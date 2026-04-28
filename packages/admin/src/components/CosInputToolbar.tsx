import { type RefObject } from 'preact';

export type ScreenshotMethod = 'display-media' | 'html-to-image';

/**
 * Bottom toolbar of the composer: camera (with screenshot options menu) +
 * element picker (with picker options menu) + mic recording + send.
 *
 * All state is owned by the bubble; this component is presentational. It
 * pre-positions the dropdown menus using the toolbar group refs so the
 * popover anchors to the right button even when the bubble is in a popout
 * window with non-default scroll/zoom.
 */
export function CosInputToolbar({
  // refs
  cameraGroupRef,
  pickerGroupRef,
  // screenshot
  capturingScreenshot,
  captureAndAttachScreenshot,
  startTimedScreenshot,
  cameraMenuOpen,
  setCameraMenuOpen,
  cameraMenuPos,
  setCameraMenuPos,
  screenshotExcludeWidget,
  setScreenshotExcludeWidget,
  screenshotExcludeCursor,
  setScreenshotExcludeCursor,
  screenshotMethod,
  setScreenshotMethod,
  screenshotKeepStream,
  setScreenshotKeepStream,
  // element picker
  pickerActive,
  startElementPick,
  pickerMenuOpen,
  setPickerMenuOpen,
  pickerMenuPos,
  setPickerMenuPos,
  pickerMultiSelect,
  setPickerMultiSelect,
  pickerIncludeChildren,
  setPickerIncludeChildren,
  // mic
  micRecording,
  micElapsed,
  micInterim,
  toggleMicRecord,
  // send
  canSend,
  onSubmit,
}: {
  cameraGroupRef: RefObject<HTMLDivElement>;
  pickerGroupRef: RefObject<HTMLDivElement>;
  capturingScreenshot: boolean;
  captureAndAttachScreenshot: () => void | Promise<void>;
  startTimedScreenshot: (seconds: number) => void | Promise<void>;
  cameraMenuOpen: boolean;
  setCameraMenuOpen: (updater: boolean | ((v: boolean) => boolean)) => void;
  cameraMenuPos: { top: number; left: number } | null;
  setCameraMenuPos: (v: { top: number; left: number } | null) => void;
  screenshotExcludeWidget: boolean;
  setScreenshotExcludeWidget: (v: boolean) => void;
  screenshotExcludeCursor: boolean;
  setScreenshotExcludeCursor: (v: boolean) => void;
  screenshotMethod: ScreenshotMethod;
  setScreenshotMethod: (v: ScreenshotMethod) => void;
  screenshotKeepStream: boolean;
  setScreenshotKeepStream: (v: boolean) => void;
  pickerActive: boolean;
  startElementPick: () => void;
  pickerMenuOpen: boolean;
  setPickerMenuOpen: (updater: boolean | ((v: boolean) => boolean)) => void;
  pickerMenuPos: { top: number; left: number } | null;
  setPickerMenuPos: (v: { top: number; left: number } | null) => void;
  pickerMultiSelect: boolean;
  setPickerMultiSelect: (v: boolean) => void;
  pickerIncludeChildren: boolean;
  setPickerIncludeChildren: (v: boolean) => void;
  micRecording: boolean;
  micElapsed: number;
  micInterim: string;
  toggleMicRecord: () => void | Promise<void>;
  canSend: boolean;
  onSubmit: () => void;
}) {
  return (
    <div class="cos-input-toolbar">
      <div class="cos-tool-group" ref={cameraGroupRef}>
        <button
          type="button"
          class={`cos-tool-btn cos-tool-btn-main${capturingScreenshot ? ' loading' : ''}`}
          onClick={() => { void captureAndAttachScreenshot(); }}
          disabled={capturingScreenshot}
          title="Capture screenshot of this page"
          aria-label="Capture screenshot"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </button>
        <button
          type="button"
          class="cos-tool-dropdown-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setPickerMenuOpen(false);
            const r = cameraGroupRef.current?.getBoundingClientRect();
            if (r) setCameraMenuPos({ top: r.top - 4, left: r.left });
            setCameraMenuOpen((v) => !v);
          }}
          title="Screenshot options"
          aria-label="Screenshot options"
          aria-expanded={cameraMenuOpen}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z" /></svg>
        </button>
        {cameraMenuOpen && (
          <div class="cos-tool-menu" style={cameraMenuPos ? { top: `${cameraMenuPos.top}px`, left: `${cameraMenuPos.left}px`, transform: 'translateY(-100%)' } : undefined}>
            <label class="cos-tool-menu-item">
              <input
                type="checkbox"
                checked={screenshotExcludeWidget}
                onChange={(e) => setScreenshotExcludeWidget((e.target as HTMLInputElement).checked)}
              />
              Exclude widget
            </label>
            <label class="cos-tool-menu-item">
              <input
                type="checkbox"
                checked={screenshotExcludeCursor}
                onChange={(e) => setScreenshotExcludeCursor((e.target as HTMLInputElement).checked)}
              />
              Exclude cursor
            </label>
            <label class="cos-tool-menu-item">
              <input
                type="checkbox"
                checked={screenshotMethod === 'html-to-image'}
                onChange={(e) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  setScreenshotMethod(checked ? 'html-to-image' : 'display-media');
                  if (checked) setScreenshotKeepStream(false);
                }}
              />
              html-to-image
            </label>
            <label class={`cos-tool-menu-item${screenshotMethod === 'html-to-image' ? ' disabled' : ''}`}>
              <input
                type="checkbox"
                checked={screenshotKeepStream}
                disabled={screenshotMethod === 'html-to-image'}
                onChange={(e) => setScreenshotKeepStream((e.target as HTMLInputElement).checked)}
              />
              Multi-screenshot
            </label>
            <div class="cos-tool-menu-divider" />
            <button
              type="button"
              class="cos-tool-menu-item cos-tool-menu-btn"
              onClick={() => { void startTimedScreenshot(3); }}
              disabled={capturingScreenshot}
            >
              Timed (3s)
            </button>
          </div>
        )}
      </div>
      <div class="cos-tool-group" ref={pickerGroupRef}>
        <button
          type="button"
          class={`cos-tool-btn cos-tool-btn-main${pickerActive ? ' active' : ''}`}
          onClick={startElementPick}
          title={pickerActive ? 'Cancel element picker (Esc)' : 'Pick a DOM element'}
          aria-label="Pick element"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13 2l7 19-7-4-4 7z" />
          </svg>
        </button>
        <button
          type="button"
          class="cos-tool-dropdown-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setCameraMenuOpen(false);
            const r = pickerGroupRef.current?.getBoundingClientRect();
            if (r) setPickerMenuPos({ top: r.top - 4, left: r.left });
            setPickerMenuOpen((v) => !v);
          }}
          title="Picker options"
          aria-label="Picker options"
          aria-expanded={pickerMenuOpen}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z" /></svg>
        </button>
        {pickerMenuOpen && (
          <div class="cos-tool-menu" style={pickerMenuPos ? { top: `${pickerMenuPos.top}px`, left: `${pickerMenuPos.left}px`, transform: 'translateY(-100%)' } : undefined}>
            <label class="cos-tool-menu-item">
              <input
                type="checkbox"
                checked={pickerMultiSelect}
                onChange={(e) => setPickerMultiSelect((e.target as HTMLInputElement).checked)}
              />
              Multi-select
            </label>
            <label class="cos-tool-menu-item">
              <input
                type="checkbox"
                checked={pickerIncludeChildren}
                onChange={(e) => setPickerIncludeChildren((e.target as HTMLInputElement).checked)}
              />
              Include children
            </label>
          </div>
        )}
      </div>
      <button
        type="button"
        class={`cos-tool-btn${micRecording ? ' active' : ''}`}
        onClick={() => { void toggleMicRecord(); }}
        title={micRecording ? `Stop recording (${micElapsed}s)` : 'Record voice input'}
        aria-label={micRecording ? 'Stop recording' : 'Record voice input'}
        aria-pressed={micRecording}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
      </button>
      {micRecording && (
        <span
          class="cos-mic-elapsed"
          title={micInterim || undefined}
          aria-live="polite"
        >
          {micInterim
            ? (micInterim.length > 24 ? '…' + micInterim.slice(-24) : micInterim)
            : `${micElapsed}s`}
        </span>
      )}
      <div class="cos-input-toolbar-spacer" />
      <button
        class="cos-send"
        onClick={onSubmit}
        disabled={!canSend}
        title="Send (Enter)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12l14-7-7 14-2-5z" />
        </svg>
      </button>
    </div>
  );
}
