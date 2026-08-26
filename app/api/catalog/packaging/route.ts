import { authorizeRequest, rejectCrossOrigin } from "@/lib/auth";
import { createPackagingProfile, upsertBoxOption } from "@/lib/components";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]); if ("response" in auth) return auth.response;
  const body = await request.json() as { action?: string; name?: string; profileId?: string; componentId?: string; capacity?: number; boxes?: Array<{ componentId: string; capacity: number }> };
  try {
    if (body.action === "create-profile") return Response.json({ ok: true, id: await createPackagingProfile(auth.user, body.name ?? "") });
    if (body.action === "save-box") { await upsertBoxOption(auth.user, body.profileId ?? "", body.componentId ?? "", Number(body.capacity)); return Response.json({ ok: true }); }
    if (body.action === "save-boxes") {
      if (!body.boxes?.length) throw new Error("At least one courier-box rule is required");
      for (const box of body.boxes) await upsertBoxOption(auth.user, body.profileId ?? "", box.componentId, Number(box.capacity));
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unsupported packaging action" }, { status: 400 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Packaging rule could not be saved" }, { status: 400 }); }
}
