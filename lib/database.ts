import { env } from "cloudflare:workers";
import { hashPassword, randomHex } from "./crypto";
import { getPostgresDatabase, type AppDatabase } from "./postgres";

export interface SatmiEnv {
  DB: AppDatabase;
  HYPERDRIVE?: { connectionString: string };
  SUPABASE_DATABASE_URL?: string;
  LABELS?: R2Bucket;
  ORDER_EVENTS?: DurableObjectNamespace;
  APP_MODE?: string;
  APP_BASE_URL?: string;
  APP_ALLOWED_ORIGINS?: string;
  SESSION_SECRET?: string;
  PASSWORD_PEPPER?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  INITIAL_ADMIN_EMAIL?: string;
  INITIAL_ADMIN_TEMP_PASSWORD?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_ADMIN_ACCESS_TOKEN?: string;
  SHOPIFY_API_VERSION?: string;
  SHOPIFY_REDIRECT_URI?: string;
  SHIPROCKET_EMAIL?: string;
  SHIPROCKET_PASSWORD?: string;
  SHIPROCKET_CHANNEL_ID?: string;
  SHIPROCKET_WEBHOOK_SECRET?: string;
}

export function getEnv() {
  const runtime = env as unknown as Omit<SatmiEnv, "DB">;
  const connectionString = runtime.HYPERDRIVE?.connectionString?.trim() || runtime.SUPABASE_DATABASE_URL?.trim() || "";
  return { ...runtime, DB: getPostgresDatabase(connectionString) } as SatmiEnv;
}

export function requiredEnv(name: keyof SatmiEnv) {
  const value = getEnv()[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${String(name)} is required; insecure fallback values are disabled.`);
  return value.trim();
}

const REQUIRED_TABLES = [
  "users",
  "orders",
  "order_lines",
  "shipments",
  "tracking_events",
  "order_status_log",
  "courier_sla",
  "integration_sync_cursors",
] as const;

const DEFAULT_COMPONENT_TYPES = [
  ["ACCESSORY", "Accessory"],
  ["INSERT", "Insert / certificate"],
  ["INNER_PACKAGING", "Inner packaging"],
  ["OUTER_PACKAGING", "Outer packaging"],
  ["COURIER_BOX", "Courier box"],
  ["OTHER", "Other"],
] as const;

const DEFAULT_COURIER_SLAS = [
  ["sla_delhivery", "Delhivery", 7],
  ["sla_bluedart", "BlueDart", 5],
  ["sla_xpressbees", "XpressBees", 7],
  ["sla_ekart", "Ekart", 7],
  ["sla_dtdc", "DTDC", 5],
  ["sla_shadowfax", "Shadowfax", 3],
  ["sla_ecom", "Ecom Express", 7],
  ["sla_shiprocket_surface", "Pickrr/Shiprocket Surface", 5],
] as const;

let ready: Promise<void> | null = null;

export function ensureDatabase() {
  // A transient DNS, pooler, or network failure must not permanently poison the
  // running process. The previous implementation cached a rejected promise,
  // making every later login fail until the dev server was restarted.
  if (!ready) ready = initializeDatabase().catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}

// Authentication must not wait for the full workspace bootstrap. The latter
// validates every operational table and seeds reference data, which is useful
// before loading a workspace but can make a valid sign-in time out when the
// database pooler is temporarily slow. The first authenticated workspace load
// still runs the complete check through ensureDatabase().
export async function ensureAuthDatabase() {
  const runtime = getEnv();
  if ((runtime.APP_MODE || "live") === "sample") return ensureDatabase();
  requiredEnv("SESSION_SECRET");
  requiredEnv("PASSWORD_PEPPER");
  await runtime.DB.prepare("SELECT 1 FROM users LIMIT 1").all();
}

async function initializeDatabase() {
  const runtime = getEnv();
  const { DB } = runtime;
  if ((getEnv().APP_MODE || "live") !== "sample") {
    // Authentication must remain available even when the optional commerce
    // integrations have not been connected yet. Integration routes validate
    // their own credentials when they are used; they must not block sign-in.
    for (const name of ["SESSION_SECRET", "PASSWORD_PEPPER"] as const) requiredEnv(name);
  }
  await assertSchemaReady(DB);
  await seedReferenceData(DB);

  const count = await DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  if (!Number(count?.count)) {
    if ((getEnv().APP_MODE || "live") === "sample") await seedSampleDatabase();
    else await seedLiveDatabase();
  }
  // Default campaign setup is useful but non-critical. Authentication and the
  // core workspace must remain available if this optional bootstrap ever hits
  // malformed campaign data or a temporary write failure.
  try { await ensureDefaultHighRtoCampaign(DB); }
  catch (error) { console.error("[database] default High RTO campaign setup failed", error); }
}

async function assertSchemaReady(db: AppDatabase) {
  const placeholders = REQUIRED_TABLES.map((_, index) => `?${index + 1}`).join(",");
  const tables = await db.prepare(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_name IN (${placeholders})`,
  ).bind(...REQUIRED_TABLES).all<{ name: string }>();

  const existingTables = new Set(tables.results.map((row) => String(row.name)));
  const missingTables = REQUIRED_TABLES.filter((name) => !existingTables.has(name));
  if (missingTables.length) {
    throw new Error(
      `Supabase schema is missing tables (${missingTables.join(", ")}). Apply the checked-in Supabase migrations before starting the app.`,
    );
  }

  try {
    await db.prepare(
      `SELECT current_status,rto_risk,rto_score,assigned_agent_id,stuck_reason,stuck_since,stuck_notes,shipping_address,shipping_city,shipping_state,shipping_pincode,shipping_country,shopify_customer_id FROM orders LIMIT 0`,
    ).all();
    await db.prepare(
      "SELECT assigned_agent_id,criteria_json,position FROM campaigns LIMIT 0",
    ).all();
    await db.prepare(
      "SELECT position FROM campaign_assignments LIMIT 0",
    ).all();
    await db.prepare(
      "SELECT tag FROM order_tags LIMIT 0",
    ).all();
  } catch {
    throw new Error(
      "Supabase schema is out of date. Apply the latest checked-in Supabase migrations before starting the app.",
    );
  }
}

async function seedReferenceData(db: AppDatabase) {
  const now = new Date().toISOString();

  await db.batch(
    DEFAULT_COMPONENT_TYPES.map(([code, name]) =>
      db.prepare(
        "INSERT OR IGNORE INTO component_types(code,name,active,created_at) VALUES(?1,?2,1,?3)",
      ).bind(code, name, now),
    ),
  );

  await db.batch(
    DEFAULT_COURIER_SLAS.map(([id, name, days]) =>
      db.prepare(
        "INSERT OR IGNORE INTO courier_sla (id, courier_name, auto_cancel_days, updated_at) VALUES (?1, ?2, ?3, ?4)",
      ).bind(id, name, days, now),
    ),
  );
}

/**
 * Creates the one default, durable campaign for the exact high-RTO tags.
 * It is inserted only once, at the top of the board. Later drag-and-drop
 * ordering is never changed, so managers retain complete control of priority.
 */
export async function ensureDefaultHighRtoCampaign(db = getEnv().DB) {
  const agent = await db.prepare("SELECT id FROM users WHERE role='CONFIRMATION_AGENT' AND active=1 ORDER BY created_at ASC LIMIT 1").first<{ id: string }>();
  const creator = await db.prepare("SELECT id FROM users WHERE role IN ('ADMIN','MANAGER') AND active=1 ORDER BY CASE role WHEN 'ADMIN' THEN 0 ELSE 1 END,created_at ASC LIMIT 1").first<{ id: string }>();
  if (!agent || !creator) return;

  const now = new Date().toISOString();
  const highRtoCriteria = JSON.stringify({ duplicateOnly: false, duplicateMode: "NONE", tags: ["high", "rto_prediction_high"], orderNumbers: [], productNames: [], paymentMethod: "ANY", previousUnfulfilledOnly: false, includeRtoRisk: true, autoAssignFutureMatching: true });
  // Keep the fixed campaign identity and a user's drag position, but migrate
  // earlier installations from the old display-only "High RTO" tag to the
  // two exact Shopify routing tags.
  const current = await db.prepare("SELECT id,assigned_agent_id FROM campaigns WHERE id='cmp_default_high_rto' LIMIT 1").first<{ id: string; assigned_agent_id: string }>();
  if (current) {
    const assignedAgent = await db.prepare("SELECT id FROM users WHERE id=?1 AND role='CONFIRMATION_AGENT' AND active=1").bind(current.assigned_agent_id).first<{ id: string }>();
    await db.prepare("UPDATE campaigns SET criteria_json=?1,description=?2,assigned_agent_id=?3 WHERE id='cmp_default_high_rto'")
      .bind(highRtoCriteria, "Automatically assigns orders tagged high or rto_prediction_high for confirmation.", assignedAgent?.id ?? agent.id).run();
    return;
  }
  const active = await db.prepare("SELECT id,position FROM campaigns WHERE is_active=1 ORDER BY position ASC").all<{ id: string; position: number }>();
  // A fixed id plus RETURNING makes this safe when two cold requests race.
  // Only the request that actually inserts the campaign may shift the board.
  const inserted = await db.prepare("INSERT INTO campaigns (id,name,description,urgency,assigned_agent_id,criteria_json,position,created_by,created_at,is_active) VALUES ('cmp_default_high_rto',?1,?2,'MEDIUM',?3,?4,0,?5,?6,1) ON CONFLICT(id) DO NOTHING RETURNING id")
    .bind("High RTO review", "Automatically assigns orders tagged high or rto_prediction_high for confirmation.", agent.id, highRtoCriteria, creator.id, now)
    .first<{ id: string }>();
  if (!inserted) return;
  if (active.results.length) {
    await db.batch(active.results.map((campaign) => db.prepare("UPDATE campaigns SET position=?1 WHERE id=?2").bind(Number(campaign.position) + 1, campaign.id)));
  }
}

async function seedLiveDatabase() {
  const runtime = getEnv();
  const salt = randomHex(16);
  const password = requiredEnv("INITIAL_ADMIN_TEMP_PASSWORD");
  const passwordHash = await hashPassword(password, salt, requiredEnv("PASSWORD_PEPPER"));
  const now = new Date().toISOString();
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO users (id,email,name,role,password_hash,password_salt,must_change_password,active,failed_attempts,created_at) VALUES ('usr_admin',?1,'Administrator','ADMIN',?2,?3,1,1,0,?4)").bind(requiredEnv("INITIAL_ADMIN_EMAIL"), passwordHash, salt, now),
    runtime.DB.prepare("INSERT INTO integration_state (provider,status,detail,updated_at) VALUES ('shopify','action-required','Connect Shopify to import store orders',?1)").bind(now),
    runtime.DB.prepare("INSERT INTO integration_state (provider,status,detail,updated_at) VALUES ('shiprocket','pending','Run Sync now to import channel orders',?1)").bind(now),
  ]);
}

async function seedSampleDatabase() {
  const runtime = getEnv();
  const now = new Date();
  const iso = (hoursAgo = 0) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
  const eta = (days = 10) => new Date(now.getTime() + days * 86_400_000).toISOString();
  const salt = randomHex(16);
  const defaultPassword = requiredEnv("INITIAL_ADMIN_TEMP_PASSWORD");
  const passwordHash = await hashPassword(defaultPassword, salt, requiredEnv("PASSWORD_PEPPER"));

  const users = [
    ["usr_admin", runtime.INITIAL_ADMIN_EMAIL || "admin@satmi.local", "Kartavya Jain", "ADMIN"],
    ["usr_riya", "riya@satmi.local", "Riya Mehta", "CONFIRMATION_AGENT"],
    ["usr_aman", "aman@satmi.local", "Aman Verma", "OPERATIONS"],
    ["usr_neha", "neha@satmi.local", "Neha Singh", "WAREHOUSE"],
    ["usr_view", "viewer@satmi.local", "Finance Viewer", "VIEWER"],
  ];
  await runtime.DB.batch(users.map(([id, email, name, role]) => runtime.DB.prepare("INSERT INTO users (id,email,name,role,password_hash,password_salt,must_change_password,active,failed_attempts,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,1,0,?8)").bind(id, email, name, role, passwordHash, salt, id === "usr_admin" ? 1 : 0, iso(720))));

  const products = [
    ["prd_hoodie", "TH-OLV-M", "Trail Hoodie", "Olive / M", 42],
    ["prd_tee", "DT-SND-L", "Drift Tee", "Sand / L", 18],
    ["prd_bottle", "AB-BLK", "Arc Bottle", "Black / 750ml", 9],
    ["prd_cap", "SC-NVY", "Summit Cap", "Navy", 25],
  ];
  await runtime.DB.batch(products.flatMap(([id, sku, name, variant, qty]) => [
    runtime.DB.prepare("INSERT INTO products (id,sku,name,variant,active) VALUES (?1,?2,?3,?4,1)").bind(id, sku, name, variant),
    runtime.DB.prepare("INSERT INTO inventory_ledger (id,product_id,movement_type,quantity,reason,created_by,created_at) VALUES (?1,?2,'opening',?3,'Opening stock import','usr_admin',?4)").bind(`led_${id}`, id, qty, iso(168)),
  ]));

  const orders = [
    ["ord_1048", "#SAT-1048", "Arjun Rao", "98765 43021", "COD", 289900, "ready", 1, "confirmed", "usr_riya", "78451002", "SHP-41002", "14322190877", "Delhivery", "ready_to_ship", "labels/ord_1048.pdf", 0, null, 2],
    ["ord_1047", "#SAT-1047", "Meera Shah", "99882 11042", "COD", 129900, "open", 1, "assigned", "usr_riya", null, null, null, null, null, null, 0, null, 4],
    ["ord_1046", "#SAT-1046", "Kabir Bose", "98201 77324", "Prepaid", 189900, "open", 0, "not-required", null, "78450884", "SHP-40981", "14322190512", "Xpressbees", "ready_to_ship", null, 0, null, 7],
    ["ord_1045", "#SAT-1045", "Naina Kapoor", "99104 66117", "COD", 89900, "open", 0, "not-required", null, null, null, null, null, null, null, 0, null, 9],
    ["ord_1044", "#SAT-1044", "Vihaan Das", "98111 20309", "Prepaid", 269700, "open", 0, "not-required", null, null, null, null, null, null, null, 0, null, 12],
    ["ord_1043", "#SAT-1043", "Sara Iyer", "98910 40491", "Prepaid", 199900, "delivered", 0, "not-required", null, "78449031", "SHP-40830", "14322188210", "Delhivery", "delivered", "labels/ord_1043.pdf", 1, null, 28],
    ["ord_1042", "#SAT-1042", "Dev Malhotra", "98181 34022", "COD", 129900, "rto_in_transit", 1, "confirmed", "usr_riya", "78448721", "SHP-40790", "14322187611", "Ecom Express", "rto_in_transit", "labels/ord_1042.pdf", 1, eta(6), 38],
    ["ord_1041", "#SAT-1041", "Anaya Sen", "99200 61834", "COD", 89900, "rto_delivered", 1, "confirmed", "usr_riya", "78448001", "SHP-40710", "14322186118", "Delhivery", "rto_delivered", "labels/ord_1041.pdf", 1, eta(0), 50],
  ];
  await runtime.DB.batch(orders.map((order) => runtime.DB.prepare("INSERT INTO orders (id,order_number,customer_name,customer_phone,payment_method,amount,status,confirmation_selected,confirmation_status,assigned_user_id,shiprocket_order_id,shipment_id,awb,courier,tracking_status,label_key,warehouse_acknowledged,rto_eta,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)").bind(...order.slice(0, 18), iso(Number(order[18])), iso(0))));

  const lines = [
    ["lin_1048", "ord_1048", "prd_hoodie", "TH-OLV-M", "Trail Hoodie · Olive / M", 1, 1],
    ["lin_1047", "ord_1047", "prd_tee", "DT-SND-L", "Drift Tee · Sand / L", 1, 1],
    ["lin_1046", "ord_1046", "prd_hoodie", "TH-OLV-M", "Trail Hoodie · Olive / M", 1, 1],
    ["lin_1045", "ord_1045", "prd_bottle", "AB-BLK", "Arc Bottle · Black", 1, 1],
    ["lin_1044", "ord_1044", "prd_bottle", "AB-BLK", "Arc Bottle · Black", 12, 6],
    ["lin_1043", "ord_1043", "prd_cap", "SC-NVY", "Summit Cap · Navy", 1, 0],
    ["lin_1042", "ord_1042", "prd_tee", "DT-SND-L", "Drift Tee · Sand / L", 1, 0],
    ["lin_1041", "ord_1041", "prd_bottle", "AB-BLK", "Arc Bottle · Black", 1, 0],
  ];
  await runtime.DB.batch(lines.map((line) => runtime.DB.prepare("INSERT INTO order_lines (id,order_id,product_id,sku,name,quantity,allocated_quantity) VALUES (?1,?2,?3,?4,?5,?6,?7)").bind(...line)));

  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO labels (id,order_id,object_key,file_name,size,uploaded_by,created_at) VALUES ('lbl_1048','ord_1048','labels/ord_1048.pdf','SAT-1048-label.pdf',82412,'usr_aman',?1)").bind(iso(1)),
    runtime.DB.prepare("INSERT INTO rto_tasks (id,order_id,status,created_at) VALUES ('rto_1041','ord_1041','qc-pending',?1)").bind(iso(1)),
    runtime.DB.prepare("INSERT INTO integration_state (provider,status,detail,last_synced_at,updated_at) VALUES ('shopify','sample','Sample mode · live writes disabled',?1,?1)").bind(iso(0.2)),
    runtime.DB.prepare("INSERT INTO integration_state (provider,status,detail,last_synced_at,updated_at) VALUES ('shiprocket','sample','Channel 9574697 · sample mode',?1,?1)").bind(iso(0.4)),
    runtime.DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,detail,created_at) VALUES ('aud_seed','usr_admin','workspace.seeded','system','sample','Sample workspace initialized',?1)").bind(iso(2)),
  ]);
}

export async function audit(actorId: string | null, action: string, entityType: string, entityId: string, detail: string) {
  await ensureDatabase();
  await getEnv().DB.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,detail,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)")
    .bind(`aud_${randomHex(10)}`, actorId, action, entityType, entityId, detail, new Date().toISOString()).run();
}
