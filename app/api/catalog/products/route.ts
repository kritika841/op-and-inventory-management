import { authorizeRequest, rejectCrossOrigin } from "@/lib/auth";
import { createProductWithRecipe } from "@/lib/components";
import { readJsonBody } from "@/lib/http";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]); if ("response" in auth) return auth.response;
  const parsed = await readJsonBody<{ name?: string; sku?: string; variant?: string; packagingProfileId?: string; items?: Array<{ componentId?: string; quantity?: number }> }>(request); if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  try {
    const id = await createProductWithRecipe(auth.user, { name: body.name ?? "", sku: body.sku ?? "", variant: body.variant, packagingProfileId: body.packagingProfileId ?? "", items: (body.items ?? []).map((item) => ({ componentId: item.componentId ?? "", quantity: Number(item.quantity) })) });
    return Response.json({ ok: true, id });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Product could not be created" }, { status: 400 }); }
}
