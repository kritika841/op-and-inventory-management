"use client";

import { FormEvent, useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    let response: Response;
    const controller = new AbortController();
    // The server has a shorter deadline. This is a final browser-side safety
    // net in case a proxy drops a response rather than returning an error.
    // Leave a small margin above the server's bounded login deadline so the
    // user receives the server's clear error instead of a browser abort.
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      response = await fetch("/auth/login", { method: "POST", credentials: "same-origin", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    } catch (error) {
      setBusy(false);
      return setError(error instanceof DOMException && error.name === "AbortError" ? "Sign-in took too long. Please try again." : "The server could not be reached. Refresh the page and try again.");
    } finally {
      window.clearTimeout(timeout);
    }
    const result = await response.json().catch(() => ({ error: "The server returned an invalid response. Refresh the page and try again." }));
    setBusy(false);
    if (!response.ok) return setError(result.error || (response.status >= 500 ? "Sign-in is temporarily unavailable. Please try again in a moment." : "Could not sign in"));
    window.location.href = result.mustChangePassword ? "/change-password" : "/";
  }

  return <main className="auth-page">
    <section className="auth-brand">
      <div className="brand-mark large">S</div>
      <p className="eyebrow">SATMI OPERATIONS</p>
      <h1>Every order.<br/>One clear next step.</h1>
      <p>Confirm orders, hand labels to the warehouse, reconcile inventory and follow every RTO back to stock.</p>
      <div className="auth-flow"><span>Order</span><i/> <span>Confirm</span><i/> <span>Ship</span><i/> <span>Deliver</span></div>
    </section>
    <section className="auth-panel">
      <form className="auth-card" onSubmit={submit}>
        <div><p className="eyebrow">SECURE WORKSPACE</p><h2>Sign in to continue</h2><p className="muted">Use your assigned employee or administrator account.</p></div>
        <label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required/></label>
        <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required/></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <div className="demo-note"><span className="live-dot"/>External actions are role-gated and audited.</div>
      </form>
    </section>
  </main>;
}
