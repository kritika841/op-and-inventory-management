import { getEnv } from "@/lib/database";
import { storeShopifyToken, verifyHmacHex } from "@/lib/integrations";
import { authorizeRequest } from "@/lib/auth";

function cookie(request: Request, name: string) {
  return (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim().split("=")).find(([key]) => key === name)?.[1] ?? null;
}

export async function GET(request: Request) {
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]);
  if ("response" in auth) return auth.response;
  const runtime = getEnv();
  const url = new URL(request.url);
  const hmac = url.searchParams.get("hmac") ?? "";
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const shop = url.searchParams.get("shop");
  const message = [...url.searchParams.entries()].filter(([key]) => key !== "hmac").sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("&");
  if (!state || state !== cookie(request, "shopify_oauth_state") || !code || !shop || !runtime.SHOPIFY_CLIENT_SECRET || !await verifyHmacHex(message, hmac, runtime.SHOPIFY_CLIENT_SECRET)) return new Response("Invalid Shopify callback", { status: 400 });
  if (shop !== runtime.SHOPIFY_SHOP_DOMAIN) return new Response("Unexpected Shopify shop", { status: 400 });
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: runtime.SHOPIFY_CLIENT_ID, client_secret: runtime.SHOPIFY_CLIENT_SECRET, code }) });
  const payload = await response.json() as { access_token?: string };
  if (!response.ok || !payload.access_token) return new Response("Shopify token exchange failed", { status: 502 });
  await storeShopifyToken(payload.access_token);
  return Response.redirect(new URL("/?connected=shopify", request.url), 302);
}
