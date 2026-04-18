import { signal } from '@preact/signals';
import { api } from '../lib/api.js';
import { setToken, navigate, isEmbedded } from '../lib/state.js';

const username = signal('');
const password = signal('');
const error = signal('');
const loading = signal(false);

export function LoginPage() {
  async function handleLogin(e: Event) {
    e.preventDefault();
    error.value = '';
    loading.value = true;
    try {
      const result = await api.login(username.value, password.value);
      setToken(result.token);
      if (isEmbedded.value) {
        window.parent.postMessage({ type: 'pw-embed-auth', token: result.token }, '*');
      }
      navigate('/');
    } catch (err: any) {
      error.value = err.message || 'Login failed';
    } finally {
      loading.value = false;
    }
  }

  return (
    <div class="login-page">
      <form class="login-card" onSubmit={handleLogin}>
        <h2>Admin Login</h2>
        {error.value && <div class="error-msg">{error.value}</div>}
        <div class="form-group">
          <label>Username</label>
          <input
            type="text"
            value={username.value}
            onInput={(e) => (username.value = (e.target as HTMLInputElement).value)}
            autoFocus
          />
        </div>
        <div class="form-group">
          <label>Password</label>
          <input
            type="password"
            value={password.value}
            onInput={(e) => (password.value = (e.target as HTMLInputElement).value)}
          />
        </div>
        <button class="btn btn-primary" style="width:100%" disabled={loading.value}>
          {loading.value ? 'Logging in...' : 'Login'}
        </button>
      </form>
    </div>
  );
}
