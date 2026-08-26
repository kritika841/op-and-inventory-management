import { authorizeRequest } from "@/lib/auth";
import { getSnapshot, type FulfillmentQueue } from "@/lib/state";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if ("response" in auth) return auth.response;
  const search = new URL(request.url).searchParams;
  const scope = search.get("scope");
  const rawLimit = Number(search.get("limit") || 75);
  const rawOffset = Number(search.get("offset") || 0);
  const rawQueue = search.get("queue") || "all";
  const queue = (["all", "new-orders", "labels-generated", "shipped", "confirmed-orders", "campaign-selection"].includes(rawQueue) ? rawQueue : "all") as FulfillmentQueue;
  const limit = scope === "all" ? 0 : Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 75;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  return Response.json(await getSnapshot(auth.user, limit, offset, queue), { headers: { "cache-control": "no-store" } });
}
