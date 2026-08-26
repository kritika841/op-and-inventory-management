import { authorizeRequest } from "@/lib/auth";
import { ensureDatabase, getEnv } from "@/lib/database";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]);
  if ("response" in auth) return auth.response;
  await ensureDatabase();

  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const db = getEnv().DB;
  const [events, total] = await Promise.all([
    db.prepare(`SELECT a.*,u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id
      ORDER BY a.created_at DESC LIMIT ?1 OFFSET ?2`).bind(limit, offset).all<Record<string, unknown>>(),
    db.prepare("SELECT COUNT(*) AS count FROM audit_events").first<{ count: number }>(),
  ]);

  return Response.json({
    events: events.results.map((row) => ({
      id: String(row.id), action: String(row.action), detail: row.detail ? String(row.detail) : null,
      createdAt: String(row.created_at), actorName: row.actor_name ? String(row.actor_name) : null,
    })),
    total: Number(total?.count || 0), limit, offset,
  }, { headers: { "cache-control": "no-store" } });
}
