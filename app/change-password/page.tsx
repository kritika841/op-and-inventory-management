"use client";

import { FormEvent, useState } from "react";

export default function ChangePasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) return setError("Passwords do not match");
    const response = await fetch("/auth/change-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    const result = await response.json();
    if (!response.ok) return setError(result.error || "Could not change password");
    window.location.href = "/";
  }

  return <main className="auth-page compact"><section className="auth-panel"><form className="auth-card" onSubmit={submit}>
    <div className="brand-mark">S</div><div><p className="eyebrow">FIRST SIGN-IN</p><h2>Choose a new password</h2><p className="muted">Use at least 10 characters. Your temporary password will stop working.</p></div>
    <label>New password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} required/></label>
    <label>Confirm password<input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} minLength={10} required/></label>
    {error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button full">Save and enter workspace</button>
  </form></section></main>;
}
