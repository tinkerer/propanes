/** Pending sessions are opening; running includes idle/waiting interactive PTYs. */
export function isOpenSession(session: { status: string }): boolean {
  return session.status === 'running' || session.status === 'pending';
}
