import { authorizeRequest } from "@/lib/auth";
import { ensureDatabase, getEnv } from "@/lib/database";
import { checkShiprocketConnectivity } from "@/lib/integrations";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]);
  if ("response" in auth) return auth.response;

  const startedAt = Date.now();
  try {
    await ensureDatabase();
    const db = getEnv().DB;
    await db.prepare("SELECT 1 AS ok").first();
    const [integrations, cursors, diagnostics, newestOrder] = await Promise.all([
      db.prepare("SELECT provider,status,detail,last_synced_at,updated_at FROM integration_state ORDER BY provider").all<Record<string, unknown>>(),
      db.prepare("SELECT provider,full_backfill_complete,last_success_at,last_error,updated_at FROM integration_sync_cursors ORDER BY provider").all<Record<string, unknown>>(),
      db.prepare("SELECT action,detail,created_at FROM audit_events WHERE action LIKE 'webhook.%' OR action='integrations.scheduled-sync' ORDER BY created_at DESC LIMIT 40").all<Record<string, unknown>>(),
      db.prepare("SELECT MAX(created_at) AS latest_order_at FROM orders").first<Record<string, unknown>>(),
    ]);

    let shiprocket: Record<string, unknown>;
    try { shiprocket = await checkShiprocketConnectivity(); }
    catch (error) { shiprocket = { ok: false, error: error instanceof Error ? error.message : "Shiprocket health check failed" }; }

    let integrationResults = integrations.results;
    if (shiprocket.ok === true) {
      const now = new Date().toISOString();
      await db.prepare(
        "UPDATE integration_state SET status='connected',detail='API connected',updated_at=?1 WHERE provider='shiprocket'",
      ).bind(now).run();
      integrationResults = integrationResults.map((row) => row.provider === "shiprocket"
        ? { ...row, status: "connected", detail: "API connected", updated_at: now }
        : row);
    }
    const integrationHealthy = integrationResults.every((row) => row.status === "connected") && shiprocket.ok === true;
    return Response.json({
      ok: integrationHealthy,
      database: { ok: true, provider: "supabase-postgres", latencyMs: Date.now() - startedAt },
      integrations: integrationResults,
      cursors: cursors.results,
      newestLocalOrderAt: newestOrder?.latest_order_at ? String(newestOrder.latest_order_at) : null,
      diagnostics: diagnostics.results.map((row) => ({ action: String(row.action), detail: row.detail ? String(row.detail) : null, createdAt: String(row.created_at) })),
      shiprocket,
      checkedAt: new Date().toISOString(),
    }, { status: integrationHealthy ? 200 : 503, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({
      ok: false,
      database: { ok: false, provider: "supabase-postgres", error: error instanceof Error ? error.message : "Database health check failed" },
      checkedAt: new Date().toISOString(),
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
