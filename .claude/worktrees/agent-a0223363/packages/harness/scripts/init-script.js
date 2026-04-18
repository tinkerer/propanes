// Playwright --init-script: runs before every page's own scripts.
// Injects the prompt-widget if not already present (e.g., admin page has it embedded).
(function () {
  // Configurable via env-substituted globals (set by entrypoint or defaults)
  var serverUrl = window.__PW_SERVER_URL || 'http://pw-server:3001';
  var appKey = window.__PW_APP_KEY || '';

  function inject() {
    // Skip if widget script already exists on this page
    if (document.querySelector('script[src*="prompt-widget"]')) return;

    var s = document.createElement('script');
    s.src = serverUrl + '/widget/prompt-widget.js';
    s.dataset.endpoint = serverUrl + '/api/v1/feedback';
    if (appKey) s.dataset.appKey = appKey;
    s.dataset.mode = 'always';
    s.dataset.screenshotIncludeWidget = 'false';
    document.body.appendChild(s);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
