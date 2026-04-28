import { useEffect, useState } from 'preact/hooks';
import { captureScreenshot } from '@propanes/widget/screenshot';
import { chiefOfStaffError } from './chief-of-staff.js';

/**
 * Screenshot capture state + localStorage-backed options for the CoS bubble.
 * Owns:
 *   - capturingScreenshot flag (disables the camera button mid-capture)
 *   - screenshotExcludeWidget / screenshotExcludeCursor / screenshotMethod /
 *     screenshotKeepStream — persisted under `pw-cos-shot-*` keys
 *   - captureAndAttachScreenshot — one-shot capture
 *   - startTimedScreenshot — countdown then capture (closes the camera menu
 *     before the timer starts so the menu doesn't show up in the shot)
 *
 * The parent supplies:
 *   - onAttachBlob: hand the captured Blob (with a default filename) to the
 *     attachment pipeline. Same callback used by paste-image and other inputs.
 *   - closeCameraMenu: dismiss the camera menu before timed capture starts.
 */
export function useCosScreenshot(opts: {
  onAttachBlob: (blob: Blob, name?: string) => Promise<void> | void;
  closeCameraMenu: () => void;
}) {
  const [capturingScreenshot, setCapturingScreenshot] = useState(false);
  const [screenshotExcludeWidget, setScreenshotExcludeWidget] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-shot-excl-widget') : null;
    return v === null ? true : v === '1';
  });
  const [screenshotExcludeCursor, setScreenshotExcludeCursor] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-shot-excl-cursor') : null;
    return v === null ? true : v === '1';
  });
  const [screenshotMethod, setScreenshotMethod] = useState<'html-to-image' | 'display-media'>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-shot-method') : null;
    return v === 'display-media' ? 'display-media' : 'html-to-image';
  });
  const [screenshotKeepStream, setScreenshotKeepStream] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-shot-keep') : null;
    return v === '1';
  });

  useEffect(() => { try { localStorage.setItem('pw-cos-shot-excl-widget', screenshotExcludeWidget ? '1' : '0'); } catch { /* ignore */ } }, [screenshotExcludeWidget]);
  useEffect(() => { try { localStorage.setItem('pw-cos-shot-excl-cursor', screenshotExcludeCursor ? '1' : '0'); } catch { /* ignore */ } }, [screenshotExcludeCursor]);
  useEffect(() => { try { localStorage.setItem('pw-cos-shot-method', screenshotMethod); } catch { /* ignore */ } }, [screenshotMethod]);
  useEffect(() => { try { localStorage.setItem('pw-cos-shot-keep', screenshotKeepStream ? '1' : '0'); } catch { /* ignore */ } }, [screenshotKeepStream]);

  async function captureAndAttachScreenshot() {
    if (capturingScreenshot) return;
    setCapturingScreenshot(true);
    try {
      const blob = await captureScreenshot({
        method: screenshotMethod,
        excludeWidget: screenshotExcludeWidget,
        excludeCursor: screenshotExcludeCursor,
        keepStream: screenshotMethod === 'display-media' && screenshotKeepStream,
      });
      if (!blob) {
        chiefOfStaffError.value = 'Screenshot capture failed';
        return;
      }
      await opts.onAttachBlob(blob, `screenshot-${Date.now()}.png`);
    } catch (err: any) {
      chiefOfStaffError.value = `Screenshot failed: ${err?.message || err}`;
    } finally {
      setCapturingScreenshot(false);
    }
  }

  async function startTimedScreenshot(seconds: number) {
    if (capturingScreenshot) return;
    opts.closeCameraMenu();
    setCapturingScreenshot(true);
    try {
      for (let i = seconds; i > 0; i--) {
        chiefOfStaffError.value = `Screenshot in ${i}…`;
        await new Promise((r) => setTimeout(r, 1000));
      }
      chiefOfStaffError.value = '';
      const blob = await captureScreenshot({
        method: screenshotMethod,
        excludeWidget: screenshotExcludeWidget,
        excludeCursor: screenshotExcludeCursor,
        keepStream: screenshotMethod === 'display-media' && screenshotKeepStream,
      });
      if (!blob) {
        chiefOfStaffError.value = 'Screenshot capture failed';
        return;
      }
      await opts.onAttachBlob(blob, `screenshot-${Date.now()}.png`);
    } catch (err: any) {
      chiefOfStaffError.value = `Screenshot failed: ${err?.message || err}`;
    } finally {
      setCapturingScreenshot(false);
    }
  }

  return {
    capturingScreenshot,
    screenshotExcludeWidget,
    setScreenshotExcludeWidget,
    screenshotExcludeCursor,
    setScreenshotExcludeCursor,
    screenshotMethod,
    setScreenshotMethod,
    screenshotKeepStream,
    setScreenshotKeepStream,
    captureAndAttachScreenshot,
    startTimedScreenshot,
  };
}
