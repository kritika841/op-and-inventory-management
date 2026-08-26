import { authorizeRequest, rejectCrossOrigin } from "@/lib/auth";
import { updateManualSaleStatus } from "@/lib/manual-sales";

export async function POST(request: Request, context: { params: Promise<{ saleId: string }> }) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER", "OPERATIONS", "WAREHOUSE"]); if ("response" in auth) return auth.response;
  const body = await request.json() as { status?: string }; const { saleId } = await context.params;
  if (body.status !== "delivered" && body.status !== "rto") return Response.json({ error: "Choose Delivered or RTO" }, { status: 400 });
  try { await updateManualSaleStatus(auth.user, saleId, body.status); return Response.json({ ok: true }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Sale status could not be updated" }, { status: 400 }); }
}
