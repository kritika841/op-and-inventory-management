import { rejectCrossOrigin, authorizeRequest } from "@/lib/auth";
import { completeRto } from "@/lib/state";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER", "WAREHOUSE"]);
  if ("response" in auth) return auth.response;
  const user = auth.user;
  const { id } = await context.params;
  const body = await request.json() as { lines?: Array<{ orderLineId: string; goodQuantity: number; damagedQuantity: number }>; manualReceipts?: Array<{ componentId: string; quantity: number }>; note?: string };
  try { await completeRto(user, id, body); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "QC could not be completed" }, { status: 400 }); }
  return Response.json({ ok: true });
}
