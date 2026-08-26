import { authorizeRequest, rejectCrossOrigin } from "@/lib/auth";
import { adjustComponentInventory, createOrUpdateComponent } from "@/lib/components";
import type { ComponentType } from "@/lib/types";
import { readJsonBody } from "@/lib/http";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]); if ("response" in auth) return auth.response;
  const parsed = await readJsonBody<{ id?: string; sku?: string; name?: string; componentType?: ComponentType; unit?: string; rtoRecoverable?: boolean; active?: boolean; openingQuantity?: number }>(request); if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const openingQuantity = Number(body.openingQuantity ?? 0);
  if (!Number.isInteger(openingQuantity) || openingQuantity < 0) return Response.json({ error: "Opening stock must be a positive whole number or zero" }, { status: 400 });
  try { const id = await createOrUpdateComponent(auth.user, { id: body.id, sku: body.sku ?? "", name: body.name ?? "", componentType: body.componentType ?? "OTHER", unit: body.unit, rtoRecoverable: body.rtoRecoverable !== false, active: body.active }); if (!body.id && openingQuantity > 0) await adjustComponentInventory(auth.user, id, openingQuantity, "Opening stock", "opening"); return Response.json({ ok: true, id }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Component could not be saved" }, { status: 400 }); }
}
