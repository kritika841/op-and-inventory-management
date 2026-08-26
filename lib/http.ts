const MAX_JSON_BYTES = 256 * 1024;

export async function readJsonBody<T>(request: Request): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_JSON_BYTES) return { ok: false, response: Response.json({ error: "Request body is too large" }, { status: 413 }) };
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_JSON_BYTES) return { ok: false, response: Response.json({ error: "Request body is too large" }, { status: 413 }) };
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false, response: Response.json({ error: "Request body must be valid JSON" }, { status: 400 }) };
  }
}
