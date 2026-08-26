import { authorizeRequest } from "@/lib/auth";
import { ensureDatabase, getEnv } from "@/lib/database";

type Row = Record<string, unknown>;

function normalizeOrderNumber(value: string) {
  return value.trim().replace(/^#/, "").toUpperCase();
}

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if ("response" in auth) return auth.response;
  await ensureDatabase();

  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const search = (url.searchParams.get("query") || "").trim();
  const requestedIds = search.includes(",")
    ? search.split(",").map(normalizeOrderNumber).filter(Boolean)
    : [];
  const where: string[] = [];
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `?${values.length}`;
  };

  if (auth.user.role === "CONFIRMATION_AGENT") {
    where.push(`ca.assigned_agent_id=${bind(auth.user.id)}`);
  } else if (auth.user.role === "WAREHOUSE") {
    where.push("o.current_status IN ('MANIFESTED','LABEL_PRINTED','PICKUP_SCHEDULED','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','AUTO_CANCEL_RISK','SHIPMENT_AUTO_CANCELLED','RTO_INITIATED','RTO_IN_TRANSIT','RTO_RECEIVED','RTO_INSPECTION_PENDING','RTO_RESTOCKED','RTO_DAMAGED')");
  }

  if (requestedIds.length) {
    where.push(`o.normalized_order_number IN (${requestedIds.map((id) => bind(id)).join(",")})`);
  } else if (search) {
    const pattern = `%${search.toLowerCase()}%`;
    where.push(`(lower(o.order_number) LIKE ${bind(pattern)} OR lower(o.customer_name) LIKE ${bind(pattern)} OR lower(COALESCE(o.customer_phone,'')) LIKE ${bind(pattern)} OR lower(COALESCE(o.awb,'')) LIKE ${bind(pattern)})`);
  }

  const predicate = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const from = "FROM orders o LEFT JOIN users u ON u.id=o.assigned_user_id LEFT JOIN campaign_assignments ca ON ca.order_id=o.id";
  const db = getEnv().DB;
  const count = await db.prepare(`SELECT COUNT(DISTINCT o.id) AS count ${from} ${predicate}`).bind(...values).first<{ count: number }>();
  const pageValues = [...values, limit, offset];
  const rows = await db.prepare(`SELECT DISTINCT o.*,u.name AS assigned_user_name ${from} ${predicate} ORDER BY o.created_at DESC LIMIT ?${pageValues.length - 1} OFFSET ?${pageValues.length}`)
    .bind(...pageValues).all<Row>();
  const orderIds = rows.results.map((row) => String(row.id));
  const children = orderIds.length
    ? await db.prepare(`SELECT * FROM order_lines WHERE order_id IN (${orderIds.map((_, index) => `?${index + 1}`).join(",")}) ORDER BY order_id,id`).bind(...orderIds).all<Row>()
    : { results: [] as Row[] };
  const linesByOrder = new Map<string, Row[]>();
  for (const line of children.results) linesByOrder.set(String(line.order_id), [...(linesByOrder.get(String(line.order_id)) ?? []), line]);

  return Response.json({
    orders: rows.results.map((row) => ({
      id: String(row.id),
      orderNumber: String(row.order_number),
      customerName: String(row.customer_name),
      customerPhone: row.customer_phone ? String(row.customer_phone) : null,
      paymentMethod: String(row.payment_method),
      amount: Number(row.amount || 0),
      status: String(row.current_status || row.status),
      awb: row.awb ? String(row.awb) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lines: (linesByOrder.get(String(row.id)) ?? []).map((line) => ({ id: String(line.id), sku: String(line.sku), name: String(line.name), quantity: Number(line.quantity) })),
    })),
    pagination: { total: Number(count?.count || 0), limit, offset, hasMore: offset + rows.results.length < Number(count?.count || 0) },
  }, { headers: { "cache-control": "no-store" } });
}
