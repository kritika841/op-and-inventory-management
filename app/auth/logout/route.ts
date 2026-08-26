import { clearSessionCookie, logout, rejectCrossOrigin } from "@/lib/auth";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  await logout(request);
  return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}
