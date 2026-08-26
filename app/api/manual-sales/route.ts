import { authorizeRequest, rejectCrossOrigin } from "@/lib/auth";
import { createManualSale } from "@/lib/manual-sales";
import { readJsonBody } from "@/lib/http";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER", "OPERATIONS", "WAREHOUSE"]); if ("response" in auth) return auth.response;
  const parsed = await readJsonBody<{ reference?: string; productId?: string; quantity?: number }>(request); if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  try { return Response.json({ ok: true, id: await createManualSale(auth.user, { reference: body.reference ?? "", productId: body.productId ?? "", quantity: Number(body.quantity) }) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Manual sale could not be created" }, { status: 400 }); }
}
