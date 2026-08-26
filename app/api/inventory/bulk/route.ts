import { rejectCrossOrigin, authorizeRequest } from "@/lib/auth";
import { bulkSetComponentInventory } from "@/lib/components";
import { readJsonBody } from "@/lib/http";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER", "WAREHOUSE"]); if ("response" in auth) return auth.response;
  const parsed = await readJsonBody<{ items?: Array<{ componentId?: string; onHand?: number }> }>(request); if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  try {
    const changed = await bulkSetComponentInventory(auth.user, (body.items ?? []).map((item) => ({ componentId: item.componentId ?? "", onHand: Number(item.onHand) })));
    return Response.json({ ok: true, changed });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Bulk inventory adjustment failed" }, { status: 400 }); }
}
