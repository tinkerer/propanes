import { signal } from '@preact/signals';

export interface FileViewerState {
  path: string;
  content?: string;
  imageUrl?: string;
  loading: boolean;
  error?: string;
}

export const fileViewerPanels = signal<FileViewerState[]>([]);

export function openFileViewer(path: string) {
  const existing = fileViewerPanels.value.find(p => p.path === path);
  if (existing) return;
  fileViewerPanels.value = [...fileViewerPanels.value, { path, loading: true }];
}

export function closeFileViewer(path: string) {
  fileViewerPanels.value = fileViewerPanels.value.filter(p => p.path !== path);
}

export function updateFileViewer(path: string, update: Partial<FileViewerState>) {
  fileViewerPanels.value = fileViewerPanels.value.map(p =>
    p.path === path ? { ...p, ...update } : p
  );
}
