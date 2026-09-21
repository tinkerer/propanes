export interface ViewerSize {
  cols: number;
  rows: number;
}

/**
 * Which attached viewer's requested size a shared PTY takes.
 *
 * The most recent request wins, like tmux `window-size latest`. Browsers only
 * send a resize while their document is focused (AgentTerminal), so "latest"
 * is the pane the user is actually looking at; every other viewer mirrors the
 * PTY's grid at scale. Sizing to the largest viewer instead — the previous
 * policy — handed every smaller pane a PTY taller/wider than its own grid, so
 * xterm clamped each cursor move to its bottom row and painted the TUI as
 * garbage with a cursor that jumped on every redraw.
 */
export class ViewerSizes<K> {
  private readonly sizes = new Map<K, ViewerSize & { seq: number }>();
  private seq = 0;

  set(viewer: K, size: ViewerSize): void {
    this.sizes.set(viewer, { cols: size.cols, rows: size.rows, seq: ++this.seq });
  }

  delete(viewer: K): boolean {
    return this.sizes.delete(viewer);
  }

  get size(): number {
    return this.sizes.size;
  }

  /** Forget viewers that are no longer attached. */
  prune(attached: { has(viewer: K): boolean }): void {
    for (const viewer of this.sizes.keys()) {
      if (!attached.has(viewer)) this.sizes.delete(viewer);
    }
  }

  /** Most recently requested size, optionally restricted to a set of viewers. */
  latest(among?: Iterable<K>): ViewerSize | null {
    let best: (ViewerSize & { seq: number }) | undefined;
    const candidates = among
      ? Array.from(among, (viewer) => this.sizes.get(viewer)).filter((s): s is ViewerSize & { seq: number } => s !== undefined)
      : this.sizes.values();
    for (const s of candidates) {
      if (!best || s.seq > best.seq) best = s;
    }
    return best ? { cols: best.cols, rows: best.rows } : null;
  }
}
