import { getEnv } from "@/lib/database";
import { randomHex } from "@/lib/crypto";
import { authorizeRequest } from "@/lib/auth";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]);
  if ("response" in auth) return auth.response;
  const runtime = getEnv();
  if (!runtime.SHOPIFY_CLIENT_ID || !runtime.SHOPIFY_SHOP_DOMAIN) return new Response("Shopify OAuth is not configured", { status: 503 });
  const state = randomHex(20);
  const callback = runtime.SHOPIFY_REDIRECT_URI || `${new URL(request.url).origin}/auth/shopify/callback`;
  const url = new URL(`https://${runtime.SHOPIFY_SHOP_DOMAIN}/admin/oauth/authorize`);
  url.searchParams.set("client_id", runtime.SHOPIFY_CLIENT_ID);
  url.searchParams.set("scope", "read_products,read_orders,write_orders");
  url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: url.toString(), "set-cookie": `shopify_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600` } });
}
