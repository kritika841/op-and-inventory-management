import { authorizeRequest, rejectCrossOrigin } from "@/lib/auth";
import { createComponentType } from "@/lib/components";
import { readJsonBody } from "@/lib/http";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]); if ("response" in auth) return auth.response;
  const parsed = await readJsonBody<{ name?: string }>(request); if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  try { return Response.json({ ok: true, code: await createComponentType(auth.user, body.name ?? "") }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Component type could not be created" }, { status: 400 }); }
}
