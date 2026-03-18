import { signal } from '@preact/signals';

export interface FileViewerState {
  path: string;
  content?: string;
  imageUrl?: string;
  loading: boolean;
  error?: string;
}

export const fileViewerPanels = signal<FileViewerState[]>([]);

let zCounter = 0;
export const fileViewerZOrders = signal<Map<string, number>>(new Map());

export function bringFileViewerToFront(path: string) {
  zCounter++;
  const next = new Map(fileViewerZOrders.value);
  next.set(path, zCounter);
  fileViewerZOrders.value = next;
}

export function getFileViewerZIndex(path: string): number {
  const order = fileViewerZOrders.value.get(path) ?? 0;
  return 8000 + order;
}

export function openFileViewer(path: string) {
  const existing = fileViewerPanels.value.find(p => p.path === path);
  if (existing) {
    bringFileViewerToFront(path);
    return;
  }
  fileViewerPanels.value = [...fileViewerPanels.value, { path, loading: true }];
  bringFileViewerToFront(path);
}

export function closeFileViewer(path: string) {
  fileViewerPanels.value = fileViewerPanels.value.filter(p => p.path !== path);
}

export function updateFileViewer(path: string, update: Partial<FileViewerState>) {
  fileViewerPanels.value = fileViewerPanels.value.map(p =>
    p.path === path ? { ...p, ...update } : p
  );
}
