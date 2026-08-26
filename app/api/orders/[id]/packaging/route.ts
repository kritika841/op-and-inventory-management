import { authorizeRequest, rejectCrossOrigin } from "@/lib/auth";
import { confirmPackagingPlan } from "@/lib/components";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER", "OPERATIONS"]); if ("response" in auth) return auth.response;
  const { id } = await context.params; const body = await request.json() as { lines?: Array<{ componentId: string; quantity: number }> };
  try { await confirmPackagingPlan(auth.user, id, body.lines ?? []); return Response.json({ ok: true }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Packaging plan could not be confirmed" }, { status: 400 }); }
}
