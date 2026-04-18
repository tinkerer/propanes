export const OVERLAY_CSS = `
.pw-overlay-panel {
  position: fixed;
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(99, 102, 241, 0.1);
  overflow: hidden;
  animation: pw-panel-in 0.2s ease-out;
  min-width: 320px;
  min-height: 200px;
}

@keyframes pw-panel-in {
  from { opacity: 0; transform: translateY(12px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.pw-overlay-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 12px;
  height: 36px;
  background: #0f172a;
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
  border-bottom: 1px solid #334155;
}

.pw-overlay-header:active {
  cursor: grabbing;
}

.pw-overlay-header-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.pw-overlay-header-title {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
  color: #94a3b8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pw-overlay-header-btns {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.pw-overlay-btn {
  width: 24px;
  height: 24px;
  border: none;
  background: none;
  color: #64748b;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1;
  padding: 0;
}

.pw-overlay-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #e2e8f0;
}

.pw-overlay-iframe-wrap {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.pw-overlay-iframe {
  width: 100%;
  height: 100%;
  border: none;
  background: #f8fafc;
}

.pw-overlay-iframe-mask {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: none;
}

.pw-overlay-panel.pw-dragging .pw-overlay-iframe-mask,
.pw-overlay-panel.pw-resizing .pw-overlay-iframe-mask {
  display: block;
}

/* Resize handles */
.pw-resize {
  position: absolute;
  z-index: 2;
}
.pw-resize-n  { top: -3px; left: 8px; right: 8px; height: 6px; cursor: n-resize; }
.pw-resize-s  { bottom: -3px; left: 8px; right: 8px; height: 6px; cursor: s-resize; }
.pw-resize-e  { right: -3px; top: 8px; bottom: 8px; width: 6px; cursor: e-resize; }
.pw-resize-w  { left: -3px; top: 8px; bottom: 8px; width: 6px; cursor: w-resize; }
.pw-resize-ne { top: -3px; right: -3px; width: 12px; height: 12px; cursor: ne-resize; }
.pw-resize-nw { top: -3px; left: -3px; width: 12px; height: 12px; cursor: nw-resize; }
.pw-resize-se { bottom: -3px; right: -3px; width: 12px; height: 12px; cursor: se-resize; }
.pw-resize-sw { bottom: -3px; left: -3px; width: 12px; height: 12px; cursor: sw-resize; }

/* Minimized state */
.pw-overlay-panel.pw-minimized {
  min-height: 0;
  height: 36px !important;
  min-width: 200px;
}

.pw-overlay-panel.pw-minimized .pw-overlay-iframe-wrap,
.pw-overlay-panel.pw-minimized .pw-resize {
  display: none;
}

.pw-overlay-panel.pw-minimized .pw-overlay-header {
  border-bottom: none;
}

`;
