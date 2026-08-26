import { rejectCrossOrigin, authorizeRequest } from "@/lib/auth";
import { adjustComponentInventory } from "@/lib/components";
import { readJsonBody } from "@/lib/http";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER", "WAREHOUSE"]);
  if ("response" in auth) return auth.response;
  const user = auth.user;
  const parsed = await readJsonBody<{ componentId?: string; quantity?: number; reason?: string }>(request); if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (!body.componentId || !Number.isInteger(body.quantity) || !body.reason?.trim()) return Response.json({ error: "Component, whole-unit quantity, and reason are required" }, { status: 400 });
  try {
    await adjustComponentInventory(user, body.componentId, Number(body.quantity), body.reason.trim());
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Inventory adjustment failed" }, { status: 400 });
  }
}
