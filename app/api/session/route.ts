import { authorizeRequest } from "@/lib/auth";

// Keep workspace selection fast. The full order and inventory snapshot is
// loaded by the selected workspace after this small session check succeeds.
export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if ("response" in auth) return auth.response;
  return Response.json({ currentUser: auth.user });
}
