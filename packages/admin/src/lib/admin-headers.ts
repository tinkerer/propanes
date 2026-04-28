/**
 * Build the Authorization header used by admin API calls. Reads the token
 * from localStorage at call time, so a freshly logged-in admin session
 * starts authenticating without a page reload.
 */
export function adminHeaders(): Record<string, string> {
  const token = localStorage.getItem('pw-admin-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}
