import { symlink, unlink } from 'node:fs/promises';
import { existsSync, lstatSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Uploaded artifacts (feedback screenshots, composer attachments, audio) live
// under UPLOAD_DIR but are handed to agents as /tmp/<filename> paths, so a
// local agent can `Read` them without knowing the server's layout. Every route
// that writes into UPLOAD_DIR must therefore also drop the /tmp symlink —
// routes/images.ts used not to, which left the quick-launch composer emitting
// prompts full of /tmp paths that never existed.

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const TMP_LINK_DIR = '/tmp';

export function uploadAbsPath(filename: string): string {
  return resolve(UPLOAD_DIR, filename);
}

export function tmpLinkPath(filename: string): string {
  return join(TMP_LINK_DIR, filename);
}

/**
 * Symlink an uploaded file into /tmp. Returns the /tmp path on success, or the
 * absolute upload path when linking isn't possible (cross-device, permissions,
 * a foreign file squatting the name) so callers always get something readable.
 */
export async function linkToTmp(absPath: string, filename: string): Promise<string> {
  const tmpPath = tmpLinkPath(filename);
  try { await unlink(tmpPath); } catch { /* not present, fine */ }
  try {
    await symlink(absPath, tmpPath);
    return tmpPath;
  } catch {
    return absPath;
  }
}

/** Best-effort removal of the /tmp symlink for a deleted upload. */
export async function unlinkTmp(filename: string): Promise<void> {
  try { await unlink(tmpLinkPath(filename)); } catch { /* already gone */ }
}

/**
 * Resolve the path an agent should be given for an uploaded file, healing a
 * missing or dangling /tmp symlink on the way. Sync so prompt rendering can use
 * it. Rows written before the link was created (or after a /tmp cleanup) get
 * relinked here rather than dispatching a path that 404s for the agent.
 */
export function resolveUploadPath(filename: string): string {
  const absPath = uploadAbsPath(filename);
  const tmpPath = tmpLinkPath(filename);

  if (existsSync(tmpPath)) return tmpPath;
  // The upload itself is gone — nothing to link; hand back the canonical path
  // so the failure reads as "this file is missing", not "wrong directory".
  if (!existsSync(absPath)) return absPath;

  try {
    // A dangling symlink still occupies the name; existsSync() followed it and
    // said no, so clear it before relinking.
    try { lstatSync(tmpPath); unlinkSync(tmpPath); } catch { /* nothing there */ }
    symlinkSync(absPath, tmpPath);
    return tmpPath;
  } catch {
    return absPath;
  }
}
