const HANDLE_SIZE = 8;
const MIN_CROP = 10;

const IMAGE_EDITOR_CSS = `
.pw-image-editor {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  gap: 10px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #e2e8f0;
  box-sizing: border-box;
}
.pw-image-editor *, .pw-image-editor *::before, .pw-image-editor *::after {
  box-sizing: border-box;
}
.pw-ie-canvas-wrap {
  position: relative;
  max-width: 90vw;
  max-height: calc(100vh - 120px);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  line-height: 0;
}
.pw-ie-canvas-wrap img {
  display: block;
  max-width: 90vw;
  max-height: calc(100vh - 120px);
  object-fit: contain;
}
.pw-ie-canvas-wrap canvas {
  position: absolute;
  top: 0;
  left: 0;
  cursor: crosshair;
}
.pw-ie-toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}
.pw-ie-toolbar button {
  height: 32px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid #475569;
  background: #1e293b;
  color: #e2e8f0;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  transition: background 0.15s, border-color 0.15s;
}
.pw-ie-toolbar button:hover {
  background: #334155;
  border-color: #6366f1;
}
.pw-ie-toolbar button.active {
  background: #6366f1;
  border-color: #6366f1;
}
.pw-ie-toolbar button.pw-ie-save {
  background: #6366f1;
  border-color: #6366f1;
}
.pw-ie-toolbar button.pw-ie-save:hover {
  background: #4f46e5;
}
.pw-ie-toolbar button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pw-ie-toolbar .pw-ie-sep {
  width: 1px;
  background: #475569;
  align-self: stretch;
  margin: 4px 2px;
}
.pw-ie-hint {
  font-size: 12px;
  color: #64748b;
}
`;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type CropDragMode = 'none' | 'draw' | 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';

export interface SaveAction {
  label: string;
  primary?: boolean;
  handler: (blob: Blob) => Promise<void> | void;
}

export interface ImageEditorOptions {
  container: HTMLElement;
  image: string | Blob;
  tools?: ('highlight' | 'crop')[];
  initialTool?: 'highlight' | 'crop';
  saveActions: SaveAction[];
  onCancel: () => void;
}

function cropHitTest(mx: number, my: number, r: Rect): CropDragMode {
  const hs = HANDLE_SIZE;
  // Corners first (higher priority)
  if (Math.abs(mx - r.x) < hs && Math.abs(my - r.y) < hs) return 'nw';
  if (Math.abs(mx - (r.x + r.w)) < hs && Math.abs(my - r.y) < hs) return 'ne';
  if (Math.abs(mx - r.x) < hs && Math.abs(my - (r.y + r.h)) < hs) return 'sw';
  if (Math.abs(mx - (r.x + r.w)) < hs && Math.abs(my - (r.y + r.h)) < hs) return 'se';
  // Edge midpoints
  if (Math.abs(mx - (r.x + r.w / 2)) < hs && Math.abs(my - r.y) < hs) return 'n';
  if (Math.abs(mx - (r.x + r.w / 2)) < hs && Math.abs(my - (r.y + r.h)) < hs) return 's';
  if (Math.abs(mx - r.x) < hs && Math.abs(my - (r.y + r.h / 2)) < hs) return 'w';
  if (Math.abs(mx - (r.x + r.w)) < hs && Math.abs(my - (r.y + r.h / 2)) < hs) return 'e';
  if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return 'move';
  return 'none';
}

function cropCursor(mode: CropDragMode): string {
  switch (mode) {
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'n': case 's': return 'ns-resize';
    case 'e': case 'w': return 'ew-resize';
    case 'move': return 'move';
    default: return 'crosshair';
  }
}

export class ImageEditor {
  private root: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private img: HTMLImageElement;
  private tools: ('highlight' | 'crop')[];
  private activeTool: 'highlight' | 'crop';
  private saveActions: SaveAction[];
  private onCancel: () => void;

  private highlights: Rect[] = [];
  private cropRect: Rect | null = null;

  // Highlight drag state
  private hlDrawing = false;
  private hlStartX = 0;
  private hlStartY = 0;

  // Crop drag state
  private cropDrag: { mode: CropDragMode; startX: number; startY: number; origRect: Rect } = {
    mode: 'none', startX: 0, startY: 0, origRect: { x: 0, y: 0, w: 0, h: 0 },
  };

  private saving = false;
  private destroyed = false;

  // Bound handlers for cleanup
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;

  constructor(options: ImageEditorOptions) {
    this.tools = options.tools ?? ['highlight', 'crop'];
    this.activeTool = options.initialTool ?? this.tools[0];
    this.saveActions = options.saveActions;
    this.onCancel = options.onCancel;

    this.boundMouseDown = this.onMouseDown.bind(this);
    this.boundMouseMove = this.onMouseMove.bind(this);
    this.boundMouseUp = this.onMouseUp.bind(this);

    // Inject CSS
    const style = document.createElement('style');
    style.textContent = IMAGE_EDITOR_CSS;
    options.container.appendChild(style);

    // Build DOM
    this.root = document.createElement('div');
    this.root.className = 'pw-image-editor';
    options.container.appendChild(this.root);

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'pw-ie-canvas-wrap';

    this.img = new Image();
    this.img.crossOrigin = 'anonymous';
    if (options.image instanceof Blob) {
      this.img.src = URL.createObjectURL(options.image);
    } else {
      this.img.src = options.image;
    }

    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;

    canvasWrap.append(this.img, this.canvas);

    const toolbar = this.buildToolbar();
    const hint = document.createElement('div');
    hint.className = 'pw-ie-hint';
    hint.textContent = this.hintText();

    this.root.append(canvasWrap, toolbar, hint);

    this.img.onload = () => {
      if (this.destroyed) return;
      const dw = this.img.clientWidth;
      const dh = this.img.clientHeight;
      this.canvas.width = dw;
      this.canvas.height = dh;
      this.canvas.style.width = dw + 'px';
      this.canvas.style.height = dh + 'px';
      this.redraw();
    };

    // Mouse events — listen on the root so dragging outside the canvas still tracks
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.root.addEventListener('mousemove', this.boundMouseMove);
    this.root.addEventListener('mouseup', this.boundMouseUp);
  }

  destroy() {
    this.destroyed = true;
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.root.removeEventListener('mousemove', this.boundMouseMove);
    this.root.removeEventListener('mouseup', this.boundMouseUp);
    if (this.img.src.startsWith('blob:')) URL.revokeObjectURL(this.img.src);
    this.root.remove();
  }

  // ── Toolbar ──

  private buildToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'pw-ie-toolbar';

    // Tool buttons (only if more than one tool)
    if (this.tools.length > 1) {
      for (const tool of this.tools) {
        const btn = document.createElement('button');
        btn.textContent = tool === 'highlight' ? 'Highlight' : 'Crop';
        btn.dataset.tool = tool;
        if (tool === this.activeTool) btn.className = 'active';
        btn.addEventListener('click', () => this.switchTool(tool, toolbar));
        toolbar.appendChild(btn);
      }
      const sep = document.createElement('div');
      sep.className = 'pw-ie-sep';
      toolbar.appendChild(sep);
    }

    // Undo button
    const undoBtn = document.createElement('button');
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', () => this.undo());
    toolbar.appendChild(undoBtn);

    // Download button
    const dlBtn = document.createElement('button');
    dlBtn.textContent = 'Download';
    dlBtn.addEventListener('click', () => this.downloadImage(dlBtn));
    toolbar.appendChild(dlBtn);

    const sep2 = document.createElement('div');
    sep2.className = 'pw-ie-sep';
    toolbar.appendChild(sep2);

    // Save action buttons
    for (const action of this.saveActions) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      if (action.primary) btn.className = 'pw-ie-save';
      btn.addEventListener('click', () => this.executeSave(action, btn));
      toolbar.appendChild(btn);
    }

    // Cancel
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this.onCancel());
    toolbar.appendChild(cancelBtn);

    return toolbar;
  }

  private switchTool(tool: 'highlight' | 'crop', toolbar: HTMLElement) {
    this.activeTool = tool;
    toolbar.querySelectorAll('button[data-tool]').forEach((b) => {
      (b as HTMLElement).classList.toggle('active', b.getAttribute('data-tool') === tool);
    });
    this.canvas.style.cursor = tool === 'highlight' ? 'crosshair' : 'crosshair';
    const hint = this.root.querySelector('.pw-ie-hint');
    if (hint) hint.textContent = this.hintText();
    this.redraw();
  }

  private hintText(): string {
    return this.activeTool === 'highlight'
      ? 'Click and drag to highlight areas'
      : 'Click and drag to define crop region';
  }

  private undo() {
    if (this.activeTool === 'highlight') {
      this.highlights.pop();
    } else {
      this.cropRect = null;
    }
    this.redraw();
  }

  // ── Canvas coords ──

  private getCanvasCoords(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, this.canvas.width));
    const y = Math.max(0, Math.min(e.clientY - rect.top, this.canvas.height));
    return { x, y };
  }

  private clampCropRect(r: Rect): Rect {
    let { x, y, w, h } = r;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + w > this.canvas.width) w = this.canvas.width - x;
    if (y + h > this.canvas.height) h = this.canvas.height - y;
    return { x, y, w, h };
  }

  // ── Mouse handlers ──

  private onMouseDown(e: MouseEvent) {
    if (this.saving) return;
    const pos = this.getCanvasCoords(e);

    if (this.activeTool === 'highlight') {
      this.hlDrawing = true;
      this.hlStartX = pos.x;
      this.hlStartY = pos.y;
    } else {
      // Crop tool
      const cr = this.cropRect;
      if (cr) {
        const mode = cropHitTest(pos.x, pos.y, cr);
        if (mode !== 'none') {
          this.cropDrag = { mode, startX: pos.x, startY: pos.y, origRect: { ...cr } };
          return;
        }
      }
      // Start new crop rect
      this.cropRect = { x: pos.x, y: pos.y, w: 0, h: 0 };
      this.cropDrag = { mode: 'draw', startX: pos.x, startY: pos.y, origRect: { x: pos.x, y: pos.y, w: 0, h: 0 } };
    }
  }

  private onMouseMove(e: MouseEvent) {
    if (this.saving) return;
    const pos = this.getCanvasCoords(e);

    if (this.activeTool === 'highlight') {
      if (!this.hlDrawing) return;
      this.redraw();
      // Draw in-progress highlight
      this.ctx.fillStyle = 'rgba(255, 220, 40, 0.3)';
      this.ctx.fillRect(this.hlStartX, this.hlStartY, pos.x - this.hlStartX, pos.y - this.hlStartY);
      this.ctx.strokeStyle = 'rgba(255, 200, 0, 0.8)';
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(this.hlStartX, this.hlStartY, pos.x - this.hlStartX, pos.y - this.hlStartY);
    } else {
      // Crop tool
      const d = this.cropDrag;
      if (d.mode === 'none') {
        const cr = this.cropRect;
        this.canvas.style.cursor = cr ? cropCursor(cropHitTest(pos.x, pos.y, cr)) : 'crosshair';
        return;
      }

      const dx = pos.x - d.startX;
      const dy = pos.y - d.startY;
      const o = d.origRect;

      if (d.mode === 'draw') {
        const x = Math.min(d.startX, pos.x);
        const y = Math.min(d.startY, pos.y);
        const w = Math.abs(pos.x - d.startX);
        const h = Math.abs(pos.y - d.startY);
        this.cropRect = this.clampCropRect({ x, y, w, h });
      } else if (d.mode === 'move') {
        let nx = o.x + dx;
        let ny = o.y + dy;
        if (nx < 0) nx = 0;
        if (ny < 0) ny = 0;
        if (nx + o.w > this.canvas.width) nx = this.canvas.width - o.w;
        if (ny + o.h > this.canvas.height) ny = this.canvas.height - o.h;
        this.cropRect = { x: nx, y: ny, w: o.w, h: o.h };
      } else {
        let { x, y, w, h } = o;
        if (d.mode === 'se') { w += dx; h += dy; }
        else if (d.mode === 'nw') { x += dx; y += dy; w -= dx; h -= dy; }
        else if (d.mode === 'ne') { w += dx; y += dy; h -= dy; }
        else if (d.mode === 'sw') { x += dx; w -= dx; h += dy; }
        else if (d.mode === 'n') { y += dy; h -= dy; }
        else if (d.mode === 's') { h += dy; }
        else if (d.mode === 'w') { x += dx; w -= dx; }
        else if (d.mode === 'e') { w += dx; }
        if (w < MIN_CROP) w = MIN_CROP;
        if (h < MIN_CROP) h = MIN_CROP;
        this.cropRect = this.clampCropRect({ x, y, w, h });
      }
      this.redraw();
    }
  }

  private onMouseUp(e: MouseEvent) {
    if (this.saving) return;

    if (this.activeTool === 'highlight') {
      if (!this.hlDrawing) return;
      this.hlDrawing = false;
      const pos = this.getCanvasCoords(e);
      const w = pos.x - this.hlStartX;
      const h = pos.y - this.hlStartY;
      if (Math.abs(w) > 4 && Math.abs(h) > 4) {
        this.highlights.push({ x: this.hlStartX, y: this.hlStartY, w, h });
      }
      this.redraw();
    } else {
      this.cropDrag = { mode: 'none', startX: 0, startY: 0, origRect: { x: 0, y: 0, w: 0, h: 0 } };
    }
  }

  // ── Redraw ──

  private redraw() {
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    // Highlights
    for (const r of this.highlights) {
      ctx.fillStyle = 'rgba(255, 220, 40, 0.3)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = 'rgba(255, 200, 0, 0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    // Crop overlay
    const cr = this.cropRect;
    if (cr && cr.w > 0 && cr.h > 0) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, cw, ch);
      ctx.clearRect(cr.x, cr.y, cr.w, cr.h);

      // Re-draw highlights inside the crop rect (they were cleared)
      ctx.save();
      ctx.beginPath();
      ctx.rect(cr.x, cr.y, cr.w, cr.h);
      ctx.clip();
      for (const r of this.highlights) {
        ctx.fillStyle = 'rgba(255, 220, 40, 0.3)';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = 'rgba(255, 200, 0, 0.8)';
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
      }
      ctx.restore();

      // Crop border + handles
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(cr.x, cr.y, cr.w, cr.h);

      ctx.fillStyle = '#fff';
      const hs = HANDLE_SIZE;
      const corners = [
        [cr.x, cr.y], [cr.x + cr.w, cr.y],
        [cr.x, cr.y + cr.h], [cr.x + cr.w, cr.y + cr.h],
      ];
      for (const [cx, cy] of corners) {
        ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
      }
      const edges = [
        [cr.x + cr.w / 2, cr.y],
        [cr.x + cr.w / 2, cr.y + cr.h],
        [cr.x, cr.y + cr.h / 2],
        [cr.x + cr.w, cr.y + cr.h / 2],
      ];
      for (const [ex, ey] of edges) {
        ctx.fillRect(ex - hs / 2, ey - hs / 2, hs, hs);
      }
    }
  }

  // ── Save ──

  private async downloadImage(btn: HTMLButtonElement) {
    if (this.saving) return;
    this.saving = true;
    const origText = btn.textContent;
    btn.textContent = 'Downloading...';
    this.root.querySelectorAll<HTMLButtonElement>('.pw-ie-toolbar button').forEach(b => b.disabled = true);
    try {
      const blob = await this.compositeImage();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'edited-image.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert('Download failed: ' + err.message);
    } finally {
      this.saving = false;
      btn.textContent = origText;
      this.root.querySelectorAll<HTMLButtonElement>('.pw-ie-toolbar button').forEach(b => b.disabled = false);
    }
  }

  private async executeSave(action: SaveAction, btn: HTMLElement) {
    if (this.saving) return;
    this.saving = true;
    const origText = btn.textContent;
    btn.textContent = 'Saving...';
    this.root.querySelectorAll<HTMLButtonElement>('.pw-ie-toolbar button').forEach(b => b.disabled = true);

    try {
      const blob = await this.compositeImage();
      await action.handler(blob);
    } catch (err: any) {
      alert('Save failed: ' + err.message);
    } finally {
      this.saving = false;
      btn.textContent = origText;
      this.root.querySelectorAll<HTMLButtonElement>('.pw-ie-toolbar button').forEach(b => b.disabled = false);
    }
  }

  private compositeImage(): Promise<Blob> {
    const natW = this.img.naturalWidth;
    const natH = this.img.naturalHeight;
    const scaleX = natW / this.canvas.width;
    const scaleY = natH / this.canvas.height;

    // Full-size canvas with image + highlights burned in
    const full = document.createElement('canvas');
    full.width = natW;
    full.height = natH;
    const fctx = full.getContext('2d')!;
    fctx.drawImage(this.img, 0, 0);

    for (const r of this.highlights) {
      fctx.fillStyle = 'rgba(255, 220, 40, 0.3)';
      fctx.fillRect(r.x * scaleX, r.y * scaleY, r.w * scaleX, r.h * scaleY);
      fctx.strokeStyle = 'rgba(255, 200, 0, 0.8)';
      fctx.lineWidth = 3 * scaleX;
      fctx.strokeRect(r.x * scaleX, r.y * scaleY, r.w * scaleX, r.h * scaleY);
    }

    // If crop rect, extract cropped region
    const cr = this.cropRect;
    if (cr && cr.w >= MIN_CROP && cr.h >= MIN_CROP) {
      const cx = Math.round(cr.x * scaleX);
      const cy = Math.round(cr.y * scaleY);
      const cw = Math.round(cr.w * scaleX);
      const ch = Math.round(cr.h * scaleY);

      const cropped = document.createElement('canvas');
      cropped.width = cw;
      cropped.height = ch;
      const cctx = cropped.getContext('2d')!;
      cctx.drawImage(full, cx, cy, cw, ch, 0, 0, cw, ch);

      return new Promise<Blob>((resolve, reject) => {
        cropped.toBlob((b) => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
      });
    }

    // No crop — return full canvas with highlights
    return new Promise<Blob>((resolve, reject) => {
      full.toBlob((b) => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
    });
  }
}
