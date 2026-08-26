import { authorizeRequest, rejectCrossOrigin } from "@/lib/auth";
import { syncShopifyProducts } from "@/lib/integrations";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]);
  if ("response" in auth) return auth.response;

  try {
    const result = await syncShopifyProducts(auth.user.id);
    return Response.json(result);
  } catch (error) {
    console.error("[Shopify Product Sync Error]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Shopify product catalog import failed" },
      { status: 500 }
    );
  }
}
