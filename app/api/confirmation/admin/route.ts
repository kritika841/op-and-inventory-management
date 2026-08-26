import { rejectCrossOrigin, authorizeRequest } from "@/lib/auth";
import { backfillRequirementSnapshots, overrideRecallCooldown, reviewOrderEditRequest, updateRecallCooldownSettings } from "@/lib/state";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]);
  if ("response" in auth) return auth.response;
  try {
    const body = await request.json() as { action?: string; payload?: Record<string, unknown> };
    if (body.action === "review-edit") return Response.json({ ok: true, ...(await reviewOrderEditRequest(auth.user, body.payload ?? {})) });
    if (body.action === "update-cooldown") return Response.json({ ok: true, ...(await updateRecallCooldownSettings(auth.user, body.payload ?? {})) });
    if (body.action === "override-cooldown") return Response.json({ ok: true, ...(await overrideRecallCooldown(auth.user, body.payload ?? {})) });
    if (body.action === "backfill-requirements") return Response.json({ ok: true, ...(await backfillRequirementSnapshots(auth.user)) });
    return Response.json({ error: "Unsupported confirmation admin action" }, { status: 400 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Confirmation admin action failed";
    return Response.json({ error: detail }, { status: 422 });
  }
}
