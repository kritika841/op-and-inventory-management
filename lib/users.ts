import { getEnv } from "./database";

type Row = Record<string, unknown>;

export interface UserDeleteGuard {
  canHardDelete: boolean;
  historyCount: number;
  reason: string | null;
  references: Array<{ label: string; count: number }>;
}

const HISTORY_SOURCES = [
  { key: "orderAssignments", label: "assigned orders", sql: "SELECT assigned_user_id AS user_id, COUNT(*) AS count FROM orders WHERE assigned_user_id IS NOT NULL GROUP BY assigned_user_id" },
  { key: "legacyAssignments", label: "legacy assigned orders", sql: "SELECT assigned_agent_id AS user_id, COUNT(*) AS count FROM orders WHERE assigned_agent_id IS NOT NULL GROUP BY assigned_agent_id" },
  { key: "statusChanges", label: "order status changes", sql: "SELECT changed_by AS user_id, COUNT(*) AS count FROM order_status_log WHERE changed_by IS NOT NULL GROUP BY changed_by" },
  { key: "confirmationAttempts", label: "confirmation attempts", sql: "SELECT user_id, COUNT(*) AS count FROM confirmation_attempts GROUP BY user_id" },
  { key: "auditEvents", label: "audit events", sql: "SELECT actor_id AS user_id, COUNT(*) AS count FROM audit_events WHERE actor_id IS NOT NULL GROUP BY actor_id" },
  { key: "componentLedger", label: "component ledger entries", sql: "SELECT created_by AS user_id, COUNT(*) AS count FROM component_ledger WHERE created_by IS NOT NULL GROUP BY created_by" },
  { key: "inventoryLedger", label: "inventory ledger entries", sql: "SELECT created_by AS user_id, COUNT(*) AS count FROM inventory_ledger WHERE created_by IS NOT NULL GROUP BY created_by" },
  { key: "manualSales", label: "manual sales", sql: "SELECT created_by AS user_id, COUNT(*) AS count FROM manual_sales WHERE created_by IS NOT NULL GROUP BY created_by" },
  { key: "recipeVersions", label: "recipe versions", sql: "SELECT created_by AS user_id, COUNT(*) AS count FROM recipe_versions WHERE created_by IS NOT NULL GROUP BY created_by" },
  { key: "packagingPlans", label: "packaging plans", sql: "SELECT created_by AS user_id, COUNT(*) AS count FROM packaging_plans WHERE created_by IS NOT NULL GROUP BY created_by" },
  { key: "labels", label: "label uploads", sql: "SELECT uploaded_by AS user_id, COUNT(*) AS count FROM labels GROUP BY uploaded_by" },
  { key: "rtoTasks", label: "completed RTO tasks", sql: "SELECT completed_by AS user_id, COUNT(*) AS count FROM rto_tasks WHERE completed_by IS NOT NULL GROUP BY completed_by" },
  { key: "courierSla", label: "courier SLA edits", sql: "SELECT updated_by AS user_id, COUNT(*) AS count FROM courier_sla WHERE updated_by IS NOT NULL GROUP BY updated_by" },
] as const;

function num(value: unknown) {
  return Number(value ?? 0);
}

export async function getUserDeleteGuards() {
  const db = getEnv().DB;
  const results = await Promise.all(HISTORY_SOURCES.map((source) => db.prepare(source.sql).all<Row>()));
  const guards = new Map<string, UserDeleteGuard>();

  for (const [index, source] of HISTORY_SOURCES.entries()) {
    for (const row of results[index].results) {
      const userId = row.user_id ? String(row.user_id) : null;
      if (!userId) continue;
      const count = num(row.count);
      if (!count) continue;
      const current = guards.get(userId) ?? { canHardDelete: true, historyCount: 0, reason: null, references: [] };
      current.canHardDelete = false;
      current.historyCount += count;
      current.references.push({ label: source.label, count });
      guards.set(userId, current);
    }
  }

  for (const [userId, guard] of guards.entries()) {
    const detail = guard.references.map((entry) => `${entry.count} ${entry.label}`).join(", ");
    guard.reason = `This user has ${guard.historyCount} historical reference${guard.historyCount === 1 ? "" : "s"} (${detail}) and cannot be permanently deleted without breaking the audit trail. Deactivate instead.`;
    guards.set(userId, guard);
  }

  return guards;
}

export function getUserDeleteGuard(guards: Map<string, UserDeleteGuard>, userId: string) {
  return guards.get(userId) ?? { canHardDelete: true, historyCount: 0, reason: null, references: [] };
}
