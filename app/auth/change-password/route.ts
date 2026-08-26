import { rejectCrossOrigin, changePassword } from "@/lib/auth";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const body = await request.json() as { password?: string };
  const result = await changePassword(request, body.password ?? "");
  return Response.json(result, { status: result.ok ? 200 : ("status" in result ? result.status : 400) });
}
