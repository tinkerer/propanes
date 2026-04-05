// admin-ws.ts — WebSocket client for /ws/admin push notifications

type Callback = (data: any) => void;

const subscribers = new Map<string, Set<Callback>>();
let ws: WebSocket | null = null;
let token: string | null = null;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityHandler: (() => void) | null = null;

export function connectAdminWs() {
  token = localStorage.getItem('pw-admin-token');
  if (!token) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws/admin?token=${encodeURIComponent(token)}`;

  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectDelay = 1000;
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      const { topic, data } = msg;
      const cbs = subscribers.get(topic);
      if (cbs) {
        for (const cb of cbs) {
          try { cb(data); } catch { /* ignore callback errors */ }
        }
      }
    } catch {
      // ignore malformed messages
    }
  };

  ws.onclose = () => {
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after onerror
  };

  if (!visibilityHandler) {
    visibilityHandler = () => {
      if (document.hidden) {
        // Disconnect when tab is hidden to save resources
        if (ws) {
          ws.close();
          ws = null;
        }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      } else {
        // Reconnect when tab becomes visible
        if (!ws) {
          reconnectDelay = 1000;
          connectAdminWs();
        }
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (document.hidden) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30_000);
    connectAdminWs();
  }, reconnectDelay);
}

export function subscribeAdmin(topic: string, cb: Callback): () => void {
  if (!subscribers.has(topic)) {
    subscribers.set(topic, new Set());
  }
  subscribers.get(topic)!.add(cb);
  return () => {
    const set = subscribers.get(topic);
    if (set) {
      set.delete(cb);
      if (set.size === 0) subscribers.delete(topic);
    }
  };
}

export function disconnectAdminWs() {
  if (ws) {
    ws.close();
    ws = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  subscribers.clear();
}

export function isAdminWsConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}
