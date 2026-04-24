export const WIDGET_CSS = `
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  color: #e2e8f0;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

.pw-trigger {
  position: fixed;
  z-index: 2147483647;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #1d9bf0;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(29, 155, 240, 0.4);
  transition: transform 0.2s, box-shadow 0.2s;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}

.pw-trigger:hover {
  transform: scale(1.1);
  box-shadow: 0 6px 16px rgba(29, 155, 240, 0.5);
}

.pw-trigger svg {
  width: 24px;
  height: 24px;
  fill: white;
}

.pw-trigger.bottom-right { bottom: 20px; right: 20px; }
.pw-trigger.bottom-left { bottom: 20px; left: 20px; }
.pw-trigger.top-right { top: 20px; right: 20px; }
.pw-trigger.top-left { top: 20px; left: 20px; }

/* Mobile: the host app (e.g. the admin dashboard) typically has a fixed
   bottom tab bar. Raise the trigger above it and shrink it slightly. */
@media (max-width: 480px) {
  .pw-trigger { width: 40px; height: 40px; }
  .pw-trigger svg { width: 20px; height: 20px; }
  .pw-trigger.bottom-right { bottom: calc(env(safe-area-inset-bottom, 0px) + 72px); right: 12px; }
  .pw-trigger.bottom-left { bottom: calc(env(safe-area-inset-bottom, 0px) + 72px); left: 12px; }
}

.pw-trigger-dragging {
  transition: none !important;
  cursor: grabbing !important;
}

.pw-trigger-stowed {
  pointer-events: none;
  transition: right 0.3s ease-in, bottom 0.3s ease-in;
}

.pw-trigger-peek {
  pointer-events: auto;
  cursor: pointer;
  transition: right 0.3s ease-out, bottom 0.3s ease-out;
}

.pw-trigger-peek:hover {
  filter: brightness(1.2);
}

.pw-panel {
  position: fixed;
  z-index: 2147483647;
  width: 360px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 96px);
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(29, 155, 240, 0.08);
  display: flex;
  flex-direction: column;
  overflow: visible;
  animation: pw-slide-in 0.2s ease-out;
}

.pw-panel.bottom-right { bottom: 80px; right: 20px; }
.pw-panel.bottom-left { bottom: 80px; left: 20px; }
.pw-panel.top-right { top: 80px; right: 20px; }
.pw-panel.top-left { top: 80px; left: 20px; }

/* Narrow viewports (mobile): clamp the panel to nearly the whole width so
   the toolbar's many buttons (camera, picker, context, mic, admin, send)
   stay reachable instead of overflowing off-screen. */
@media (max-width: 480px) {
  .pw-panel {
    width: calc(100vw - 16px);
    max-width: calc(100vw - 16px);
    /* Drop the panel closer to the edge so the whole thing fits above the
       host app's bottom tab bar + keyboard on iOS. The trigger is hidden
       while the panel is open (see .pw-trigger-hidden), so we can reclaim
       the 80px gap that existed to avoid the trigger. */
    max-height: calc(100dvh - 24px);
  }
  .pw-panel.bottom-right, .pw-panel.bottom-left {
    bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
  }
  .pw-panel.top-right, .pw-panel.top-left {
    top: calc(env(safe-area-inset-top, 0px) + 12px);
  }
  .pw-panel.bottom-right, .pw-panel.top-right { right: 8px; }
  .pw-panel.bottom-left, .pw-panel.top-left { left: 8px; }
}

/* The trigger is hidden behind the panel on mobile, so hide it while the
   panel is open — the pw-close-btn in the panel's top-right is used to
   dismiss instead. */
.pw-trigger-hidden { display: none !important; }

.pw-close-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: rgba(15, 23, 42, 0.6);
  color: #e2e8f0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  z-index: 2;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s, color 0.15s;
}

.pw-close-btn:hover {
  background: #334155;
  color: #fff;
}

.pw-close-btn svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

@media (max-width: 480px) {
  .pw-close-btn { width: 34px; height: 34px; top: 4px; right: 4px; }
  .pw-close-btn svg { width: 20px; height: 20px; }
}

@keyframes pw-slide-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.pw-resize-handle {
  position: absolute;
  width: 20px;
  height: 20px;
  z-index: 1;
  border-radius: 0;
  transition: border-color 0.15s;
}

.pw-panel.bottom-right .pw-resize-handle {
  top: -1px; left: -1px;
  cursor: nw-resize;
  border-top: 3px solid transparent;
  border-left: 3px solid transparent;
  border-top-left-radius: 14px;
}
.pw-panel.bottom-right .pw-resize-handle:hover {
  border-top-color: #1d9bf0;
  border-left-color: #1d9bf0;
}

.pw-panel.bottom-left .pw-resize-handle {
  top: -1px; right: -1px;
  cursor: ne-resize;
  border-top: 3px solid transparent;
  border-right: 3px solid transparent;
  border-top-right-radius: 14px;
}
.pw-panel.bottom-left .pw-resize-handle:hover {
  border-top-color: #1d9bf0;
  border-right-color: #1d9bf0;
}

.pw-panel.top-right .pw-resize-handle {
  bottom: -1px; left: -1px;
  cursor: sw-resize;
  border-bottom: 3px solid transparent;
  border-left: 3px solid transparent;
  border-bottom-left-radius: 14px;
}
.pw-panel.top-right .pw-resize-handle:hover {
  border-bottom-color: #1d9bf0;
  border-left-color: #1d9bf0;
}

.pw-panel.top-left .pw-resize-handle {
  bottom: -1px; right: -1px;
  cursor: se-resize;
  border-bottom: 3px solid transparent;
  border-right: 3px solid transparent;
  border-bottom-right-radius: 14px;
}
.pw-panel.top-left .pw-resize-handle:hover {
  border-bottom-color: #1d9bf0;
  border-right-color: #1d9bf0;
}

.pw-screenshots {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 10px 0;
}

.pw-screenshot-wrap {
  position: relative;
  width: 40px;
  height: 40px;
}

.pw-screenshot-thumb {
  width: 40px;
  height: 40px;
  border-radius: 4px;
  object-fit: cover;
  border: 1px solid #334155;
  cursor: pointer;
}

.pw-screenshot-thumb:hover {
  border-color: #1d9bf0;
}

.pw-screenshot-remove {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #dc2626;
  color: white;
  border: 1px solid #1e293b;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.pw-screenshot-remove:hover {
  background: #b91c1c;
}

.pw-screenshot-copy-paths {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 40px;
  padding: 0 10px;
  border-radius: 4px;
  border: 1px solid #334155;
  background: #0f172a;
  color: #94a3b8;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.pw-screenshot-copy-paths:hover {
  border-color: #1d9bf0;
  color: #e2e8f0;
}
.pw-screenshot-copy-paths:disabled {
  opacity: 0.6;
  cursor: default;
}
.pw-screenshot-copy-paths svg {
  width: 14px;
  height: 14px;
  fill: currentColor;
}

.pw-input-area {
  padding: 10px;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.pw-textarea {
  width: 100%;
  min-height: 40px;
  /* JS grows the height to fit content on input; cap so the toolbar never
     scrolls out of the panel on short viewports. */
  max-height: calc(100dvh - 220px);
  flex: 0 0 auto;
  padding: 10px 12px;
  border: 1px solid #334155;
  border-radius: 8px;
  background: #0f172a;
  color: #e2e8f0;
  /* 16px prevents iOS Safari from auto-zooming the page on focus, which
     otherwise disrupts typing on iPhone. */
  font-size: 16px;
  font-family: inherit;
  line-height: 1.5;
  outline: none;
  resize: none;
  overflow-y: auto;
  transition: border-color 0.15s, box-shadow 0.15s;
}

@media (min-width: 481px) {
  .pw-textarea { font-size: 13px; }
}

.pw-textarea::placeholder {
  color: #64748b;
}

.pw-textarea:focus {
  border-color: #1d9bf0;
  box-shadow: 0 0 0 2px rgba(29, 155, 240, 0.15);
}

.pw-context-group {
  display: flex;
  align-items: center;
  position: relative;
}

.pw-context-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: none;
  background: #334155;
  color: #94a3b8;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}

.pw-context-btn:hover {
  background: #475569;
  color: #e2e8f0;
}

.pw-context-btn svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.pw-context-group .pw-context-btn {
  border-radius: 6px 0 0 6px;
}

.pw-context-dropdown-toggle {
  height: 32px;
  width: 20px;
  border: none;
  border-left: 1px solid rgba(255,255,255,0.15);
  background: #334155;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 0 6px 6px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}

.pw-context-dropdown-toggle:hover {
  background: #475569;
  color: #e2e8f0;
}

.pw-context-dropdown-toggle svg {
  width: 12px;
  height: 12px;
  fill: currentColor;
}

.pw-context-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
  background: #1e1e2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 10;
  min-width: 130px;
  padding: 4px 0;
}

.pw-context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  color: #e2e8f0;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  white-space: nowrap;
}

.pw-context-menu-item:hover {
  background: rgba(29, 155, 240, 0.2);
}

.pw-context-menu-item input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border: 1px solid #475569;
  border-radius: 3px;
  background: #0f172a;
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
}

.pw-context-menu-item input[type="checkbox"]:checked {
  background: #1d9bf0;
  border-color: #1d9bf0;
}

.pw-context-menu-item input[type="checkbox"]:checked::after {
  content: '';
  position: absolute;
  top: 1px;
  left: 4px;
  width: 4px;
  height: 7px;
  border: solid white;
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

.pw-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  gap: 4px;
}

/* Narrow viewports: shrink every toolbar button so the whole row fits on one
   line. The panel clamps to ~calc(100vw - 16px), which is ~303px at a 319px
   viewport — six 32+20 groups plus gaps overflow to a second row there. */
@media (max-width: 400px) {
  .pw-toolbar { gap: 2px; }
  .pw-toolbar .pw-camera-btn,
  .pw-toolbar .pw-picker-btn,
  .pw-toolbar .pw-context-btn,
  .pw-toolbar .pw-mic-btn,
  .pw-toolbar .pw-admin-btn { width: 30px; height: 30px; }
  /* The send/dispatch button is the primary action — make it wider than
     the other toolbar icons so it's an obvious, easy tap target. */
  .pw-toolbar .pw-send-btn { width: 44px; height: 30px; padding: 0 8px; }
  .pw-toolbar .pw-camera-dropdown-toggle,
  .pw-toolbar .pw-picker-dropdown-toggle,
  .pw-toolbar .pw-context-dropdown-toggle,
  .pw-toolbar .pw-mic-dropdown-toggle,
  .pw-toolbar .pw-admin-dropdown-toggle { width: 14px; height: 30px; }
  .pw-toolbar .pw-send-dropdown-toggle { width: 20px; height: 30px; }
  .pw-toolbar .pw-camera-btn svg,
  .pw-toolbar .pw-picker-btn svg,
  .pw-toolbar .pw-context-btn svg,
  .pw-toolbar .pw-mic-btn svg,
  .pw-toolbar .pw-admin-btn svg,
  .pw-toolbar .pw-send-btn svg { width: 14px; height: 14px; }
}

.pw-camera-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: none;
  background: #334155;
  color: #94a3b8;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}

.pw-camera-btn:hover {
  background: #475569;
  color: #e2e8f0;
}

.pw-camera-btn svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.pw-picker-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: none;
  background: #334155;
  color: #94a3b8;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}

.pw-picker-btn:hover {
  background: #475569;
  color: #e2e8f0;
}

.pw-picker-btn svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.pw-selected-elements {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 8px 10px 0;
  max-height: 80px;
  overflow-y: auto;
}

.pw-selected-element {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  background: rgba(29, 155, 240, 0.1);
  border: 1px solid #1d9bf0;
  border-radius: 6px;
  font-size: 12px;
}

.pw-selected-element code {
  font-family: monospace;
  color: #bae6fd;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pw-selected-element-remove {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(255,255,255,0.1);
  color: #94a3b8;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.pw-selected-element-remove:hover {
  background: rgba(255,255,255,0.2);
  color: #e2e8f0;
}

.pw-picker-group {
  display: flex;
  align-items: center;
  position: relative;
}

.pw-picker-group .pw-picker-btn {
  border-radius: 6px 0 0 6px;
}

.pw-picker-dropdown-toggle {
  height: 32px;
  width: 20px;
  border: none;
  border-left: 1px solid rgba(255,255,255,0.15);
  background: #334155;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 0 6px 6px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}

.pw-picker-dropdown-toggle:hover {
  background: #475569;
  color: #e2e8f0;
}

.pw-picker-dropdown-toggle svg {
  width: 12px;
  height: 12px;
  fill: currentColor;
}

.pw-picker-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
  background: #1e1e2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 10;
  min-width: 130px;
  padding: 4px 0;
}

.pw-picker-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  color: #e2e8f0;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  white-space: nowrap;
}

.pw-picker-menu-item:hover {
  background: rgba(29, 155, 240, 0.2);
}

.pw-picker-menu-item input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border: 1px solid #475569;
  border-radius: 3px;
  background: #0f172a;
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
}

.pw-picker-menu-item input[type="checkbox"]:checked {
  background: #1d9bf0;
  border-color: #1d9bf0;
}

.pw-picker-menu-item input[type="checkbox"]:checked::after {
  content: '';
  position: absolute;
  top: 1px;
  left: 4px;
  width: 4px;
  height: 7px;
  border: solid white;
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

.pw-camera-group {
  display: flex;
  align-items: center;
  position: relative;
}

.pw-camera-group .pw-camera-btn {
  border-radius: 6px 0 0 6px;
}

.pw-camera-dropdown-toggle {
  height: 32px;
  width: 20px;
  border: none;
  border-left: 1px solid rgba(255,255,255,0.15);
  background: #334155;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 0 6px 6px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}

.pw-camera-dropdown-toggle:hover {
  background: #475569;
  color: #e2e8f0;
}

.pw-camera-dropdown-toggle svg {
  width: 12px;
  height: 12px;
  fill: currentColor;
}

.pw-camera-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
  background: #1e1e2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 10;
  min-width: 150px;
  padding: 4px 0;
}

.pw-camera-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  color: #e2e8f0;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  white-space: nowrap;
}

.pw-camera-menu-item:hover {
  background: rgba(29, 155, 240, 0.2);
}

.pw-camera-menu-item input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border: 1px solid #475569;
  border-radius: 3px;
  background: #0f172a;
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
}

.pw-camera-menu-item input[type="checkbox"]:checked {
  background: #1d9bf0;
  border-color: #1d9bf0;
}

.pw-camera-menu-item input[type="checkbox"]:checked::after {
  content: '';
  position: absolute;
  top: 1px;
  left: 4px;
  width: 4px;
  height: 7px;
  border: solid white;
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

.pw-camera-countdown {
  font-size: 13px;
  font-weight: 600;
  color: #f59e0b;
  font-variant-numeric: tabular-nums;
  min-width: 16px;
  text-align: center;
}

.pw-camera-menu-divider {
  height: 1px;
  background: rgba(255,255,255,0.08);
  margin: 2px 0;
}

.pw-camera-menu-btn {
  border: none;
  background: none;
  text-align: left;
}

.pw-send-group {
  display: flex;
  align-items: center;
  position: relative;
}

.pw-send-btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 6px;
  border: none;
  background: #1d9bf0;
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  transition: background 0.15s, transform 0.1s;
}

.pw-send-group .pw-send-btn {
  border-radius: 6px 0 0 6px;
}

.pw-send-btn:hover {
  background: #0f7ac7;
}

.pw-send-btn.pw-dispatch-active {
  background: #eab308;
}

.pw-send-btn.pw-dispatch-active:hover {
  background: #a16207;
}

.pw-send-btn:active {
  transform: scale(0.97);
}

.pw-send-btn svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.pw-send-dropdown-toggle {
  height: 32px;
  width: 24px;
  border: none;
  border-left: 1px solid rgba(255,255,255,0.25);
  background: #1d9bf0;
  color: white;
  cursor: pointer;
  border-radius: 0 6px 6px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s;
}

.pw-send-dropdown-toggle:hover {
  background: #0f7ac7;
}

.pw-send-dropdown-toggle.pw-dispatch-active {
  background: #eab308;
}

.pw-send-dropdown-toggle.pw-dispatch-active:hover {
  background: #a16207;
}

.pw-send-dropdown-toggle svg {
  width: 12px;
  height: 12px;
  fill: currentColor;
}

.pw-send-menu {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 4px;
  background: #1e1e2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 10;
  min-width: 160px;
  padding: 4px 0;
}

.pw-send-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: none;
  color: #e2e8f0;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  white-space: nowrap;
  text-align: left;
}

.pw-send-menu-item:hover {
  background: rgba(29, 155, 240, 0.2);
}

.pw-send-menu-item.pw-active {
  color: #93c5fd;
}

.pw-send-menu-item-yolo {
  color: #fbbf24;
  font-weight: 600;
}

.pw-send-menu-item-yolo:hover {
  background: rgba(251, 191, 36, 0.18);
}

.pw-send-menu-checkbox input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border: 1px solid #475569;
  border-radius: 3px;
  background: #0f172a;
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
}

.pw-send-menu-checkbox input[type="checkbox"]:checked {
  background: #1d9bf0;
  border-color: #1d9bf0;
}

.pw-send-menu-checkbox input[type="checkbox"]:checked::after {
  content: '';
  position: absolute;
  top: 1px;
  left: 4px;
  width: 4px;
  height: 7px;
  border: solid white;
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

.pw-send-menu-target {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
}
.pw-send-menu-target-select {
  flex: 1;
  font-size: 11px;
  padding: 3px 4px;
  background: #0f172a;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 4px;
  font-family: inherit;
  cursor: pointer;
  min-width: 0;
}
.pw-send-menu-target-select:hover {
  border-color: #1d9bf0;
}
.pw-send-menu-divider {
  height: 1px;
  background: rgba(255,255,255,0.08);
  margin: 2px 0;
}

.pw-flash {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #eab308;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  pointer-events: none;
}

.pw-flash svg {
  width: 28px;
  height: 28px;
  fill: #eab308;
}

.pw-flash-label {
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.pw-error {
  padding: 4px 10px 8px;
  color: #f87171;
  font-size: 12px;
}

.pw-hidden {
  display: none !important;
}

.pw-annotator {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  animation: pw-slide-in 0.15s ease-out;
}

.pw-admin-group {
  display: flex;
  align-items: center;
  position: relative;
}

.pw-admin-group .pw-admin-btn {
  border-radius: 6px 0 0 6px;
}

.pw-admin-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: none;
  background: #334155;
  color: #94a3b8;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}

.pw-admin-btn:hover {
  background: #475569;
  color: #e2e8f0;
}

.pw-admin-btn svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.pw-admin-dropdown-toggle {
  height: 32px;
  width: 20px;
  border: none;
  border-left: 1px solid rgba(255,255,255,0.15);
  background: #334155;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 0 6px 6px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}

.pw-admin-dropdown-toggle:hover {
  background: #475569;
  color: #e2e8f0;
}

.pw-admin-dropdown-toggle svg {
  width: 12px;
  height: 12px;
  fill: currentColor;
}

.pw-admin-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
  background: #1e1e2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 10;
  min-width: 140px;
  padding: 4px 0;
}

.pw-admin-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  color: #e2e8f0;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  white-space: nowrap;
}

.pw-admin-menu-item:hover {
  background: rgba(29, 155, 240, 0.2);
}

.pw-admin-menu-item input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border: 1px solid #475569;
  border-radius: 3px;
  background: #0f172a;
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
}

.pw-admin-menu-item input[type="checkbox"]:checked {
  background: #1d9bf0;
  border-color: #1d9bf0;
}

.pw-admin-menu-item input[type="checkbox"]:checked::after {
  content: '';
  position: absolute;
  top: 1px;
  left: 4px;
  width: 4px;
  height: 7px;
  border: solid white;
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

.pw-admin-options {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 10px 2px;
  border-top: 1px solid #334155;
  animation: pw-slide-in 0.12s ease-out;
}

.pw-admin-option {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid #334155;
  border-radius: 6px;
  background: #0f172a;
  color: #cbd5e1;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: background 0.15s, border-color 0.15s;
}

.pw-admin-option:hover {
  background: #334155;
  border-color: #1d9bf0;
  color: #f1f5f9;
}

.pw-admin-option-icon {
  font-size: 15px;
  line-height: 1;
}

/* Workbench button — primary action, full width */
.pw-workbench-btn {
  width: 100% !important;
  height: 32px !important;
  gap: 6px;
  border-color: #0f7ac7;
  background: linear-gradient(135deg, #0c4a6e, #1e3a8a);
}

.pw-workbench-btn:hover {
  background: linear-gradient(135deg, #1e3a8a, #1e40af);
  border-color: #60a5fa;
}

.pw-workbench-label {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.02em;
}

/* Smaller legacy panel buttons */
.pw-admin-more-row {
  display: flex;
  gap: 4px;
  width: 100%;
}

.pw-admin-option-small {
  width: 26px !important;
  height: 26px !important;
  opacity: 0.7;
}

.pw-admin-option-small:hover {
  opacity: 1;
}

.pw-append-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: #2563eb;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  border-radius: 14px 14px 0 0;
}
.pw-append-cancel {
  background: none;
  border: none;
  color: #fff;
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
  opacity: 0.7;
}
.pw-append-cancel:hover { opacity: 1; }

.pw-session-id-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  font-size: 11px;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s;
}

.pw-session-id-row:hover {
  background: #334155;
}

.pw-session-id-label {
  flex-shrink: 0;
}

.pw-session-id-value {
  font-family: monospace;
  font-size: 10px;
  color: #cbd5e1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pw-mic-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: none;
  background: #334155;
  color: #94a3b8;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}

.pw-mic-btn:hover {
  background: #475569;
  color: #e2e8f0;
}

.pw-mic-btn svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.pw-mic-recording {
  background: #dc2626 !important;
  color: #fff !important;
  animation: pw-pulse 1.5s ease-in-out infinite;
}

@keyframes pw-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.pw-voice-indicator {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  background: #1e3a5f;
  border-radius: 6px;
  font-size: 11px;
  color: #93c5fd;
  margin: 0 8px 4px;
}

.pw-voice-discard {
  background: none;
  border: none;
  color: #93c5fd;
  cursor: pointer;
  font-size: 16px;
  padding: 0 2px;
  line-height: 1;
}

.pw-voice-discard:hover {
  color: #f87171;
}

.pw-voice-transcript {
  padding: 2px 10px 4px;
  font-size: 11px;
  color: #94a3b8;
  font-style: italic;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Mic group + dropdown (mirrors camera group) */
.pw-mic-group {
  display: flex;
  align-items: center;
  position: relative;
}

.pw-mic-group .pw-mic-btn {
  border-radius: 6px 0 0 6px;
}

.pw-mic-dropdown-toggle {
  height: 32px;
  width: 20px;
  border: none;
  border-left: 1px solid rgba(255,255,255,0.15);
  background: #334155;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 0 6px 6px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}

.pw-mic-dropdown-toggle:hover {
  background: #475569;
  color: #e2e8f0;
}

.pw-mic-dropdown-toggle svg {
  width: 12px;
  height: 12px;
  fill: currentColor;
}

.pw-mic-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
  background: #1e1e2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 10;
  min-width: 160px;
  padding: 4px 0;
}

.pw-mic-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  color: #e2e8f0;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  white-space: nowrap;
}

.pw-mic-menu-item:hover {
  background: rgba(29, 155, 240, 0.2);
}

.pw-mic-menu-item input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border: 1px solid #475569;
  border-radius: 3px;
  background: #0f172a;
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
}

.pw-mic-menu-item input[type="checkbox"]:checked {
  background: #1d9bf0;
  border-color: #1d9bf0;
}

.pw-mic-menu-item input[type="checkbox"]:checked::after {
  content: '';
  position: absolute;
  top: 1px;
  left: 4px;
  width: 4px;
  height: 7px;
  border: solid white;
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

/* Panel recording mode */
.pw-panel-recording {
  max-height: 80vh;
}

.pw-panel-recording .pw-input-area {
  flex: 1;
  min-height: 0;
}

/* Timeline container */
.pw-timeline {
  width: 100%;
  min-height: 150px;
  max-height: 350px;
  overflow-y: auto;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 8px;
  flex: 1;
  padding: 6px 0;
}

.pw-timeline::-webkit-scrollbar {
  width: 4px;
}

.pw-timeline::-webkit-scrollbar-track {
  background: transparent;
}

.pw-timeline::-webkit-scrollbar-thumb {
  background: #475569;
  border-radius: 2px;
}

/* Timeline entries */
.pw-tl-entry {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 10px;
  animation: pw-tl-slide-in 0.15s ease-out;
  position: relative;
}

.pw-tl-entry:hover .pw-tl-remove {
  opacity: 1;
}

@keyframes pw-tl-slide-in {
  from { opacity: 0; transform: translateX(-8px); }
  to { opacity: 1; transform: translateX(0); }
}

.pw-tl-timestamp {
  width: 32px;
  flex-shrink: 0;
  font-family: monospace;
  font-size: 10px;
  color: #475569;
  padding-top: 1px;
}

.pw-tl-content {
  flex: 1;
  overflow: hidden;
  font-size: 12px;
  color: #e2e8f0;
  line-height: 1.4;
}

.pw-tl-remove {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: none;
  background: rgba(255,255,255,0.08);
  color: #94a3b8;
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  opacity: 0;
  flex-shrink: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}

.pw-tl-remove:hover {
  background: #dc2626;
  color: white;
}

/* Speech entries */
.pw-tl-speech .pw-tl-content {
  font-style: italic;
  color: #cbd5e1;
}

/* Interaction entries */
.pw-tl-interaction .pw-tl-content {
  font-family: monospace;
  font-size: 11px;
}

.pw-tl-badge {
  display: inline-block;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-right: 4px;
  vertical-align: middle;
}

/* Timeline badges — flame palette only, per DESIGN_SPEC.md. */
.pw-tl-badge-click { background: #3b82f6; color: white; }
.pw-tl-badge-scroll { background: #475569; color: white; }
.pw-tl-badge-input { background: #f59e0b; color: #1e293b; }
.pw-tl-badge-focus { background: #facc15; color: #1e293b; }
.pw-tl-badge-navigation { background: #dc2626; color: white; }
.pw-tl-badge-hover { background: #64748b; color: white; }

.pw-tl-selector {
  color: #93c5fd;
  word-break: break-all;
}

.pw-tl-text-preview {
  color: #64748b;
  font-style: italic;
  font-family: inherit;
  margin-left: 4px;
}

/* Console entries */
.pw-tl-console {
  border-left: 2px solid #475569;
  padding-left: 6px;
  margin-left: 2px;
}

.pw-tl-console .pw-tl-content {
  font-family: monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}

.pw-tl-console-error { border-left-color: #ef4444; }
.pw-tl-console-error .pw-tl-content { color: #fca5a5; }
.pw-tl-console-warn { border-left-color: #f59e0b; }
.pw-tl-console-warn .pw-tl-content { color: #fcd34d; }
.pw-tl-console-info { border-left-color: #3b82f6; }
.pw-tl-console-info .pw-tl-content { color: #93c5fd; }
.pw-tl-console-log { border-left-color: #475569; }
.pw-tl-console-debug { border-left-color: #475569; }

/* Hover entries */
.pw-tl-hover {
  opacity: 0.6;
}

/* Screenshot entries */
.pw-tl-screenshot .pw-tl-content {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pw-tl-thumb {
  width: 60px;
  height: 40px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid #334155;
  flex-shrink: 0;
}

.pw-tl-dims {
  font-size: 10px;
  color: #64748b;
  font-family: monospace;
}

/* Trigger recording state */
.pw-trigger-recording {
  background: #dc2626 !important;
  animation: pw-pulse 1.5s ease-in-out infinite;
}

/* Ambient listen-mode indicator: persistent red dot badge on the trigger.
   Unlike pw-trigger-recording, this does NOT pulse and does NOT change
   the trigger color — the dot is always visible so the user knows
   listening is on. */
.pw-trigger-listening {
  position: relative;
}
.pw-trigger-listening::after {
  content: '';
  position: absolute;
  top: 4px;
  right: 4px;
  width: 10px;
  height: 10px;
  background: #dc2626;
  border: 2px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 6px rgba(220, 38, 38, 0.6);
  animation: pw-listen-blink 2s ease-in-out infinite;
  pointer-events: none;
  z-index: 2;
}
@keyframes pw-listen-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

/* ===== Brainstorm CC Overlay ===== */

.pw-cc-overlay {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483646;
  width: 90vw;
  max-width: 900px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: rgba(15, 23, 42, 0.92);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 12px;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #e2e8f0;
  transition: opacity 0.2s, transform 0.2s;
}

.pw-cc-overlay.pw-cc-collapsed {
  max-height: 0;
  padding: 0;
  border: none;
  overflow: hidden;
}

.pw-cc-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.15);
  flex-shrink: 0;
}

.pw-cc-header-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #94a3b8;
  flex: 1;
}

.pw-cc-header-app {
  font-size: 11px;
  color: #60a5fa;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pw-cc-header button {
  background: none;
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: #94a3b8;
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  transition: background 0.15s, color 0.15s;
}

.pw-cc-header button:hover {
  background: rgba(148, 163, 184, 0.15);
  color: #e2e8f0;
}

.pw-cc-header button.pw-cc-active {
  background: rgba(59, 130, 246, 0.3);
  border-color: #3b82f6;
  color: #93c5fd;
}

.pw-cc-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  min-height: 60px;
}

.pw-cc-text {
  line-height: 1.5;
  transition: font-size 0.2s;
}

.pw-cc-text.pw-cc-size-normal {
  font-size: 18px;
}

.pw-cc-text.pw-cc-size-large {
  font-size: 32px;
  font-weight: 500;
}

.pw-cc-text .pw-cc-final {
  color: #e2e8f0;
}

.pw-cc-text .pw-cc-interim {
  color: #64748b;
  font-style: italic;
}

.pw-cc-text .pw-cc-chunk-highlight {
  background: rgba(234, 179, 8, 0.25);
  border-radius: 3px;
  padding: 0 2px;
  animation: pw-cc-flash 1.5s ease-out forwards;
}

@keyframes pw-cc-flash {
  0% { background: rgba(234, 179, 8, 0.4); }
  100% { background: transparent; }
}

.pw-cc-chunk-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  font-size: 10px;
  color: #475569;
}

.pw-cc-chunk-divider::before,
.pw-cc-chunk-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: rgba(71, 85, 105, 0.4);
}

.pw-cc-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-top: 1px solid rgba(148, 163, 184, 0.15);
  flex-shrink: 0;
}

.pw-cc-footer button {
  background: none;
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: #94a3b8;
  cursor: pointer;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 11px;
  transition: background 0.15s, color 0.15s;
}

.pw-cc-footer button:hover {
  background: rgba(148, 163, 184, 0.15);
  color: #e2e8f0;
}

.pw-cc-flush-btn {
  background: rgba(234, 179, 8, 0.15) !important;
  border-color: rgba(234, 179, 8, 0.4) !important;
  color: #eab308 !important;
}

.pw-cc-flush-btn:hover {
  background: rgba(234, 179, 8, 0.25) !important;
}

/* ===== Brainstorm Ticket Cards ===== */

.pw-cc-tickets {
  padding: 8px 12px;
  border-top: 1px solid rgba(148, 163, 184, 0.15);
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 200px;
  overflow-y: auto;
}

.pw-cc-ticket {
  background: rgba(30, 41, 59, 0.8);
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pw-cc-ticket-title {
  font-size: 13px;
  font-weight: 600;
  color: #f1f5f9;
}

.pw-cc-ticket-desc {
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.4;
  max-height: 40px;
  overflow: hidden;
}

.pw-cc-ticket-app {
  font-size: 10px;
  color: #60a5fa;
}

.pw-cc-ticket-actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}

.pw-cc-ticket-actions button {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  font-weight: 500;
  transition: opacity 0.15s;
}

.pw-cc-ticket-actions button:hover {
  opacity: 0.85;
}

.pw-cc-ticket-actions .pw-cc-plan-btn {
  background: #3b82f6;
  color: #fff;
}

.pw-cc-ticket-actions .pw-cc-doit-btn {
  background: #eab308;
  color: #1e293b;
}

.pw-cc-ticket-pickers {
  display: flex;
  gap: 6px;
}

.pw-cc-select {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  background: rgba(15, 23, 42, 0.8);
  color: #e2e8f0;
  cursor: pointer;
  outline: none;
}

.pw-cc-select:focus {
  border-color: #3b82f6;
}

.pw-cc-ticket-actions .pw-cc-dismiss-btn {
  background: transparent;
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: #94a3b8;
}

/* ===== Brainstorm toggle (minimized bar) ===== */

.pw-cc-toggle-bar {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483646;
  background: rgba(15, 23, 42, 0.85);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 20px;
  padding: 4px 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #94a3b8;
  transition: background 0.15s;
}

.pw-cc-toggle-bar:hover {
  background: rgba(30, 41, 59, 0.95);
  color: #e2e8f0;
}

.pw-cc-toggle-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #dc2626;
  animation: pw-listen-blink 2s ease-in-out infinite;
}

`;
