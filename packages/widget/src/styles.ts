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
  background: #6366f1;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
  transition: transform 0.2s, box-shadow 0.2s;
}

.pw-trigger:hover {
  transform: scale(1.1);
  box-shadow: 0 6px 16px rgba(99, 102, 241, 0.5);
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
  clip-path: circle(50% at 100% 100%);
  transition: right 0.3s ease-out, bottom 0.3s ease-out;
}

.pw-trigger-peek:hover {
  filter: brightness(1.2);
}

.pw-panel {
  position: fixed;
  z-index: 2147483647;
  width: 360px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(99, 102, 241, 0.08);
  display: flex;
  flex-direction: column;
  overflow: visible;
  animation: pw-slide-in 0.2s ease-out;
}

.pw-panel.bottom-right { bottom: 80px; right: 20px; }
.pw-panel.bottom-left { bottom: 80px; left: 20px; }
.pw-panel.top-right { top: 80px; right: 20px; }
.pw-panel.top-left { top: 80px; left: 20px; }

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
  border-top-color: #6366f1;
  border-left-color: #6366f1;
}

.pw-panel.bottom-left .pw-resize-handle {
  top: -1px; right: -1px;
  cursor: ne-resize;
  border-top: 3px solid transparent;
  border-right: 3px solid transparent;
  border-top-right-radius: 14px;
}
.pw-panel.bottom-left .pw-resize-handle:hover {
  border-top-color: #6366f1;
  border-right-color: #6366f1;
}

.pw-panel.top-right .pw-resize-handle {
  bottom: -1px; left: -1px;
  cursor: sw-resize;
  border-bottom: 3px solid transparent;
  border-left: 3px solid transparent;
  border-bottom-left-radius: 14px;
}
.pw-panel.top-right .pw-resize-handle:hover {
  border-bottom-color: #6366f1;
  border-left-color: #6366f1;
}

.pw-panel.top-left .pw-resize-handle {
  bottom: -1px; right: -1px;
  cursor: se-resize;
  border-bottom: 3px solid transparent;
  border-right: 3px solid transparent;
  border-bottom-right-radius: 14px;
}
.pw-panel.top-left .pw-resize-handle:hover {
  border-bottom-color: #6366f1;
  border-right-color: #6366f1;
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
  border-color: #6366f1;
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
  flex: 1;
  padding: 10px 12px;
  border: 1px solid #334155;
  border-radius: 8px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5;
  outline: none;
  resize: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.pw-textarea::placeholder {
  color: #64748b;
}

.pw-textarea:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
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
  background: rgba(99, 102, 241, 0.2);
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
  background: #6366f1;
  border-color: #6366f1;
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
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid #6366f1;
  border-radius: 6px;
  font-size: 12px;
}

.pw-selected-element code {
  font-family: monospace;
  color: #c7d2fe;
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
  background: rgba(99, 102, 241, 0.2);
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
  background: #6366f1;
  border-color: #6366f1;
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
  background: rgba(99, 102, 241, 0.2);
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
  background: #6366f1;
  border-color: #6366f1;
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
  background: #6366f1;
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
  background: #4f46e5;
}

.pw-send-btn.pw-dispatch-active {
  background: #22c55e;
}

.pw-send-btn.pw-dispatch-active:hover {
  background: #16a34a;
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
  background: #6366f1;
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
  background: #4f46e5;
}

.pw-send-dropdown-toggle.pw-dispatch-active {
  background: #22c55e;
}

.pw-send-dropdown-toggle.pw-dispatch-active:hover {
  background: #16a34a;
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
  background: rgba(99, 102, 241, 0.2);
}

.pw-send-menu-item.pw-active {
  color: #a5b4fc;
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
  background: #6366f1;
  border-color: #6366f1;
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
  color: #22c55e;
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
  fill: #22c55e;
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
  background: rgba(99, 102, 241, 0.2);
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
  background: #6366f1;
  border-color: #6366f1;
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
  border-color: #6366f1;
  color: #f1f5f9;
}

.pw-admin-option-icon {
  font-size: 15px;
  line-height: 1;
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
`;
