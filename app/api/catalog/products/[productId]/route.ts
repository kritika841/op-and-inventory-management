import { authorizeRequest, rejectCrossOrigin } from "@/lib/auth";
import { deactivateProduct } from "@/lib/components";

export async function POST(request: Request, context: { params: Promise<{ productId: string }> }) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]); if ("response" in auth) return auth.response;
  const { productId } = await context.params;
  try { await deactivateProduct(auth.user, productId); return Response.json({ ok: true }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Product could not be deleted" }, { status: 400 }); }
}
