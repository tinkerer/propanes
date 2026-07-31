import { updateAvailable } from '../../lib/update-check.js';

/** Small fixed pill shown when a newer admin bundle has been deployed while
 *  this tab was open. Reload is explicit — never automatic. */
export function UpdateBanner() {
  if (!updateAvailable.value) return null;
  return (
    <div class="pw-update-banner" role="status">
      <span class="pw-update-banner-label">Admin UI updated</span>
      <button
        type="button"
        class="pw-update-banner-reload"
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
      <button
        type="button"
        class="pw-update-banner-dismiss"
        onClick={() => { updateAvailable.value = false; }}
        title="Dismiss"
        aria-label="Dismiss update notice"
      >
        &times;
      </button>
    </div>
  );
}
