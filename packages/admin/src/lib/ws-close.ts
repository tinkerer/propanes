// ws-close.ts — close a browser WebSocket without the console noise.
//
// Calling close() on a socket that is still CONNECTING is legal, but Chrome
// logs "WebSocket is closed before the connection is established" as a
// console error every time. The admin does this constantly and legitimately:
// a terminal pane unmounts while its socket is still in flight, a tab hides,
// a wake event forces a fresh socket. On a slow server the connecting window
// is long enough that the console fills with these and buries real errors.
//
// For a CONNECTING socket, detach every handler (nothing it does from here on
// is ours to observe) and close it as soon as the handshake finishes — or
// let the browser discard it if the handshake fails. OPEN sockets close now.

const CONNECTING = 0;
const CLOSING = 2;
const CLOSED = 3;

export function closeSocketQuietly(ws: WebSocket | null | undefined): void {
  if (!ws) return;
  if (ws.readyState === CLOSING || ws.readyState === CLOSED) return;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  if (ws.readyState === CONNECTING) {
    ws.onopen = () => { try { ws.close(); } catch { /* already closing */ } };
    return;
  }
  ws.onopen = null;
  try { ws.close(); } catch { /* already closing */ }
}
