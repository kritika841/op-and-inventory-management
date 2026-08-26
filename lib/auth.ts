import { ensureAuthDatabase, getEnv, requiredEnv } from "./database";
import { hashPassword, randomHex, safeEqual, sha256 } from "./crypto";
import type { AppUser, Role } from "./types";

const SESSION_COOKIE = "satmi_session";
const SESSION_HOURS = 12;

function parseCookie(request: Request, name: string) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(value.join("=")); }
      catch { return null; }
    }
  }
  return null;
}

export async function authenticateRequest(request: Request): Promise<AppUser | null> {
  const token = parseCookie(request, SESSION_COOKIE);
  if (!token) return null;
  // The session lookup below is itself the database readiness check. Avoid a
  // separate SELECT before every authenticated page/API request: two serial
  // pooler round trips made the post-login dashboard intermittently fail.
  requiredEnv("SESSION_SECRET");
  const tokenHash = await sha256(`${token}${requiredEnv("SESSION_SECRET")}`);
  const row = await getEnv().DB.prepare(
    `SELECT u.id,u.email,u.name,u.role,u.active,u.must_change_password FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?1 AND s.expires_at>?2 AND u.active=1`,
  ).bind(tokenHash, new Date().toISOString()).first<Record<string, unknown>>();
  if (!row) return null;
  return { id: String(row.id), email: String(row.email), name: String(row.name), role: String(row.role) as Role, active: Boolean(row.active), mustChangePassword: Boolean(row.must_change_password) };
}

export async function authorizeRequest(request: Request, roles?: Role[], allowPasswordChange = false) {
  const user = await authenticateRequest(request);
  if (!user) return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  if (user.mustChangePassword && !allowPasswordChange) return { response: Response.json({ error: "Password change required" }, { status: 428 }) } as const;
  // ADMIN is intentionally universal. Keeping this rule at the authorization
  // boundary prevents a future route-specific role list from locking the
  // system administrator out of inventory or operations controls.
  if (roles && user.role !== "ADMIN" && !roles.includes(user.role)) return { response: Response.json({ error: "Forbidden" }, { status: 403 }) } as const;
  return { user } as const;
}

export async function login(email: string, password: string) {
  await ensureAuthDatabase();
  const normalizedEmail = email.trim().toLowerCase();
  const row = await getEnv().DB.prepare("SELECT * FROM users WHERE email=?1 AND active=1").bind(normalizedEmail).first<Record<string, unknown>>();
  if (!row) return { ok: false as const, error: "Invalid email or password" };

  const lockedUntil = row.locked_until ? new Date(String(row.locked_until)) : null;
  if (lockedUntil && lockedUntil > new Date()) return { ok: false as const, error: "Account temporarily locked. Try again shortly." };

  const candidate = await hashPassword(password, String(row.password_salt), requiredEnv("PASSWORD_PEPPER"));
  if (!safeEqual(candidate, String(row.password_hash))) {
    const attempts = Number(row.failed_attempts ?? 0) + 1;
    const nextLock = attempts >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    await getEnv().DB.prepare("UPDATE users SET failed_attempts=?1,locked_until=?2 WHERE id=?3").bind(nextLock ? 0 : attempts, nextLock, row.id).run();
    return { ok: false as const, error: "Invalid email or password" };
  }

  await getEnv().DB.prepare("UPDATE users SET failed_attempts=0,locked_until=NULL WHERE id=?1").bind(row.id).run();
  const token = randomHex(32);
  const tokenHash = await sha256(`${token}${requiredEnv("SESSION_SECRET")}`);
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000).toISOString();
  await getEnv().DB.prepare("INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?1,?2,?3,?4)").bind(tokenHash, row.id, expiresAt, new Date().toISOString()).run();
  return { ok: true as const, token, mustChangePassword: Boolean(row.must_change_password) };
}

export async function changePassword(request: Request, password: string) {
  const auth = await authorizeRequest(request, undefined, true);
  if ("response" in auth) return { ok: false as const, error: "Session expired", status: auth.response?.status ?? 401 };
  const user = auth.user;
  if (password.length < 10) return { ok: false as const, error: "Use at least 10 characters" };
  const salt = randomHex(16);
  const passwordHash = await hashPassword(password, salt, requiredEnv("PASSWORD_PEPPER"));
  await getEnv().DB.prepare("UPDATE users SET password_hash=?1,password_salt=?2,must_change_password=0 WHERE id=?3").bind(passwordHash, salt, user.id).run();
  return { ok: true as const };
}

export async function logout(request: Request) {
  const token = parseCookie(request, SESSION_COOKIE);
  if (!token) return;
  const tokenHash = await sha256(`${token}${requiredEnv("SESSION_SECRET")}`);
  await getEnv().DB.prepare("DELETE FROM sessions WHERE token_hash=?1").bind(tokenHash).run();
}

export function sessionCookie(token: string, request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function rejectCrossOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return null;

  // Always allow same-origin requests
  const requestOrigin = new URL(request.url).origin;
  if (origin === requestOrigin) return null;

  // Check APP_BASE_URL
  const envUrl = getEnv().APP_BASE_URL;
  if (envUrl && origin === envUrl) return null;

  // Check APP_ALLOWED_ORIGINS (comma-separated list)
  const allowedOrigins = (getEnv().APP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o: string) => o.trim())
    .filter(Boolean);
  if (allowedOrigins.includes(origin)) return null;

  // Check x-forwarded-host (ngrok/proxy)
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
  if (forwardedHost && origin === `${forwardedProto}://${forwardedHost}`) return null;

  return Response.json({ error: "Invalid origin" }, { status: 403 });
}
