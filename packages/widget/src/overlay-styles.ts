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
  -webkit-user-select: none;
  flex-shrink: 0;
  border-bottom: 1px solid #334155;
  touch-action: none;
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

.pw-overlay-iframe-scale {
  width: 100%;
  height: 100%;
  transform-origin: 0 0;
  will-change: transform;
}

.pw-overlay-iframe {
  width: 100%;
  height: 100%;
  border: none;
  background: #f8fafc;
  display: block;
}

.pw-overlay-iframe-mask {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: none;
}

.pw-overlay-panel.pw-dragging .pw-overlay-iframe-mask,
.pw-overlay-panel.pw-resizing .pw-overlay-iframe-mask,
.pw-overlay-panel.pw-gesturing .pw-overlay-iframe-mask {
  display: block;
}

/* Resize handles */
.pw-resize {
  position: absolute;
  z-index: 2;
  touch-action: none;
}
.pw-resize-n  { top: -3px; left: 8px; right: 8px; height: 6px; cursor: n-resize; }
.pw-resize-s  { bottom: -3px; left: 8px; right: 8px; height: 6px; cursor: s-resize; }
.pw-resize-e  { right: -3px; top: 8px; bottom: 8px; width: 6px; cursor: e-resize; }
.pw-resize-w  { left: -3px; top: 8px; bottom: 8px; width: 6px; cursor: w-resize; }
.pw-resize-ne { top: -3px; right: -3px; width: 12px; height: 12px; cursor: ne-resize; }
.pw-resize-nw { top: -3px; left: -3px; width: 12px; height: 12px; cursor: nw-resize; }
.pw-resize-se { bottom: -3px; right: -3px; width: 12px; height: 12px; cursor: se-resize; }
.pw-resize-sw { bottom: -3px; left: -3px; width: 12px; height: 12px; cursor: sw-resize; }

/* Touch devices: bigger hit targets + visible corner grips */
@media (pointer: coarse) {
  .pw-overlay-header {
    height: 44px;
    padding: 0 6px 0 14px;
  }
  .pw-overlay-btn {
    width: 36px;
    height: 36px;
    font-size: 18px;
  }
  .pw-resize-n  { top: -8px; left: 24px; right: 24px; height: 16px; }
  .pw-resize-s  { bottom: -8px; left: 24px; right: 24px; height: 16px; }
  .pw-resize-e  { right: -8px; top: 24px; bottom: 24px; width: 16px; }
  .pw-resize-w  { left: -8px; top: 24px; bottom: 24px; width: 16px; }
  .pw-resize-ne, .pw-resize-nw, .pw-resize-se, .pw-resize-sw {
    width: 28px; height: 28px;
    background: rgba(99, 102, 241, 0.35);
    border: 1px solid rgba(99, 102, 241, 0.6);
    border-radius: 4px;
  }
  .pw-resize-ne { top: -10px; right: -10px; }
  .pw-resize-nw { top: -10px; left: -10px; }
  .pw-resize-se { bottom: -10px; right: -10px; }
  .pw-resize-sw { bottom: -10px; left: -10px; }
}

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

/* Drawer handle (hidden by default, shown when collapsed) */
.pw-drawer-handle {
  display: none;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  cursor: pointer;
  background: #0f172a;
  color: #94a3b8;
  font-size: 12px;
  user-select: none;
  border-bottom: 1px solid #334155;
  white-space: nowrap;
}

.pw-drawer-handle:hover {
  background: #1e293b;
  color: #e2e8f0;
}

.pw-drawer-handle-icon {
  font-size: 14px;
}

/* Drawer collapsed state */
.pw-overlay-panel.pw-drawer-collapsed {
  min-width: 0 !important;
  min-height: 0 !important;
  overflow: hidden;
}

.pw-overlay-panel.pw-drawer-collapsed .pw-overlay-header,
.pw-overlay-panel.pw-drawer-collapsed .pw-overlay-iframe-wrap,
.pw-overlay-panel.pw-drawer-collapsed .pw-resize {
  display: none;
}

.pw-overlay-panel.pw-drawer-collapsed .pw-drawer-handle {
  display: flex;
}

/* Left docked + collapsed: thin strip on left edge */
.pw-overlay-panel.pw-docked-left.pw-drawer-collapsed {
  width: auto !important;
  height: auto !important;
  top: 50% !important;
  left: 0 !important;
  transform: translateY(-50%);
  border-radius: 0 8px 8px 0;
}

/* Right docked + collapsed: thin strip on right edge */
.pw-overlay-panel.pw-docked-right.pw-drawer-collapsed {
  width: auto !important;
  height: auto !important;
  top: 50% !important;
  left: auto !important;
  right: 0;
  transform: translateY(-50%);
  border-radius: 8px 0 0 8px;
}

/* Bottom docked + collapsed: thin strip on bottom edge */
.pw-overlay-panel.pw-docked-bottom.pw-drawer-collapsed {
  width: auto !important;
  height: auto !important;
  top: auto !important;
  left: 50% !important;
  bottom: 0;
  transform: translateX(-50%);
  border-radius: 8px 8px 0 0;
}

/* Floating + collapsed: just a pill where it was */
.pw-overlay-panel.pw-drawer-collapsed:not(.pw-docked-left):not(.pw-docked-right):not(.pw-docked-bottom) {
  width: auto !important;
  height: auto !important;
  border-radius: 8px;
}

/* Docked states — remove border-radius on docked edge */
.pw-overlay-panel.pw-docked-left {
  border-radius: 0 10px 10px 0;
}

.pw-overlay-panel.pw-docked-right {
  border-radius: 10px 0 0 10px;
}

.pw-overlay-panel.pw-docked-bottom {
  border-radius: 10px 10px 0 0;
}

/* Hide dock buttons when not docked, show undock when docked */
.pw-overlay-panel:not(.pw-docked-left):not(.pw-docked-right):not(.pw-docked-bottom) .pw-undock-btn {
  display: none;
}

.pw-overlay-panel.pw-docked-left .pw-undock-btn,
.pw-overlay-panel.pw-docked-right .pw-undock-btn,
.pw-overlay-panel.pw-docked-bottom .pw-undock-btn {
  display: flex;
}

/* Snap preview zone */
.pw-snap-preview {
  display: none;
  position: fixed;
  background: rgba(99, 102, 241, 0.15);
  border: 2px dashed rgba(99, 102, 241, 0.5);
  z-index: 2147483645;
  pointer-events: none;
  transition: all 0.15s ease;
}

.pw-snap-preview.pw-snap-left {
  top: 0;
  left: 0;
  width: 50%;
  height: 100%;
}

.pw-snap-preview.pw-snap-right {
  top: 0;
  right: 0;
  left: auto;
  width: 50%;
  height: 100%;
}

.pw-snap-preview.pw-snap-bottom {
  bottom: 0;
  left: 0;
  width: 100%;
  height: 50%;
  top: auto;
}

/* Waiting badge on drawer handle */
.pw-drawer-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: #f59e0b;
  color: #000;
  font-size: 10px;
  font-weight: 600;
  animation: pw-badge-pulse 2s ease-in-out infinite;
}

@keyframes pw-badge-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

`;
