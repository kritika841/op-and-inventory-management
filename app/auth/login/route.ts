import { login, rejectCrossOrigin, sessionCookie } from "@/lib/auth";

// A valid sign-in performs password verification plus two durable writes. The
// Supabase transaction pool can take several seconds to acquire a fresh
// connection after an idle period, so keep this comfortably above the browser
// deadline while still returning a bounded, actionable failure.
const LOGIN_TIMEOUT_MS = 25_000;

function withinLoginDeadline<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("LOGIN_TIMEOUT")), LOGIN_TIMEOUT_MS);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function POST(request: Request) {
  try {
    const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
    const body = await request.json() as { email?: string; password?: string };
    const result = await withinLoginDeadline(login(body.email ?? "", body.password ?? ""));
    if (!result.ok) return Response.json(result, { status: 401 });
    const headers = new Headers();
    headers.set("set-cookie", sessionCookie(result.token, request));
    return Response.json({ ok: true, mustChangePassword: result.mustChangePassword }, { headers });
  } catch (error) {
    console.error("[auth/login] failed", error);
    const timedOut = error instanceof Error && error.message === "LOGIN_TIMEOUT";
    return Response.json({ ok: false, error: timedOut ? "The sign-in service did not respond in time. Please try again; no account changes were made." : "Sign-in is temporarily unavailable. Please try again in a moment." }, { status: 503 });
  }
}
