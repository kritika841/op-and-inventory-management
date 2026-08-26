import { authorizeRequest, rejectCrossOrigin } from "@/lib/auth";
import { saveRecipe } from "@/lib/components";
import { readJsonBody } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ productId: string }> }) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]); if ("response" in auth) return auth.response;
  const { productId } = await context.params; const parsed = await readJsonBody<{ packagingProfileId?: string; packingUnits?: number; items?: Array<{ componentId: string; quantity: number }>; applyTo?: "new" | "unshipped" }>(request); if (!parsed.ok) return parsed.response; const body = parsed.value;
  try { return Response.json({ ok: true, ...(await saveRecipe(auth.user, productId, { packagingProfileId: body.packagingProfileId ?? "", packingUnits: Number(body.packingUnits), items: body.items ?? [], applyTo: body.applyTo === "unshipped" ? "unshipped" : "new" })) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Recipe could not be saved" }, { status: 400 }); }
}
