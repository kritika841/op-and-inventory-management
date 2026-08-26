import { rejectCrossOrigin, authorizeRequest } from "@/lib/auth";
import { audit, ensureDatabase, getEnv } from "@/lib/database";
import { randomHex } from "@/lib/crypto";
import { isSampleMode, syncOrderFromShiprocket } from "@/lib/integrations";
import { mutateOrder } from "@/lib/state";

export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER", "OPERATIONS"]);
  if ("response" in auth) return auth.response;
  const user = auth.user;
  const { orderId } = await context.params;
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.type !== "application/pdf") return Response.json({ error: "Upload one PDF label" }, { status: 400 });
  if (file.size > 10 * 1024 * 1024) return Response.json({ error: "Label must be 10 MB or smaller" }, { status: 400 });
  const bytes = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (new TextDecoder().decode(bytes) !== "%PDF-") return Response.json({ error: "The uploaded file is not a valid PDF" }, { status: 400 });
  await ensureDatabase();
  const runtime = getEnv();
  const existing = await runtime.DB.prepare("SELECT id FROM labels WHERE order_id=?1 LIMIT 1").bind(orderId).first();
  if (existing) return Response.json({ error: "This order already has a label" }, { status: 409 });
  const key = `labels/${orderId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
  if (runtime.LABELS) await runtime.LABELS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: "application/pdf", contentDisposition: `attachment; filename="${file.name.replace(/"/g, "")}"` } });
  const now = new Date().toISOString();
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO labels (id,order_id,object_key,file_name,size,uploaded_by,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)").bind(`lbl_${randomHex(9)}`, orderId, key, file.name, file.size, user.id, now),
    runtime.DB.prepare("UPDATE orders SET label_key=?1,updated_at=?2 WHERE id=?3").bind(key, now, orderId),
  ]);
  try {
    if (isSampleMode()) await mutateOrder(user, orderId, "sample-shiprocket", {});
    else await syncOrderFromShiprocket(orderId);
  } catch (error) {
    await audit(user.id, "label.shiprocket-sync-failed", "order", orderId, error instanceof Error ? error.message : "Lookup failed");
  }
  await audit(user.id, "label.uploaded", "order", orderId, file.name);
  return Response.json({ ok: true });
}

export async function GET(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER", "OPERATIONS", "WAREHOUSE"]);
  if ("response" in auth) return auth.response;
  const { orderId } = await context.params;
  await ensureDatabase();
  const runtime = getEnv();
  const row = await runtime.DB.prepare("SELECT object_key,file_name FROM labels WHERE order_id=?1 ORDER BY created_at DESC LIMIT 1").bind(orderId).first<{ object_key: string; file_name: string }>();
  if (!row) return new Response("Label not found", { status: 404 });
  const object = runtime.LABELS ? await runtime.LABELS.get(row.object_key) : null;
  if (!object) return new Response("Sample label metadata exists; upload a local PDF to download it.", { status: 404 });
  return new Response(object.body, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${row.file_name.replace(/"/g, "")}"` } });
}
