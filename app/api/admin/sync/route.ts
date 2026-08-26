import { rejectCrossOrigin, authorizeRequest } from "@/lib/auth";
import { beginIntegrationSync } from "@/lib/state";
import { getRequestExecutionContext } from "vinext/shims/request-context";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER", "WAREHOUSE"]);
  if ("response" in auth) return auth.response;
  const user = auth.user;
  const sync = beginIntegrationSync(user);
  const context = getRequestExecutionContext();
  if (process.env.NODE_ENV === "production") {
    context?.waitUntil(sync.promise);
    return Response.json({ ok: true, started: sync.started }, { status: sync.started ? 202 : 200 });
  }
  // In local dev the Worker context is terminated when the handler returns,
  // killing fire-and-forget promises. Await directly so the sync completes.
  if (sync.promise) {
    try { await sync.promise; }
    catch (err: unknown) { console.error("[sync error]", err instanceof Error ? err.stack : err); }
  }
  return Response.json({ ok: true, started: sync.started }, { status: 200 });
}
