const paths = {
  app: 'M4 4h16v12H4z M8 20h8 M12 16v4',
  tickets: 'M7 4h10v3H7z M7 5H4v16h16V5h-3 M8 12h8 M8 16h5',
  sessions: 'M13 2 5 14h6l-1 8 9-13h-6z',
  live: 'M3 12h4l3-7 4 14 3-7h4',
  agents: 'M5 7h14v13H5z M12 3v4 M9 12h.01 M15 12h.01 M9 16h6',
  infrastructure: 'M3 3h7v7H3z M14 14h7v7h-7z M6 10v7h8 M14 6h7 M17 3v7',
  wiggum: 'M4 12a8 8 0 0 1 14-5l2 2 M20 3v6h-6 M20 12a8 8 0 0 1-14 5l-2-2 M4 21v-6h6',
  flatter: 'm12 3 9 5-9 5-9-5z M3 12l9 5 9-5 M3 16l9 5 9-5',
  approvals: 'M6 10h12v11H6z M8 10V6a4 4 0 0 1 8 0v4',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 7 M22 21v-2a4 4 0 0 0-3-4',
  usage: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  guide: 'M12 5v16 M12 5C8 2 4 3 2 4v15c4-2 7-1 10 2 3-3 6-4 10-2V4c-2-1-6-2-10 1',
  start: 'm9 5 10 7-10 7z',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  logout: 'M9 3H4v18h5 M9 12h12 M17 8l4 4-4 4',
  terminal: 'm5 7 5 5-5 5 M13 17h6',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
  bell: 'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5z M10 21h4',
  link: 'm9 15 6-6 M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
} as const;

export type NavIconName = keyof typeof paths;

/** Decorative icons always inherit their control's semantic color and label. */
export function NavIcon({ name }: { name: NavIconName }) {
  return <svg class="nav-glyph" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
