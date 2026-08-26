import { rejectCrossOrigin, authorizeRequest } from "@/lib/auth";
import { ensureDatabase, getEnv } from "@/lib/database";
import { isSampleMode, syncOrderFromShiprocket, tagShopifyOrder } from "@/lib/integrations";
import { mutateOrder } from "@/lib/state";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER", "CONFIRMATION_AGENT", "OPERATIONS", "WAREHOUSE"]);
  if ("response" in auth) return auth.response;
  const user = auth.user;
  const { id } = await context.params;
  let actionName = "unknown";
  try {
    const body = await request.json() as { action: string; payload?: Record<string, unknown> };
    actionName = body.action;
    const permitted: Record<string, string[]> = {
      outcome: ["ADMIN", "MANAGER", "CONFIRMATION_AGENT"],
      "request-edit": ["ADMIN", "MANAGER", "CONFIRMATION_AGENT"],
      "sync-shiprocket": ["ADMIN", "MANAGER", "OPERATIONS"],
      "fetch-label": ["ADMIN", "MANAGER", "OPERATIONS"],
      "warehouse-ack": ["ADMIN", "MANAGER", "WAREHOUSE"],
      "manifest": ["ADMIN", "MANAGER", "OPERATIONS"]
    };
    if (!permitted[body.action]?.includes(user.role)) return Response.json({ error: "This action is not available for your role" }, { status: 403 });
    if (user.role === "CONFIRMATION_AGENT") {
      await ensureDatabase();
      const order = await getEnv().DB.prepare("SELECT assigned_agent_id FROM campaign_assignments WHERE order_id=?1").bind(id).first<{ assigned_agent_id: string | null }>();
      if (!order || order.assigned_agent_id !== user.id) return Response.json({ error: "This order is not assigned to you" }, { status: 403 });
    }
    if (body.action === "sync-shiprocket") {
      if (isSampleMode()) await mutateOrder(user, id, "sample-shiprocket", {});
      else await syncOrderFromShiprocket(id);
    } else await mutateOrder(user, id, body.action, body.payload ?? {});
    if (body.action === "outcome" && ["confirmed", "cancelled"].includes(String(body.payload?.outcome))) {
      const row = await getEnv().DB.prepare("SELECT shopify_order_id FROM orders WHERE id=?1").bind(id).first<{ shopify_order_id: string | null }>();
      if (row?.shopify_order_id) await tagShopifyOrder(row.shopify_order_id, String(body.payload?.outcome));
    }
    return Response.json({ ok: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Order action failed";
    console.error("Order action failed", { action: actionName, id, detail });
    return Response.json({ error: detail }, { status: 422 });
  }
}
