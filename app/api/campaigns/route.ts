import { authorizeRequest, rejectCrossOrigin } from "@/lib/auth";
import { assignCampaign, reorderCampaigns } from "@/lib/state";
import type { CampaignCriteria, CampaignUrgency } from "@/lib/types";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]); if ("response" in auth) return auth.response;
  const body = await request.json() as { action?: string; campaignId?: string; name?: string; description?: string; urgency?: CampaignUrgency; assignedAgentId?: string; orderIds?: string[]; criteria?: CampaignCriteria | null; campaignIds?: string[] };
  try {
    if (body.action === "reorder") return Response.json({ ok: true, ...(await reorderCampaigns(auth.user, { campaignIds: body.campaignIds })) });
    return Response.json({ ok: true, ...(await assignCampaign(auth.user, body)) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Campaign assignment failed" }, { status: 400 });
  }
}
