import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.js';
import { ErrorLine } from '../ui.js';

function PasswordForm(props: {
  title: string;
  hint: string;
  submitLabel: string;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form onSubmit={submit} className="card">
        <h1>LiveSync Manager</h1>
        <h2>{props.title}</h2>
        <p className="muted">{props.hint}</p>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
          />
        </label>
        <ErrorLine error={error} />
        <button type="submit" disabled={busy}>
          {busy ? 'Working...' : props.submitLabel}
        </button>
      </form>
    </main>
  );
}

export function SetupPage(props: { onDone: () => void }) {
  return (
    <PasswordForm
      title="First-boot setup"
      hint="Choose the admin password (at least 12 characters). Back up this server's data directory afterwards; it holds the master key."
      submitLabel="Set password"
      onSubmit={async (password) => {
        await api.post('/auth/setup', { password });
        props.onDone();
      }}
    />
  );
}

export function LoginPage(props: { onDone: () => void }) {
  return (
    <PasswordForm
      title="Sign in"
      hint="Admin password."
      submitLabel="Sign in"
      onSubmit={async (password) => {
        await api.post('/auth/login', { password });
        props.onDone();
      }}
    />
  );
}
