import { signal } from '@preact/signals';

// Open-state signals shared by PopoutPanel and its extracted child components.
// Kept here (not in PopoutPanel.tsx) so child files can subscribe without
// creating a circular import back to the panel shell.

export const popoutIdMenuOpen = signal<string | null>(null);
export const popoutWindowMenuOpen = signal<string | null>(null);
export const popoutStatusMenuOpen = signal<{ sessionId: string; panelId: string; x: number; y: number } | null>(null);
export const popoutHotkeyMenuOpen = signal<{ sessionId: string; panelId: string; x: number; y: number } | null>(null);
export const renamingSessionId = signal<string | null>(null);
export const renameValue = signal('');

// Companion id-dropdown shared between in-header and split-pane right-tab.
export const companionMenuOpen = signal<string | null>(null);
