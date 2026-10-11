'use client';
import { useState } from 'react';
import Logo from '../../components/Logo';

export default function LoginPage() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(e.currentTarget);
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
    });
    if (res.ok) {
      const next = new URLSearchParams(window.location.search).get('next') || '/dashboard';
      window.location.assign(next);
    } else {
      setBusy(false);
      setError((await res.json()).error || 'Login failed');
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={onSubmit} aria-label="Sign in">
        <Logo />
        <h1>Welcome back</h1>
        <p className="muted">Sign in to your workspace</p>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required placeholder="you@company.com" />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small">Demo: demo@reelkit.dev / reelkit-demo</p>
      </form>
    </main>
  );
}
