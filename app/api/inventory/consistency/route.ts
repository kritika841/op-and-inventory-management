import { authorizeRequest, rejectCrossOrigin } from "@/lib/auth";
import { ensureDatabase, getEnv } from "@/lib/database";
import { reallocateComponents } from "@/lib/components";

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

export async function GET(request: Request) {
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER", "OPERATIONS"]);
  if ("response" in auth) return auth.response;

  await ensureDatabase();
  const db = getEnv().DB;

  // 1. Fetch all components
  const components = await db.prepare("SELECT id, sku, name, active FROM inventory_components ORDER BY name").all<Row>();

  // 2. Fetch raw ledger balances
  const ledgerRows = await db.prepare("SELECT component_id, COALESCE(SUM(quantity), 0) AS on_hand FROM component_ledger GROUP BY component_id").all<Row>();
  const ledgerBalanceMap = new Map<string, number>();
  for (const row of ledgerRows.results) {
    ledgerBalanceMap.set(String(row.component_id), n(row.on_hand));
  }

  // 3. Fetch active allocations from order_requirements
  const allocationRows = await db.prepare(`
    SELECT r.component_id,
           COALESCE(SUM(r.allocated_quantity), 0) AS total_allocated,
           COALESCE(SUM(r.required_quantity), 0) AS total_required,
           COUNT(DISTINCT r.order_id) AS active_orders_count
    FROM order_requirements r
    JOIN orders o ON o.id = r.order_id
    WHERE o.status NOT IN ('cancelled', 'delivered', 'rto_delivered')
    GROUP BY r.component_id
  `).all<Row>();

  const allocationMap = new Map<string, { totalAllocated: number; totalRequired: number; activeOrdersCount: number }>();
  for (const row of allocationRows.results) {
    allocationMap.set(String(row.component_id), {
      totalAllocated: n(row.total_allocated),
      totalRequired: n(row.total_required),
      activeOrdersCount: n(row.active_orders_count),
    });
  }

  // 4. Over-allocated individual requirement rows
  const overAllocatedRequirements = await db.prepare(`
    SELECT r.id, r.order_id, r.component_id, r.required_quantity, r.allocated_quantity, o.order_number
    FROM order_requirements r
    JOIN orders o ON o.id = r.order_id
    WHERE r.allocated_quantity > r.required_quantity
  `).all<Row>();

  // 5. Build component-by-component audit
  const componentAudits = components.results.map((c) => {
    const compId = String(c.id);
    const onHand = ledgerBalanceMap.get(compId) ?? 0;
    const alloc = allocationMap.get(compId) ?? { totalAllocated: 0, totalRequired: 0, activeOrdersCount: 0 };
    const available = Math.max(0, onHand - alloc.totalAllocated);
    const hasDiscrepancy = alloc.totalAllocated > onHand || onHand < 0;

    return {
      componentId: compId,
      sku: String(c.sku),
      name: String(c.name),
      active: Boolean(c.active),
      onHand,
      allocated: alloc.totalAllocated,
      required: alloc.totalRequired,
      available,
      activeOrdersCount: alloc.activeOrdersCount,
      hasDiscrepancy,
      issue: onHand < 0
        ? "Negative stock on hand in ledger"
        : alloc.totalAllocated > onHand
        ? "Total allocated exceeds on-hand stock"
        : null,
    };
  });

  const discrepancies = componentAudits.filter((item) => item.hasDiscrepancy);
  const isHealthy = discrepancies.length === 0 && overAllocatedRequirements.results.length === 0;

  return Response.json({
    ok: true,
    isHealthy,
    totalComponentsChecked: components.results.length,
    discrepancyCount: discrepancies.length,
    overAllocatedRowsCount: overAllocatedRequirements.results.length,
    discrepancies,
    overAllocatedRows: overAllocatedRequirements.results,
    summary: isHealthy
      ? "Zero discrepancies found across inventory ledger and active order requirements."
      : `Found ${discrepancies.length} component allocation discrepancies and ${overAllocatedRequirements.results.length} over-allocated rows.`,
    checkedAt: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]);
  if ("response" in auth) return auth.response;

  // Re-run allocation engine to bring everything into 100% mathematical consistency
  await reallocateComponents();

  return Response.json({
    ok: true,
    message: "Component allocations successfully reconciled against raw ledger data.",
    reconciledAt: new Date().toISOString(),
  });
}
