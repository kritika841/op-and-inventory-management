"use client";
/* eslint-disable @typescript-eslint/no-unused-vars -- legacy operations views are intentionally hidden while the inventory-only workspace is active */

import { ChangeEvent, Dispatch, FormEvent, Fragment, SetStateAction, useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Bell, Boxes, Clipboard, Download, Funnel, GripVertical, LayoutDashboard, MoreHorizontal, PackageSearch, PanelLeftClose, PanelLeftOpen, PhoneCall, RefreshCw, RotateCcw, Search, ShoppingBag, Truck, Users, UsersRound, X, type LucideIcon } from "lucide-react";
import type { CampaignCriteria, CampaignDuplicateMode, ComponentType, ConfirmationRejectionReason, DashboardSnapshot, OrderView } from "@/lib/types";
import { COURIER_ACTIVE_CURRENT_STATUSES, PRE_PICKUP_CURRENT_STATUSES, fulfillmentShipmentBucket } from "@/lib/shipping";
import { useOrderEvents } from "./useOrderEvents";

type ViewKey = "overview" | "orders" | "confirmation" | "fulfillment" | "inventory" | "setup" | "rto" | "team";
type InventorySection = "summary" | "components" | "stock" | "recipes" | "packaging";
type FulfillmentQueueKey = "new-orders" | "labels-generated" | "shipped" | "confirmed-orders" | "all";
type FulfillmentSortKey = "order-asc" | "activity-desc";
type FulfillmentQueuePage = { nextOffset: number; hasMore: boolean };

const navItems: Array<{ key: ViewKey; Icon: LucideIcon; label: string }> = [
  { key: "overview", Icon: LayoutDashboard, label: "Overview" }, { key: "orders", Icon: ShoppingBag, label: "Orders" },
  { key: "confirmation", Icon: PhoneCall, label: "Confirmation" }, { key: "fulfillment", Icon: Truck, label: "Fulfillment" },
  { key: "inventory", Icon: Boxes, label: "Components" }, { key: "setup", Icon: PackageSearch, label: "Product setup" }, { key: "rto", Icon: RotateCcw, label: "RTO & QC" }, { key: "team", Icon: UsersRound, label: "People and roles" },
];
const roleViews: Record<DashboardSnapshot["currentUser"]["role"], ViewKey[]> = {
  ADMIN: ["overview", "orders", "confirmation", "fulfillment", "inventory", "setup", "rto", "team"],
  MANAGER: ["overview", "orders", "confirmation", "fulfillment", "inventory", "setup", "rto", "team"],
  CONFIRMATION_AGENT: ["confirmation"], OPERATIONS: ["orders", "fulfillment", "inventory", "rto"],
  WAREHOUSE: ["orders", "fulfillment", "inventory", "rto"], VIEWER: ["overview", "orders", "inventory"],
};

const blockerLabel: Record<string, string> = { "invalid-SKU": "SKU mapping missing", "recipe-missing": "Recipe missing", "packaging-plan-required": "Choose packaging", "component-shortage": "Component shortage", "confirmation-pending": "Needs confirmation", "Shiprocket-missing": "Shiprocket sync pending", "AWB-missing": "AWB missing", "label-missing": "Label missing", "integration-error": "Sync issue" };
const currency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const campaignCurrency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const liveShipmentStatuses = new Set(["MANIFESTED", "LABEL_PRINTED", "PICKUP_SCHEDULED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "AUTO_CANCEL_RISK", "SHIPMENT_AUTO_CANCELLED", "RTO_INITIATED", "RTO_IN_TRANSIT", "RTO_RECEIVED", "RTO_INSPECTION_PENDING", "RTO_RESTOCKED", "RTO_DAMAGED"]);
const cancelledLikeStatuses = new Set(["cancelled", "cancel-requested"]);
const friendlyCurrentStatus: Record<string, string> = {
  INGESTED: "Order received",
  PENDING_CONFIRMATION: "Waiting for customer confirmation",
  MANIFESTED: "Shipment created",
  LABEL_PRINTED: "Label ready",
  PICKUP_SCHEDULED: "Pickup scheduled",
  PICKED_UP: "Picked up",
  IN_TRANSIT: "On the way",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  AUTO_CANCEL_RISK: "Pickup delay risk",
  SHIPMENT_AUTO_CANCELLED: "Shipment cancelled",
  RTO_INITIATED: "Return started",
  RTO_IN_TRANSIT: "Return in transit",
  RTO_RECEIVED: "Return received",
  RTO_INSPECTION_PENDING: "Return QC pending",
  RTO_RESTOCKED: "Returned stock added back",
  RTO_DAMAGED: "Returned stock damaged",
};
const friendlyConfirmationStatus: Record<string, string> = {
  assigned: "Assigned for call",
  selected: "Selected for calling",
  confirmed: "Customer confirmed",
  callback: "Callback scheduled",
  unreachable: "Customer not reachable",
  "cancel-requested": "Cancellation waiting for approval",
  cancelled: "Cancelled",
  "cancel-rejected": "Cancellation rejected",
  "not-required": "No confirmation needed",
};

function validDate(iso: string | null | undefined) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
function age(iso: string) { const date = validDate(iso); if (!date) return "—"; const hours = Math.max(1, Math.round((Date.now() - date.getTime()) / 3_600_000)); return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`; }
function shortDate(iso: string | null) { const date = validDate(iso); return date ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(date) : "—"; }
function campaignDate(iso: string | null) { const date = validDate(iso); return date ? new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", year: "numeric" }).format(date) : "—"; }
function daysSince(iso: string | null) {
  const date = validDate(iso); if (!date) return "—";
  const diff = Date.now() - date.getTime();
  if (diff <= 0) return "0d";
  return `${Math.floor(diff / 86_400_000)}d`;
}
function daysUntil(iso: string | null) {
  const date = validDate(iso); if (!date) return "—";
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return "0d";
  return `${Math.ceil(diff / 86_400_000)}d`;
}
function prettyStatus(value: string | null | undefined) { return String(value || "unknown").replaceAll("_", " ").replaceAll("-", " "); }
function confirmationLabel(order: OrderView) { return friendlyConfirmationStatus[order.confirmationStatus] || prettyStatus(order.confirmationStatus); }
function currentStatusLabel(order: OrderView) { return friendlyCurrentStatus[order.currentStatus] || prettyStatus(order.currentStatus); }
function awaitingPickup(order: OrderView) {
  return PRE_PICKUP_CURRENT_STATUSES.has(order.currentStatus) && !order.pickedUpAt;
}
function rtoLabel(order: OrderView) {
  if (order.rtoScore !== null) return `${order.rtoScore}%`;
  if (order.rtoRisk && order.rtoRisk !== "UNTAGGED") return prettyStatus(order.rtoRisk);
  return "Untagged";
}
function orderStageLabel(order: OrderView) {
  if (order.confirmationStatus === "cancel-requested") return "Cancellation under review";
  if (isCancelledOrder(order)) return "Cancelled";
  if (order.confirmationStatus === "confirmed" && !isLiveShipment(order)) return "Confirmed";
  if (isLiveShipment(order)) return currentStatusLabel(order);
  if (order.blocker === "confirmation-pending") return "Waiting for confirmation";
  if (order.blocker === "Shiprocket-missing" || order.blocker === "AWB-missing" || order.blocker === "label-missing") return "Shipping setup pending";
  if (order.blocker === "invalid-SKU") return "SKU mapping missing";
  if (order.blocker === "recipe-missing") return "Recipe missing";
  if (order.blocker === "packaging-plan-required") return "Packaging decision needed";
  if (order.blocker === "component-shortage") return "Component shortage";
  return "Preparing order";
}
function orderStageDetail(order: OrderView) {
  if (order.confirmationStatus === "confirmed" && !isLiveShipment(order)) return "Customer has confirmed the order";
  if (isLiveShipment(order)) return order.awb ? `AWB ${order.awb}` : "Shipment progress from Shiprocket";
  if (order.confirmationStatus === "cancel-requested") return order.cancellationReason || "Waiting for manager/admin approval";
  if (order.blocker) return blockerLabel[order.blocker];
  return queueStatusSummary(order);
}
function isCancelledOrder(order: OrderView) { return order.status === "cancelled" || cancelledLikeStatuses.has(order.confirmationStatus) || order.currentStatus === "SHIPMENT_AUTO_CANCELLED"; }
function isLiveShipment(order: OrderView) { return liveShipmentStatuses.has(order.currentStatus) || Boolean(order.awb); }
function confirmationCleared(order: OrderView) { return !order.confirmationSelected || ["confirmed", "not-required"].includes(order.confirmationStatus); }
function currentStatusTone(order: OrderView) {
  if (isCancelledOrder(order)) return "danger";
  if (["DELIVERED", "RTO_RESTOCKED"].includes(order.currentStatus)) return "success";
  if (["AUTO_CANCEL_RISK", "RTO_INITIATED", "RTO_IN_TRANSIT", "RTO_RECEIVED", "RTO_INSPECTION_PENDING", "RTO_DAMAGED"].includes(order.currentStatus)) return "purple";
  if (["MANIFESTED", "LABEL_PRINTED", "PICKUP_SCHEDULED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY"].includes(order.currentStatus)) return "warning";
  if (order.blocker) return order.blocker === "component-shortage" || order.blocker === "invalid-SKU" ? "danger" : "warning";
  return order.processed ? "success" : "neutral";
}
function packagingBlockerMessage(order: OrderView, boxesConfigured: boolean, boxRulesConfigured: boolean) {
  if (order.requirementStatus !== "packaging-required") return order.shortageSummary || "Packaging is ready";
  if (!boxesConfigured) return "No courier box components exist yet. Create COURIER_BOX components first.";
  if (!boxRulesConfigured) return "Courier boxes exist, but no box-capacity rules are configured in Product setup.";
  return "Packaging choice is required before manifesting this order.";
}
function queueStatusSummary(order: OrderView) {
  if (order.stuckReason) return order.stuckReason;
  if (order.cancellationReason) return order.cancellationReason;
  if (order.blocker) return blockerLabel[order.blocker];
  if (order.labelKey) return "Label stored";
  if (order.awb) return `AWB ${order.awb}`;
  return currentStatusLabel(order);
}
function orderMatchesSearch(order: OrderView, rawQuery: string) {
  const query = rawQuery.trim();
  if (!query) return true;
  const orderNumber = order.orderNumber.replace(/^#/, "").toUpperCase();
  const commaSeparatedIds = query.split(",").map((value) => value.trim().replace(/^#/, "").toUpperCase()).filter(Boolean);
  if (commaSeparatedIds.length > 1 && commaSeparatedIds.every((value) => /^[A-Z0-9-]+$/.test(value))) {
    return commaSeparatedIds.includes(orderNumber);
  }
  const haystack = `${order.orderNumber} ${order.customerName} ${order.customerPhone ?? ""} ${order.awb ?? ""} ${order.lines.map((line) => `${line.sku} ${line.name}`).join(" ")} ${order.rtoRisk ?? ""}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}
function fulfillmentActivityMs(order: OrderView, queue: FulfillmentQueueKey) {
  const timestamps = queue === "new-orders"
    ? [order.createdAt]
    : queue === "shipped"
      ? [order.latestShipmentEventAt, order.pickedUpAt, order.createdAt]
      : [order.updatedAt, order.pickedUpAt, order.manifestedAt, order.createdAt];
  return Math.max(...timestamps.map((value) => validDate(value)?.getTime() ?? 0));
}
function detectInitialTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  const rootTheme = document.documentElement.dataset.theme;
  if (rootTheme === "light" || rootTheme === "dark") return rootTheme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function OperationsApp() {
  const [data, setData] = useState<DashboardSnapshot | null>(null);
  const [view, setView] = useState<ViewKey>("overview");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [notifications, setNotifications] = useState<Array<{ id: string; message: string; tone: "success" | "error"; createdAt: string }>>([]);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notificationUnread, setNotificationUnread] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(detectInitialTheme);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [fulfillmentLoadError, setFulfillmentLoadError] = useState("");
  const fulfillmentInFlightRef = useRef(new Set<FulfillmentQueueKey>());
  const loadInFlightRef = useRef<Promise<void> | null>(null);

  const load = useCallback(async (preserveLoadedOrders = false) => {
    if (loadInFlightRef.current) return loadInFlightRef.current;
    setLoadError("");
    const request = (async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20_000);
      let response: Response;
      try {
        response = await fetch("/api/state?limit=75", { cache: "no-store", credentials: "same-origin", signal: controller.signal });
      } finally {
        window.clearTimeout(timeout);
      }
      if (response.status === 401) { window.location.href = "/login"; return; }
      if (response.status === 428) { window.location.href = "/change-password"; return; }
      if (!response.ok) throw new Error("Could not load workspace");
      const snapshot = await response.json() as DashboardSnapshot;
      setData((current) => {
        if (!preserveLoadedOrders || !current) return snapshot;
        const incomingIds = new Set(snapshot.orders.map((order) => order.id));
        const orders = [...snapshot.orders, ...current.orders.filter((order) => !incomingIds.has(order.id))];
        return {
          ...snapshot,
          orders,
          orderPagination: {
            ...snapshot.orderPagination,
            nextOffset: Math.max(snapshot.orderPagination.nextOffset, current.orderPagination.nextOffset),
            hasMore: current.orderPagination.hasMore || snapshot.orderPagination.hasMore,
          },
        };
      });
    })();
    loadInFlightRef.current = request;
    try {
      await request;
    } finally {
      loadInFlightRef.current = null;
    }
  }, []);

  useEffect(() => { load().catch(() => setLoadError("The operations workspace could not be loaded.")); }, [load]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useOrderEvents(() => load(view === "fulfillment").catch(() => undefined));

  const loadMoreFulfillmentOrders = useCallback(async (queue: FulfillmentQueueKey, offset: number, sort: FulfillmentSortKey): Promise<FulfillmentQueuePage | null> => {
    if (fulfillmentInFlightRef.current.has(queue)) return null;
    fulfillmentInFlightRef.current.add(queue);
    setFulfillmentLoadError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const pageSize = offset === 0 ? 25 : 75;
      const response = await fetch(`/api/state?scope=orders&queue=${encodeURIComponent(queue)}&sort=${encodeURIComponent(sort)}&limit=${pageSize}&offset=${offset}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
      if (response.status === 401) { window.location.href = "/login"; return null; }
      if (!response.ok) throw new Error("Could not load the next fulfillment page");
      const snapshot = await response.json() as DashboardSnapshot;
      setData((current) => {
        if (!current) return snapshot;
        const incoming = new Map(snapshot.orders.map((order) => [order.id, order]));
        const merged = current.orders.map((order) => incoming.get(order.id) ?? order);
        const known = new Set(current.orders.map((order) => order.id));
        return { ...current, orders: [...merged, ...snapshot.orders.filter((order) => !known.has(order.id))], fulfillmentCounts: snapshot.fulfillmentCounts };
      });
      return { nextOffset: snapshot.orderPagination.nextOffset, hasMore: snapshot.orderPagination.hasMore };
    } catch {
      setFulfillmentLoadError("The next set of orders could not be loaded. Please retry.");
      return null;
    } finally {
      window.clearTimeout(timeout);
      fulfillmentInFlightRef.current.delete(queue);
    }
  }, []);

  async function request(path: string, options: RequestInit, success: string, timeoutMs = 30_000) {
    setBusy(path);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, { ...options, signal: controller.signal });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        addNotification(result.error || "That action could not be completed", "error");
        return;
      }
      addNotification(success, "success");
      await load();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        addNotification("The action is taking longer than expected. Please retry once the dashboard settles.", "error");
        return;
      }
      addNotification("The local dashboard connection dropped. Refresh the page after the server reconnects.", "error");
    } finally {
      window.clearTimeout(timeout);
      setBusy("");
    }
  }

  function addNotification(message: string, tone: "success" | "error") {
    const notification = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, message, tone, createdAt: new Date().toISOString() };
    setNotifications((current) => [notification, ...current].slice(0, 30));
    setNotificationUnread((current) => current + 1);
  }

  async function orderAction(orderId: string, action: string, payload: Record<string, unknown> = {}, success = "Order updated") {
    await request(`/api/orders/${orderId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, payload }) }, success);
  }
  async function campaignAction(payload: Record<string, unknown>, success = "Campaign updated") {
    await request("/api/campaigns", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, success);
  }
  async function confirmationAdminAction(action: string, payload: Record<string, unknown>, success = "Confirmation controls updated") {
    await request("/api/confirmation/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, payload }) }, success);
  }
  async function integrationSyncAction(success = "Integration sync started in the background") {
    await request("/api/admin/sync", { method: "POST" }, success);
  }

  async function logout() { await fetch("/auth/logout", { method: "POST" }); window.location.href = "/login"; }

  if (!data && loadError) return <main className="loading-screen error-screen"><div className="brand-mark">S</div><h1>Workspace did not load</h1><p>{loadError}</p><div><button className="secondary-button" onClick={() => load().catch(() => setLoadError("The operations workspace could not be loaded."))}>Try again</button><button className="primary-button" onClick={() => { window.location.href = "/login"; }}>Go to sign in</button></div></main>;
  if (!data) return <main className="loading-screen"><div className="brand-mark">S</div><div className="loading-line"/><p>Preparing your operations workspace…</p><button className="loading-login" onClick={() => { window.location.href = "/login"; }}>Taking too long? Sign in again</button></main>;

  const role = data.currentUser.role;
  const canSwitchWorkspace = role === "ADMIN" || role === "MANAGER";
  const allowedViews = roleViews[role] ?? ["overview"];
  const confirmationOnlyShell = role === "CONFIRMATION_AGENT";
  // If the current view is not allowed for this role, snap to first allowed view
  const activeView: ViewKey = allowedViews.includes(view) ? view : allowedViews[0];
  const initials = data.currentUser.name.split(" ").map((part) => part[0]).join("").slice(0, 2);

  const inventoryRequest = (componentId: string, quantity: number, reason: string) => request("/api/inventory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ componentId, quantity, reason }) }, "Stock updated");
  const searchedOrders = data.orders.filter((order) => orderMatchesSearch(order, query));
  const importStock = async (file: File) => { const form = new FormData(); form.set("file", file); await request("/api/inventory/import", { method: "POST", body: form }, "Stock count uploaded"); };
  const uploadLabel = async (orderId: string, file: File) => { const form = new FormData(); form.set("file", file); await request(`/api/labels/${orderId}`, { method: "POST", body: form }, "Label uploaded"); };
  const confirmPackaging = async (orderId: string, lines: Array<{ componentId: string; quantity: number }>) => request(`/api/orders/${orderId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "packaging", payload: { lines } }) }, "Packaging plan confirmed");
  const submitQc = async (taskId: string, payload: { lines?: Array<{ orderLineId: string; goodQuantity: number; damagedQuantity: number }>; manualReceipts?: Array<{ componentId: string; quantity: number }>; note?: string }) => request(`/api/rto/${taskId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, "QC complete — stock restocked");
  const userAction = async (payload: Record<string, unknown>, success: string) => request("/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, success);

  const roleLabel: Record<typeof role, string> = {
    ADMIN: "Admin",
    MANAGER: "Manager",
    CONFIRMATION_AGENT: "Confirmation agent",
    OPERATIONS: "Operations",
    WAREHOUSE: "Warehouse",
    VIEWER: "Viewer",
  };

  return (
    <main className={`iv-shell ${confirmationOnlyShell ? "iv-shell-confirmation" : ""} ${sidebarCollapsed ? "iv-shell-sidebar-collapsed" : ""}`}>
      {!confirmationOnlyShell && <aside className="iv-sidebar">
        {canSwitchWorkspace && <div className="iv-workspace-menu">
          <div className="iv-brand">
            <div className="iv-logo">S</div>
            <div className="iv-brand-copy"><strong>Satmi</strong><button className="workspace-name-button" type="button" aria-expanded={workspaceOpen} onClick={() => setWorkspaceOpen((open) => !open)}>Operations <b aria-hidden>{workspaceOpen ? "⌃" : "⌄"}</b></button></div>
          </div>
          {workspaceOpen && <div className="iv-workspace-dropdown">
            <button type="button" onClick={() => { window.location.href = "/?workspace=inventory"; }}>
              <i>↗</i><span><strong>Inventory management</strong></span>
            </button>
          </div>}
        </div>}
          <button className="iv-sidebar-collapse" type="button" aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"} title={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"} onClick={() => setSidebarCollapsed((current) => !current)}>
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        <nav aria-label="Operations navigation">
          {navItems.filter((item) => allowedViews.includes(item.key)).map((item) => (
            <button
              key={item.key}
              className={activeView === item.key ? "active" : ""}
              title={sidebarCollapsed ? item.label : undefined}
              onClick={() => { setView(item.key); setQuery(""); void load().catch(() => undefined); }}
            >
              <i><item.Icon size={18} strokeWidth={1.8} /></i>
              <span className="iv-nav-copy"><strong>{item.label}</strong></span>
            </button>
          ))}
        </nav>
        <div className="iv-sidebar-foot">
          <span><b />{data.sampleMode ? "Sample data" : "Real orders"}</span>
          <p>{data.currentUser.name}</p>
          <button onClick={logout}>Sign out</button>
        </div>
      </aside>}

      <section className={`iv-workspace ${confirmationOnlyShell ? "iv-workspace-confirmation" : ""}`}>
        <header className="iv-topbar">
          <div>
            <h1>{navItems.find((item) => item.key === activeView)?.label ?? "Operations"}</h1>
            <p>{confirmationOnlyShell ? "Assigned confirmation queue and call actions." : <span className="role-pill">{roleLabel[role]}</span>}</p>
          </div>
          <div className="iv-top-actions">
            <button
              className="iv-theme-toggle"
              type="button"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
            >
              <span>{theme === "dark" ? "☾" : "☀"}</span>
              <strong>{theme === "dark" ? "Dark" : "Light"}</strong>
            </button>
            <div className="iv-search">
              <span>⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search orders, AWB or customer…" />
              {query && <button onClick={() => setQuery("")} aria-label="Clear search">×</button>}
            </div>
            <div className={`iv-notification-center ${notificationOpen ? "open" : ""}`}>
              <button className="iv-notification-trigger" type="button" aria-label="Notifications" aria-haspopup="dialog" aria-expanded={notificationOpen} onClick={() => { setNotificationOpen((current) => !current); setNotificationUnread(0); setProfileMenuOpen(false); }}>
                <Bell size={19} />
                {notificationUnread > 0 && <span>{notificationUnread > 9 ? "9+" : notificationUnread}</span>}
              </button>
              {notificationOpen && <div className="iv-notification-popover" role="dialog" aria-label="Notifications panel">
                <div className="iv-notification-head"><strong>Notifications</strong>{notifications.length > 0 && <button onClick={() => setNotifications([])}>Clear</button>}</div>
                <div className="iv-notification-list">
                  {notifications.map((item) => <div key={item.id} className={item.tone}><i /> <div><strong>{item.message}</strong><span>{new Date(item.createdAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}</span></div></div>)}
                  {!notifications.length && data.recentAudit.slice(0, 8).map((item) => <div key={item.id}><i /><div><strong>{item.detail || prettyStatus(item.action)}</strong><span>{item.actorName || "System"} · {age(item.createdAt)} ago</span></div></div>)}
                  {!notifications.length && !data.recentAudit.length && <p>No notifications yet.</p>}
                </div>
              </div>}
            </div>
            <div className={`iv-profile-menu ${profileMenuOpen ? "open" : ""}`}>
              <button
                className="iv-profile-trigger"
                type="button"
                aria-haspopup="menu"
                aria-expanded={profileMenuOpen}
                onClick={() => setProfileMenuOpen((current) => !current)}
              >
                <div className="iv-profile-stack">
                  <div className="iv-avatar">{initials}</div>
                  <span>{roleLabel[role]}</span>
                </div>
              </button>
              {profileMenuOpen && <div className="iv-profile-dropdown" role="menu">
                <strong>{data.currentUser.name}</strong>
                <span>{data.sampleMode ? "Sample data" : "Real orders"}</span>
                <button type="button" role="menuitem" onClick={logout}>Sign out</button>
              </div>}
            </div>
          </div>
        </header>

        <div className={`iv-content ${confirmationOnlyShell ? "iv-content-confirmation" : ""} ${activeView === "confirmation" ? "iv-content-confirmation-view" : ""}`} onClick={() => { if (profileMenuOpen) setProfileMenuOpen(false); if (notificationOpen) setNotificationOpen(false); }}>
          {activeView === "overview" && <Overview data={data} orders={data.orders} onNavigate={(v) => setView(v)} />}
          {activeView === "orders" && <Orders orders={searchedOrders} users={data.users} role={role} generatedAt={data.generatedAt} onAction={orderAction} />}
          {activeView === "confirmation" && <Confirmation data={data} orders={searchedOrders} users={data.users} campaigns={data.campaigns} currentUser={data.currentUser} onAction={orderAction} onCampaignAssign={campaignAction} onAdminAction={confirmationAdminAction} onIntegrationSync={integrationSyncAction} />}
          {activeView === "fulfillment" && <Fulfillment data={data} orders={searchedOrders} role={role} onAction={orderAction} onUpload={uploadLabel} onPackaging={confirmPackaging} onIntegrationSync={integrationSyncAction} loadMoreError={fulfillmentLoadError} onLoadMore={loadMoreFulfillmentOrders} />}
          {activeView === "inventory" && <Inventory data={data} role={role} onAdjust={inventoryRequest} onImport={importStock} onBulkSet={(items) => request("/api/inventory/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) }, "Bulk inventory count saved")} />}
          {activeView === "setup" && <ProductSetup data={data} onRequest={request} />}
          {activeView === "rto" && <Rto data={data} role={role} query={query} onQc={submitQc} />}
          {activeView === "team" && <Team data={data} onUserAction={userAction} />}
        </div>
      </section>
    </main>
  );
}


function MetricCard({ label, value, detail, tone = "default" }: { label: string; value: number | string; detail: string; tone?: string }) {
  return <article className={`metric-card ${tone}`}><div className="metric-top"><span>{label}</span><i>↗</i></div><strong>{value}</strong><p>{detail}</p></article>;
}

function InventorySummary({ data, onGo }: { data: DashboardSnapshot; onGo: (section: InventorySection) => void }) {
  const totalOnHand = data.inventory.reduce((sum, item) => sum + item.onHand, 0);
  const totalAvailable = data.inventory.reduce((sum, item) => sum + item.available, 0);
  const configuredProducts = data.products.filter((product) => product.recipeVersion).length;
  const inventoryReady = data.orders.filter((order) => order.requirementStatus === "complete" && order.requirements.length > 0 && order.requirements.every((requirement) => requirement.allocatedQuantity >= requirement.requiredQuantity)).length;
  const steps = [
    { section: "components" as const, title: "Create physical components", detail: data.inventory.length ? `${data.inventory.length} components created` : "Add products, inserts and every type of box", done: data.inventory.length > 0 },
    { section: "stock" as const, title: "Load actual stock", detail: totalOnHand ? `${totalOnHand} physical units counted` : "Enter stock one-by-one or upload a CSV", done: totalOnHand > 0 },
    { section: "recipes" as const, title: "Build product recipes", detail: `${configuredProducts} of ${data.products.length} sellable SKUs configured`, done: data.products.length > 0 && configuredProducts === data.products.length },
    { section: "packaging" as const, title: "Set courier-box sizes", detail: data.packagingProfiles.length ? `${data.packagingProfiles.length} product families configured` : "Connect small, medium and large boxes", done: data.packagingProfiles.some((profile) => profile.boxes.length > 0) },
  ];
  return <div className="focus-stack"><section className="focus-metrics"><article><span>Physical components</span><strong>{data.inventory.length}</strong><p>Different items tracked</p></article><article><span>Units on hand</span><strong>{totalOnHand}</strong><p>{totalAvailable} currently available</p></article><article><span>Recipes complete</span><strong>{configuredProducts}<small> / {data.products.length}</small></strong><p>Imported sellable SKUs</p></article><article className="highlight"><span>Orders inventory can cover</span><strong>{inventoryReady}</strong><p>All required parts allocated</p></article></section><section className="inventory-get-started"><div className="focus-section-heading"><div><p>START HERE</p><h2>Finish these four steps</h2><span>The system will not guess components or stock.</span></div><b>{steps.filter((step) => step.done).length}/4 complete</b></div><div className="setup-progress">{steps.map((step, index) => <button key={step.section} onClick={() => onGo(step.section)}><i className={step.done ? "done" : ""}>{step.done ? "✓" : index + 1}</i><span><strong>{step.title}</strong><small>{step.detail}</small></span><em>{step.done ? "Review" : "Set up"} →</em></button>)}</div></section>{data.inventory.length > 0 && <section className="inventory-health"><div className="focus-section-heading"><div><p>STOCK HEALTH</p><h2>Lowest available components</h2></div><button onClick={() => onGo("stock")}>View all stock →</button></div><div className="health-list">{[...data.inventory].sort((a, b) => a.available - b.available).slice(0, 6).map((item) => <div key={item.id}><span><strong>{item.name}</strong><small>{item.sku} · {item.componentType.replaceAll("_", " ")}</small></span><b className={item.available <= 0 ? "empty" : ""}>{item.available} available</b></div>)}</div></section>}</div>;
}

function RecipeWorkspace({ data, onRequest, query }: { data: DashboardSnapshot; onRequest: (path: string, options: RequestInit, success: string) => Promise<void>; query: string }) {
  const products = data.products.filter((product) => `${product.sku} ${product.name} ${product.variant}`.toLowerCase().includes(query.toLowerCase()));
  const [productId, setProductId] = useState(products[0]?.id ?? data.products[0]?.id ?? "");
  const product = data.products.find((item) => item.id === productId);
  return <article className="panel recipe-workspace"><div className="recipe-picker"><div><p className="eyebrow">SELLABLE PRODUCTS</p><h2>Choose a product</h2><span>These are imported products—not physical stock.</span></div><select value={productId} onChange={(event) => setProductId(event.target.value)}><option value="">Choose a sellable SKU</option>{products.map((item) => <option value={item.id} key={item.id}>{item.recipeVersion ? "✓" : "○"} {item.sku} · {item.name}</option>)}</select></div>{product ? <RecipeEditor key={productId} product={product} data={data} onRequest={onRequest}/> : <Empty title="No matching product" detail="Clear the search or import products from your connected store."/>}</article>;
}

function ReadOnlyNotice({ title }: { title: string }) {
  return <div className="panel read-only-notice"><span>i</span><div><h2>{title}</h2><p>You can still review component balances from Stock counts. Ask an administrator to change configuration.</p></div></div>;
}

function Overview({ data, orders, onNavigate }: { data: DashboardSnapshot; orders: OrderView[]; onNavigate: (view: ViewKey) => void }) {
  const completion = Math.round((data.metrics.processedToday / Math.max(1, data.metrics.processedToday + data.metrics.leftToProcess)) * 100);
  const hourlyCounts = Array(12).fill(0);
  const now = new Date(data.generatedAt).getTime();
  orders.forEach(o => {
    const hoursAgo = Math.floor((now - new Date(o.createdAt).getTime()) / 3600000);
    if (hoursAgo >= 0 && hoursAgo < 12) {
      hourlyCounts[11 - hoursAgo]++;
    }
  });
  const maxCount = Math.max(1, ...hourlyCounts);
  const flowBars = hourlyCounts.map(count => Math.round((count / maxCount) * 100));

  return <>
    <section className="metrics-grid"><MetricCard label="Processed / dispatched" value={data.metrics.processedToday} detail={`${completion}% of active orders`} tone="green"/><MetricCard label="Left to process" value={data.metrics.leftToProcess} detail={`${data.blockers.length} active blocker types`} tone="ink"/><MetricCard label="Awaiting confirmation" value={data.metrics.confirmationBacklog} detail="Assigned confirmation work" tone="amber"/><MetricCard label="Incoming RTO units" value={data.metrics.rtoUnits} detail="Potential stock · not sellable" tone="blue"/></section>
    <section className="overview-grid">
      <article className="panel attention-panel"><div className="panel-heading"><div><p className="eyebrow">LIVE WORK QUEUE</p><h2>What needs attention</h2></div><button className="text-button" onClick={() => onNavigate("orders")}>View all orders →</button></div>
        <div className="attention-list">{data.blockers.map((item, index) => <button key={item.key} onClick={() => onNavigate(item.key === "confirmation-pending" ? "confirmation" : item.key === "component-shortage" ? "inventory" : item.key === "recipe-missing" ? "setup" : "fulfillment")}><span className={`attention-index tone-${index}`}>{String(index + 1).padStart(2, "0")}</span><div><strong>{item.label}</strong><p>{item.key === "confirmation-pending" ? "Customer action required" : item.key === "component-shortage" ? "A required component is short" : item.key === "recipe-missing" ? "Configure this sellable SKU" : "Operations action required"}</p></div><b>{item.count}</b><span>›</span></button>)}</div>
      </article>
      <article className="panel flow-panel"><div className="panel-heading"><div><p className="eyebrow">TODAY’S FLOW</p><h2>Orders through the pipeline</h2></div><span className="date-pill">Last 12 hours</span></div>
        <div className="flow-chart"><div className="flow-bars">{flowBars.map((height, index) => <i key={index} style={{ height: `${height}%` }} className={index > 8 ? "accent" : ""}/>)}</div><div className="flow-axis"><span>-12h</span><span>-8h</span><span>-4h</span><span>Now</span></div></div>
        <div className="flow-legend"><div><span className="legend-dot green"/><p>Label ready<strong>{data.metrics.processedToday}</strong></p></div><div><span className="legend-dot amber"/><p>Pending<strong>{data.metrics.leftToProcess}</strong></p></div><div><span className="legend-dot gray"/><p>Delivered<strong>{data.metrics.delivered}</strong></p></div></div>
      </article>
    </section>
    <OrderTable orders={orders.slice(0, 6)} title="Recent orders"/>
  </>;
}

function StatusPill({ order }: { order: OrderView }) {
  const text = isCancelledOrder(order)
    ? (order.confirmationStatus === "cancel-requested" ? "Cancellation pending" : "Cancelled")
    : isLiveShipment(order)
      ? currentStatusLabel(order)
      : order.blocker
        ? blockerLabel[order.blocker]
        : order.labelKey
          ? "Label ready"
          : currentStatusLabel(order);
  const tone = currentStatusTone(order);
  return <span className={`status-pill ${tone}`}><i/>{text}</span>;
}

function OrderTable({ orders, title }: { orders: OrderView[]; title?: string }) {
  return <article className="panel table-panel">{title && <div className="panel-heading"><div><p className="eyebrow">ORDER STREAM</p><h2>{title}</h2></div><span className="muted">Updated just now</span></div>}<div className="table-scroll"><table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Payment</th><th>Owner</th><th>Status</th><th>Age</th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td><strong>{order.orderNumber}</strong><span>{currency.format(order.amount / 100)}</span></td><td><strong>{order.customerName}</strong><span>{order.customerPhone}</span></td><td><strong>{order.lines.reduce((sum, line) => sum + line.quantity, 0)} units</strong><span>{order.lines[0]?.sku}</span></td><td><span className="payment-pill">{order.paymentMethod}</span></td><td>{order.assignedUserName ? <span className="owner"><i>{order.assignedUserName[0]}</i>{order.assignedUserName}</span> : <span className="muted">Unassigned</span>}</td><td><StatusPill order={order}/></td><td><strong>{age(order.createdAt)}</strong></td></tr>)}</tbody></table></div></article>;
}

function Orders({ orders, users, role, generatedAt, onAction }: { orders: OrderView[]; users: DashboardSnapshot["users"]; role: DashboardSnapshot["currentUser"]["role"]; generatedAt: string; onAction: (id: string, action: string, payload?: Record<string, unknown>, success?: string) => Promise<void> }) {
  const [filter, setFilter] = useState("all");
  const visible = orders.filter((order) => filter === "all" || (filter === "left" ? !order.processed && !["delivered", "rto_delivered"].includes(order.status) : filter === "ready" ? order.processed : order.blocker === filter));
  const canConfirm = ["ADMIN", "MANAGER"].includes(role);
  return <><div className="filter-row"><div className="segmented"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All <b>{orders.length}</b></button><button className={filter === "left" ? "active" : ""} onClick={() => setFilter("left")}>Left to process</button><button className={filter === "ready" ? "active" : ""} onClick={() => setFilter("ready")}>Dispatchable</button><button className={filter === "component-shortage" ? "active" : ""} onClick={() => setFilter("component-shortage")}>Shortages</button></div><span className="date-pill">Live snapshot {new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(generatedAt))}</span></div><article className="panel table-panel workbench orders-workbench"><div className="table-scroll orders-workbench-scroll"><table className="orders-workbench-table"><thead><tr><th>Order</th><th>Customer</th><th>Component allocation</th><th>Confirmation</th><th>Shiprocket</th><th>Next action</th></tr></thead><tbody>{visible.map((order) => { const required = order.requirements.reduce((sum, item) => sum + item.requiredQuantity, 0); const allocated = order.requirements.reduce((sum, item) => sum + item.allocatedQuantity, 0); const allocationHeadline = order.blocker === "invalid-SKU" ? "SKU mapping missing" : order.requirementStatus === "missing" || !order.requirementStatus ? "Recipe missing" : `${allocated}/${required} components`; const allocationDetail = order.blocker === "invalid-SKU" ? "This order cannot allocate components until every line maps to a sellable SKU in the catalog." : order.shortageSummary || (order.requirementStatus === "packaging-required" ? "Packaging decision required" : "All requirements covered"); const shiprocketHeadline = order.shiprocketOrderId ? (order.awb || "AWB pending") : "Sync pending"; const shiprocketDetail = order.shiprocketOrderId ? (order.courier || "Shiprocket linked") : "Order not linked in Shiprocket yet"; return <tr key={order.id}><td><strong>{order.orderNumber}</strong><span>{currency.format(order.amount / 100)} · {age(order.createdAt)}</span></td><td><strong>{order.customerName}</strong><span>{order.lines.map((line) => line.sku).join(", ")}</span></td><td><span className={order.blocker === "component-shortage" || order.blocker === "invalid-SKU" ? "stock-cell bad" : "stock-cell good"}>{allocationHeadline}</span><span>{allocationDetail}</span></td><td>{canConfirm ? <div className="confirmation-orders-hint"><strong>{order.assignedCampaign ? `${order.assignedCampaign.name} · ${order.assignedCampaign.assignedAgentName || "Assigned"}` : "Assign from Campaign Assignment"}</strong><span>{order.assignedCampaign ? `Board priority #${order.assignedCampaign.position + 1}` : "Orders reach agent queues only through the Campaign Assignment tab."}</span></div> : <span className="muted">{order.confirmationStatus.replaceAll("-", " ")}</span>}</td><td><strong>{shiprocketHeadline}</strong><span>{shiprocketDetail}</span></td><td><StatusPill order={order}/></td></tr>; })}</tbody></table></div></article></>;
}

function normalizeName(value: string | null | undefined) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePhoneDigits(value: string | null | undefined) {
  return String(value || "").replace(/\D+/g, "");
}

function normalizeAddress(value: string | null | undefined) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function orderLineSignature(order: OrderView) {
  return order.lines.map((line) => `${normalizeName(line.name)}:${line.quantity}`).sort().join("|");
}

function isHistoricalUnfulfilled(status: string) {
  return !["DELIVERED", "RTO_RESTOCKED", "CANCELED", "CANCELLED", "SHIPMENT_AUTO_CANCELLED"].includes(status.toUpperCase());
}

function buildCampaignCriteriaSummary(criteria: CampaignCriteria | null) {
  if (!criteria) return "No filters stored";
  const parts = [
    criteria.duplicateMode !== "NONE" ? `duplicates: ${criteria.duplicateMode.toLowerCase().replaceAll("_", " ")}` : "",
    criteria.tags.length ? `tags: ${criteria.tags.join(", ")}` : "",
    criteria.orderNumbers.length ? `orders: ${criteria.orderNumbers.join(", ")}` : "",
    criteria.productNames.length ? `products: ${criteria.productNames.join(", ")}` : "",
    criteria.paymentMethod !== "ANY" ? `payment: ${criteria.paymentMethod}` : "",
    criteria.previousUnfulfilledOnly ? "prior unfulfilled history" : "",
    !criteria.includeRtoRisk ? "excluding RTO risk" : "",
    criteria.autoAssignFutureMatching ? "auto-assign future matching orders" : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No filters stored";
}

function Confirmation({ data, orders, users, campaigns, currentUser, onAction, onCampaignAssign, onAdminAction, onIntegrationSync }: { data: DashboardSnapshot; orders: OrderView[]; users: DashboardSnapshot["users"]; campaigns: DashboardSnapshot["campaigns"]; currentUser: DashboardSnapshot["currentUser"]; onAction: (id: string, action: string, payload?: Record<string, unknown>, success?: string) => Promise<void>; onCampaignAssign: (payload: Record<string, unknown>, success?: string) => Promise<void>; onAdminAction: (action: string, payload: Record<string, unknown>, success?: string) => Promise<void>; onIntegrationSync: (success?: string) => Promise<void> }) {
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const [attemptDrafts, setAttemptDrafts] = useState<Record<string, { note: string; callbackAt: string; callPicked: "yes" | "no"; rejectionReason: string }>>({});
  const [quickAction, setQuickAction] = useState<{ type: "approved" | "rejection" | "edit"; orderId: string } | null>(null);
  const [quickActionNote, setQuickActionNote] = useState("");
  const [quickActionReason, setQuickActionReason] = useState<ConfirmationRejectionReason | "">("");
  const [campaignModalOpen, setCampaignModalOpen] = useState(false);
  const [selectedCampaignDetailId, setSelectedCampaignDetailId] = useState<string | null>(null);
  const [campaignName, setCampaignName] = useState("");
  const [campaignAgentId, setCampaignAgentId] = useState("");
  const [campaignOrderNumbers, setCampaignOrderNumbers] = useState("");
  const [campaignSelectedOrderIds, setCampaignSelectedOrderIds] = useState<string[]>([]);
  const [campaignSearch, setCampaignSearch] = useState("");
  const deferredCampaignSearch = useDeferredValue(campaignSearch);
  const [campaignSourceOrders, setCampaignSourceOrders] = useState<OrderView[]>([]);
  const [campaignSourcePage, setCampaignSourcePage] = useState({ nextOffset: 0, total: 0, hasMore: true });
  const [campaignSourceLoading, setCampaignSourceLoading] = useState(false);
  const [campaignSourceError, setCampaignSourceError] = useState("");
  const [campaignSyncing, setCampaignSyncing] = useState(false);
  const [campaignFilters, setCampaignFilters] = useState<CampaignCriteria>({ duplicateOnly: false, duplicateMode: "NONE", tags: [], orderNumbers: [], productNames: [], paymentMethod: "ANY", previousUnfulfilledOnly: false, includeRtoRisk: true, autoAssignFutureMatching: false });
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [overrideReasons, setOverrideReasons] = useState<Record<string, string>>({});
  const [reviewTab, setReviewTab] = useState<"queue" | "campaigns" | "approvals">("queue");
  const reviewer = ["ADMIN", "MANAGER"].includes(currentUser.role);
  const snapshotTime = new Date(data.generatedAt).getTime();
  const draftKey = (orderId: string, fieldName: string) => `${orderId}:${fieldName}`;
  const pendingRequest = (order: OrderView, fieldName: "customer_name" | "shipping_address" | "customer_phone") => order.pendingEditRequests.find((request) => request.fieldName === fieldName) ?? null;
  const currentFieldValue = (order: OrderView, fieldName: "customer_name" | "shipping_address" | "customer_phone") => fieldName === "customer_name" ? order.customerName : fieldName === "customer_phone" ? (order.customerPhone ?? "") : (order.customerAddress ?? "");
  const attemptDraft = (orderId: string) => attemptDrafts[orderId] ?? { note: "", callbackAt: "", callPicked: "yes", rejectionReason: "" };
  const nextAttemptNumber = (order: OrderView) => Math.min(4, order.confirmationAttempts.length + 1);
  const canLogAttempt = (order: OrderView) => order.confirmationAttempts.length < 3 && !["confirmed", "cancelled"].includes(order.confirmationStatus);
  const urgencyRank: Record<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL", number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  const confirmationAgents = users.filter((user) => user.role === "CONFIRMATION_AGENT" && user.active);
  const activeCampaigns = campaigns.filter((campaign) => campaign.isActive).sort((left, right) => left.position - right.position || new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const modalOrders = campaignModalOpen ? campaignSourceOrders : data.orders;
  const campaignOrders = modalOrders.filter((order) => order.assignedCampaign);
  const campaignOrdersByCampaign = new Map<string, OrderView[]>();
  for (const order of campaignOrders) {
    const campaignId = order.assignedCampaign?.id;
    if (!campaignId) continue;
    const current = campaignOrdersByCampaign.get(campaignId) ?? [];
    current.push(order);
    campaignOrdersByCampaign.set(campaignId, current);
  }
  for (const [campaignId, campaignQueue] of campaignOrdersByCampaign.entries()) {
    campaignOrdersByCampaign.set(campaignId, campaignQueue.sort((left, right) => (left.assignedCampaign?.orderPosition ?? 0) - (right.assignedCampaign?.orderPosition ?? 0) || new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()));
  }
  const assignableOrders = campaignModalOpen ? modalOrders.filter((order) => !order.assignedCampaign && !["cancelled", "delivered", "rto_delivered"].includes(order.status)) : [];
  const tagOptions = campaignModalOpen ? [...new Set(modalOrders.flatMap((order) => order.shopifyTags).map((tag) => tag.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right)) : [];
  const productOptions = campaignModalOpen ? [...new Set(data.products.map((product) => product.name))].sort((left, right) => left.localeCompare(right)) : [];
  const selectedProductIds = new Set(data.products.filter((product) => campaignFilters.productNames.includes(product.name)).map((product) => product.id));
  const normalizedRequestedOrderNumbers = campaignModalOpen ? campaignOrderNumbers
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean) : [];
  const invalidOrderNumberFormat = campaignModalOpen && campaignOrderNumbers.trim().length > 0 && (campaignOrderNumbers !== normalizedRequestedOrderNumbers.join(",") || normalizedRequestedOrderNumbers.some((value) => !/^SI\d{6,}$/.test(value)));
  const knownOrderNumbers = new Set(modalOrders.map((order) => order.orderNumber.replace(/^#/, "").toUpperCase()));
  const unknownOrderNumbers = invalidOrderNumberFormat ? [] : normalizedRequestedOrderNumbers.filter((orderNumber) => !knownOrderNumbers.has(orderNumber));
  const duplicateEligibleOrderIds = new Set<string>();
  if (campaignModalOpen && campaignFilters.duplicateMode !== "NONE") {
    const duplicateGroups = new Map<string, string[]>();
    for (const order of modalOrders) {
      const lineSignature = orderLineSignature(order);
      const identifiers = campaignFilters.duplicateMode === "SHOPIFY_CUSTOMER_PRODUCT"
        ? [order.shopifyCustomerId ? `customer:${order.shopifyCustomerId}` : ""]
        : campaignFilters.duplicateMode === "PHONE_OR_ADDRESS_PRODUCT"
          ? [normalizePhoneDigits(order.customerPhone) ? `phone:${normalizePhoneDigits(order.customerPhone)}` : "", normalizeAddress(order.customerAddress) ? `address:${normalizeAddress(order.customerAddress)}` : ""]
          : [normalizeName(order.customerName) && normalizePhoneDigits(order.customerPhone) ? `name-phone:${normalizeName(order.customerName)}:${normalizePhoneDigits(order.customerPhone)}` : ""];
      for (const identifier of identifiers.filter(Boolean)) {
        const key = `${identifier}|${lineSignature}`;
        duplicateGroups.set(key, [...(duplicateGroups.get(key) ?? []), order.id]);
      }
    }
    for (const group of duplicateGroups.values()) if (group.length > 1) group.forEach((orderId) => duplicateEligibleOrderIds.add(orderId));
  }
  const priorUnfulfilledEligibleOrderIds = new Set<string>();
  if (campaignModalOpen && campaignFilters.previousUnfulfilledOnly) {
    for (const order of modalOrders) {
      const currentCreatedAt = new Date(order.createdAt).getTime();
      const currentPhone = normalizePhoneDigits(order.customerPhone);
      const currentAddress = normalizeAddress(order.customerAddress);
      const currentName = normalizeName(order.customerName);
      // "Unfulfilled" is mapped from the existing status vocabulary by excluding
      // delivered, restocked-return, and canceled terminal states.
      if (modalOrders.some((candidate) => candidate.id !== order.id && new Date(candidate.createdAt).getTime() < currentCreatedAt && isHistoricalUnfulfilled(candidate.currentStatus || candidate.status) && (
        (order.shopifyCustomerId && order.shopifyCustomerId === candidate.shopifyCustomerId) ||
        (currentPhone && currentPhone === normalizePhoneDigits(candidate.customerPhone)) ||
        (currentName && currentAddress && currentName === normalizeName(candidate.customerName) && currentAddress === normalizeAddress(candidate.customerAddress))
      ))) priorUnfulfilledEligibleOrderIds.add(order.id);
    }
  }
  const modalCriteria: CampaignCriteria = { ...campaignFilters, orderNumbers: normalizedRequestedOrderNumbers };
  const filteredAssignableOrders = campaignModalOpen ? assignableOrders.filter((order) => {
    if (modalCriteria.duplicateMode !== "NONE" && !duplicateEligibleOrderIds.has(order.id)) return false;
    if (modalCriteria.tags.length && !modalCriteria.tags.some((tag) => order.shopifyTags.some((orderTag) => normalizeName(orderTag) === normalizeName(tag)))) return false;
    if (modalCriteria.orderNumbers.length && !modalCriteria.orderNumbers.includes(order.orderNumber.replace(/^#/, "").toUpperCase())) return false;
    if (modalCriteria.productNames.length && !order.lines.some((line) => (line.productId && selectedProductIds.has(line.productId)) || modalCriteria.productNames.some((name) => normalizeName(line.name) === normalizeName(name)))) return false;
    if (modalCriteria.paymentMethod !== "ANY" && normalizeName(order.paymentMethod) !== normalizeName(modalCriteria.paymentMethod)) return false;
    if (modalCriteria.previousUnfulfilledOnly && !priorUnfulfilledEligibleOrderIds.has(order.id)) return false;
    if (!modalCriteria.includeRtoRisk && order.rtoRisk === "HIGH") return false;
    return true;
  }).filter((order) => !deferredCampaignSearch.trim() || `${order.orderNumber} ${order.customerName}`.toLowerCase().includes(deferredCampaignSearch.trim().toLowerCase())).sort((left, right) => (validDate(right.createdAt)?.getTime() ?? 0) - (validDate(left.createdAt)?.getTime() ?? 0)) : [];
  const renderedAssignableOrders = filteredAssignableOrders;
  const filteredAssignableOrderIds = new Set(filteredAssignableOrders.map((order) => order.id));
  const visibleSelectedCampaignOrderIds = campaignSelectedOrderIds.filter((orderId) => filteredAssignableOrderIds.has(orderId));
  const queue = orders
    .filter((order) => {
      if (!order.assignedCampaign) return false;
      if (["cancelled", "delivered", "rto_delivered"].includes(order.status)) return false;
      const latestAttempt = order.confirmationAttempts[order.confirmationAttempts.length - 1];
      const coolingUntil = latestAttempt?.nextActionAt ? new Date(latestAttempt.nextActionAt).getTime() : 0;
      if (coolingUntil > snapshotTime && canLogAttempt(order)) return false;
      return reviewer ? true : order.assignedCampaign.assignedAgentId === currentUser.id;
    })
    .sort((left, right) => {
      const campaignDelta = (left.assignedCampaign?.position ?? 0) - (right.assignedCampaign?.position ?? 0);
      if (campaignDelta) return campaignDelta;
      const orderDelta = (left.assignedCampaign?.orderPosition ?? 0) - (right.assignedCampaign?.orderPosition ?? 0);
      if (orderDelta) return orderDelta;
      return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    });
  const cancellationRequests = orders
    .filter((order) => order.confirmationStatus === "cancel-requested")
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const quickOrder = quickAction ? queue.find((order) => order.id === quickAction.orderId) ?? orders.find((order) => order.id === quickAction.orderId) ?? null : null;

  function openQuickAction(type: "approved" | "rejection" | "edit", order: OrderView) {
    setQuickAction({ type, orderId: order.id });
    setQuickActionNote("");
    setQuickActionReason("");
    if (type === "edit") {
      setEditDrafts((drafts) => ({
        ...drafts,
        [draftKey(order.id, "customer_name")]: drafts[draftKey(order.id, "customer_name")] ?? order.customerName,
        [draftKey(order.id, "customer_phone")]: drafts[draftKey(order.id, "customer_phone")] ?? (order.customerPhone ?? ""),
        [draftKey(order.id, "shipping_address")]: drafts[draftKey(order.id, "shipping_address")] ?? (order.customerAddress ?? ""),
      }));
    }
  }

  function closeQuickAction() {
    setQuickAction(null);
    setQuickActionNote("");
    setQuickActionReason("");
  }

  async function submitEditRequest(order: OrderView, fieldName: "customer_name" | "shipping_address" | "customer_phone") {
    const value = (editDrafts[draftKey(order.id, fieldName)] ?? currentFieldValue(order, fieldName)).trim();
    if (!value) return;
    await onAction(order.id, "request-edit", { fieldName, newValue: value }, "Edit request sent for approval");
    setEditDrafts((drafts) => {
      const next = { ...drafts };
      delete next[draftKey(order.id, fieldName)];
      return next;
    });
  }

  async function submitOutcome(order: OrderView, outcome: string, success: string) {
    const draft = attemptDraft(order.id);
    await onAction(order.id, "outcome", {
      outcome,
      note: draft.note.trim(),
      callbackAt: draft.callbackAt || null,
      nextActionAt: draft.callbackAt || null,
      callPicked: draft.callPicked === "yes",
      rejectionReason: outcome === "cancel-requested" || outcome === "cancelled" ? (draft.rejectionReason || null) : null,
    }, success);
    setAttemptDrafts((drafts) => {
      const next = { ...drafts };
      delete next[order.id];
      return next;
    });
  }

  async function submitQuickApproved(order: OrderView) {
    await onAction(order.id, "outcome", {
      outcome: "confirmed",
      note: quickActionNote.trim(),
      callbackAt: null,
      nextActionAt: null,
      callPicked: true,
      rejectionReason: null,
    }, "Order confirmed");
    closeQuickAction();
  }

  async function submitQuickRejection(order: OrderView) {
    const outcome = reviewer ? "cancelled" : "cancel-requested";
    await onAction(order.id, "outcome", {
      outcome,
      note: quickActionNote.trim(),
      callbackAt: null,
      nextActionAt: null,
      callPicked: true,
      rejectionReason: quickActionReason,
    }, reviewer ? "Order cancelled internally" : "Cancellation request sent for approval");
    closeQuickAction();
  }

  async function loadCampaignOrders(offset: number, replace = false) {
    if (campaignSourceLoading) return;
    setCampaignSourceLoading(true);
    setCampaignSourceError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(`/api/state?scope=orders&queue=campaign-selection&limit=120&offset=${offset}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
      if (response.status === 401) { window.location.href = "/login"; return; }
      if (!response.ok) throw new Error("Could not load campaign orders");
      const snapshot = await response.json() as DashboardSnapshot;
      setCampaignSourceOrders((current) => {
        if (replace) return snapshot.orders;
        const incoming = new Map(snapshot.orders.map((order) => [order.id, order]));
        const merged = current.map((order) => incoming.get(order.id) ?? order);
        const known = new Set(current.map((order) => order.id));
        return [...merged, ...snapshot.orders.filter((order) => !known.has(order.id))];
      });
      setCampaignSourcePage({ nextOffset: snapshot.orderPagination.nextOffset, total: snapshot.orderPagination.total, hasMore: snapshot.orderPagination.hasMore });
    } catch {
      setCampaignSourceError("Older orders could not be loaded. Please try again.");
    } finally {
      window.clearTimeout(timeout);
      setCampaignSourceLoading(false);
    }
  }

  function openCampaignModal() {
    setCampaignModalOpen(true);
    setCampaignName("");
    setCampaignAgentId(confirmationAgents[0]?.id ?? "");
    setCampaignOrderNumbers("");
    setCampaignSearch("");
    setCampaignSourceOrders([]);
    setCampaignSourcePage({ nextOffset: 0, total: 0, hasMore: true });
    setCampaignSourceError("");
    setCampaignFilters({ duplicateOnly: false, duplicateMode: "NONE", tags: [], orderNumbers: [], productNames: [], paymentMethod: "ANY", previousUnfulfilledOnly: false, includeRtoRisk: true, autoAssignFutureMatching: false });
    setCampaignSelectedOrderIds([]);
    void loadCampaignOrders(0, true);
  }

  function closeCampaignModal() {
    setCampaignModalOpen(false);
    setCampaignSelectedOrderIds([]);
  }

  function setCampaignFilterValues(key: "tags" | "productNames", values: string[]) {
    setCampaignFilters((current) => ({ ...current, [key]: values }));
  }

  async function syncCampaignSourceData() {
    if (campaignSyncing) return;
    setCampaignSyncing(true);
    try {
      await onIntegrationSync("Shopify orders, tags, and products synced");
    } finally {
      setCampaignSyncing(false);
    }
  }

  async function submitCampaignCreation() {
    const longTermCampaign = campaignFilters.autoAssignFutureMatching && campaignFilters.tags.length > 0;
    if ((!visibleSelectedCampaignOrderIds.length && !longTermCampaign) || !campaignAgentId || !campaignName.trim() || invalidOrderNumberFormat || unknownOrderNumbers.length) return;
    await onCampaignAssign({
      name: campaignName.trim(),
      assignedAgentId: campaignAgentId,
      orderIds: visibleSelectedCampaignOrderIds,
      description: buildCampaignCriteriaSummary(modalCriteria),
      criteria: modalCriteria,
    }, longTermCampaign ? `${campaignName.trim()} will auto-assign future matching orders` : `${visibleSelectedCampaignOrderIds.length} order(s) assigned to ${campaignName.trim()}`);
    closeCampaignModal();
  }

  async function handleCampaignDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = activeCampaigns.map((campaign) => campaign.id);
    const sourceIndex = ids.indexOf(String(active.id));
    const targetIndex = ids.indexOf(String(over.id));
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextIds = arrayMove(ids, sourceIndex, targetIndex);
    await onCampaignAssign({ action: "reorder", campaignIds: nextIds }, "Campaign priority updated");
  }

  async function reviewCancellation(order: OrderView, decision: "cancelled" | "cancel-rejected") {
    const latestAttempt = order.confirmationAttempts[order.confirmationAttempts.length - 1];
    const reviewKey = `cancel:${order.id}`;
    const note = (reviewNotes[reviewKey] ?? "").trim() || latestAttempt?.note || order.cancellationReason || "Reviewed in approval queue";
    await onAction(order.id, "outcome", {
      outcome: decision,
      note,
      rejectionReason: latestAttempt?.rejectionReason || "other",
      callPicked: latestAttempt?.callPicked ?? true,
    }, decision === "cancelled" ? "Cancellation approved" : "Cancellation request rejected");
  }

  const expandedOrder = expandedOrderId ? queue.find((order) => order.id === expandedOrderId) ?? null : null;
  const selectedCampaignDetail = selectedCampaignDetailId ? activeCampaigns.find((campaign) => campaign.id === selectedCampaignDetailId) ?? null : null;
  const selectedCampaignOrders = selectedCampaignDetail ? campaignOrdersByCampaign.get(selectedCampaignDetail.id) ?? [] : [];

  const queueView = !queue.length ? <Empty title="Confirmation queue is clear" detail="Assigned orders reappear automatically after their recall cooldown ends." /> : <article className="panel table-panel confirmation-sheet-panel"><div className="panel-heading"><div><p className="eyebrow">ASSIGNED CONFIRMATIONS</p><h2>Confirmation workbench</h2></div><span className="count-badge">{queue.length} available orders</span></div><div className="table-scroll confirmation-table-scroll"><table className="confirmation-sheet"><thead><tr><th className="sticky-order-column">Order ID</th><th>Customer name</th><th>Phone number</th><th>Address</th><th>Notes</th><th className="sticky-action-column sticky-action-approved">Approved</th><th className="sticky-action-column sticky-action-rejection">Rejection</th><th className="sticky-action-column sticky-action-edit">Edit</th></tr></thead><tbody>{queue.map((order) => {
    const latestAttempt = order.confirmationAttempts[order.confirmationAttempts.length - 1];
    const cancellationRequested = order.confirmationStatus === "cancel-requested";
    const pendingEdits = order.pendingEditRequests.filter((request) => request.status === "PENDING");
    return <tr key={order.id}><td className="sticky-order-column"><div className="confirmation-order-cell"><strong>{order.orderNumber}</strong><span>{order.assignedCampaign ? `${order.assignedCampaign.name} · Priority #${order.assignedCampaign.position + 1}` : "Campaign required"}</span></div></td><td><div className="confirmation-cell"><strong>{order.customerName}</strong></div></td><td><div className="confirmation-cell"><strong>{confirmationPhone(order, modalOrders)}</strong></div></td><td><div className="confirmation-cell"><strong>{order.customerAddress || "No address saved"}</strong></div></td><td><div className="confirmation-cell"><strong>{latestAttempt?.note || "No notes logged yet"}</strong><button className="text-button mini" onClick={() => setExpandedOrderId(order.id)}>{`Show history${order.confirmationAttempts.length ? ` (${order.confirmationAttempts.length})` : ""}`}</button></div></td><td className="sticky-action-column sticky-action-approved"><div className="confirmation-cell confirmation-action-cell"><button className="success-button small confirmation-decision-button" onClick={() => openQuickAction("approved", order)}>Approve</button></div></td><td className="sticky-action-column sticky-action-rejection"><div className="confirmation-cell confirmation-action-cell"><button className="danger-button small confirmation-decision-button" onClick={() => openQuickAction("rejection", order)}>{reviewer ? "Reject" : "Request"}</button></div></td><td className="sticky-action-column sticky-action-edit"><div className="confirmation-cell confirmation-action-cell"><button className="small-button confirmation-icon-button" aria-label={`Edit ${order.orderNumber}`} onClick={() => openQuickAction("edit", order)}>✎</button></div></td></tr>;
  })}</tbody></table></div></article>;

  const campaignsView = (
    <div className="confirmation-layout">
      <article className="panel confirmation-assignment-panel confirmation-board-panel">
        <div className="panel-heading confirmation-board-heading">
          <div>
            <h2>Campaign Assignment</h2>
            <p>Drag and drop to set campaign priority. Top campaigns have highest priority.</p>
          </div>
          <div className="confirmation-board-head-actions">
            <button className="primary-button" type="button" aria-haspopup="dialog" aria-expanded={campaignModalOpen} onClick={(event) => { event.stopPropagation(); openCampaignModal(); }}>+&nbsp; Create new campaign</button>
          </div>
        </div>
      {activeCampaigns.length ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void handleCampaignDragEnd(event)}>
            <SortableContext items={activeCampaigns.map((campaign) => campaign.id)} strategy={verticalListSortingStrategy}>
              <div className="confirmation-campaign-board">
                {activeCampaigns.map((campaign) => <SortableCampaignCard key={campaign.id} campaign={campaign} assignedOrders={campaignOrdersByCampaign.get(campaign.id) ?? []} onOpen={() => setSelectedCampaignDetailId(campaign.id)} />)}
              </div>
            </SortableContext>
          </DndContext>
        ) : <Empty title="No campaigns yet" detail="Create the first campaign from the button above and assign filtered orders to an agent." />}
      </article>
      {campaignModalOpen && <div className="create-campaign-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) closeCampaignModal(); }}>
        <div className="create-campaign-modal" role="dialog" aria-modal="true" aria-label="Create confirmation campaign" onClick={(event) => event.stopPropagation()}>
          <header className="create-campaign-header">
            <div>
              <h2>Create campaign</h2>
              <span>Filter local Shopify orders and assign the selected results.</span>
            </div>
            <div className="create-campaign-header-actions">
              <button className="create-campaign-sync" type="button" aria-label="Sync from Shopify" title="Sync from Shopify" aria-busy={campaignSyncing} onClick={() => void syncCampaignSourceData()}>
                <RefreshCw size={18} className={campaignSyncing ? "spinning" : ""} />
              </button>
              <button className="create-campaign-close" type="button" aria-label="Close create campaign" onClick={closeCampaignModal}><X size={21} /></button>
            </div>
          </header>
          <section className="create-campaign-submit-bar" aria-label="Campaign details">
            <label className="create-campaign-field">
              <span>Campaign name</span>
              <input value={campaignName} onChange={(event) => setCampaignName(event.target.value)} placeholder="Enter campaign name" />
            </label>
            <label className="create-campaign-field">
              <span>Assign to agent</span>
              <select value={campaignAgentId} onChange={(event) => setCampaignAgentId(event.target.value)}>
                <option value="">Select agent</option>
                {confirmationAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
              </select>
            </label>
            <ToggleSwitchField label="Long-term tag campaign" checked={campaignFilters.autoAssignFutureMatching} onChange={(checked) => setCampaignFilters((current) => ({ ...current, autoAssignFutureMatching: checked }))} />
          </section>
          <section className="create-campaign-filters">
            <label className="create-campaign-field">
              <span>Duplicate orders</span>
              <select value={campaignFilters.duplicateMode} onChange={(event) => { const duplicateMode = event.target.value as CampaignDuplicateMode; setCampaignFilters((current) => ({ ...current, duplicateMode, duplicateOnly: duplicateMode !== "NONE" })); }}>
                <option value="NONE">Off</option>
                <option value="NAME_PHONE_PRODUCT">Same name + phone + product lines</option>
                <option value="SHOPIFY_CUSTOMER_PRODUCT">Same Shopify customer + product lines</option>
                <option value="PHONE_OR_ADDRESS_PRODUCT">Same phone or address + product lines</option>
              </select>
            </label>
            <MultiSelectField title="Tags" placeholder="All tags" options={tagOptions} selected={campaignFilters.tags} onChange={(values) => setCampaignFilterValues("tags", values)} />
            <label className="create-campaign-field create-campaign-full">
              <span>Order IDs</span>
              <input value={campaignOrderNumbers} onChange={(event) => setCampaignOrderNumbers(event.target.value.toUpperCase())} placeholder="SI0715676,SI0715677" />
              <small className={invalidOrderNumberFormat ? "create-campaign-error active" : "create-campaign-error"}>Invalid order format.<br/>Expected: SI0715676,SI0715677</small>
              {!invalidOrderNumberFormat && unknownOrderNumbers.length > 0 && <small className="create-campaign-error active">Not found in locally synced orders: {unknownOrderNumbers.join(", ")}</small>}
            </label>
            <MultiSelectField title="Products" placeholder="All products" options={productOptions} selected={campaignFilters.productNames} onChange={(values) => setCampaignFilterValues("productNames", values)} />
            <label className="create-campaign-field">
              <span>Payment method</span>
              <select value={campaignFilters.paymentMethod} onChange={(event) => setCampaignFilters((current) => ({ ...current, paymentMethod: event.target.value as CampaignCriteria["paymentMethod"] }))}>
                <option value="ANY">Any</option>
                <option value="COD">COD</option>
                <option value="Prepaid">Prepaid</option>
              </select>
            </label>
            <ToggleSwitchField label="Previous unfulfilled orders" checked={campaignFilters.previousUnfulfilledOnly} onChange={(checked) => setCampaignFilters((current) => ({ ...current, previousUnfulfilledOnly: checked }))} />
            <ToggleSwitchField label="Include RTO-risk orders" checked={campaignFilters.includeRtoRisk} onChange={(checked) => setCampaignFilters((current) => ({ ...current, includeRtoRisk: checked }))} />
          </section>
          <section className="create-campaign-results">
            <label className="create-campaign-search">
              <Search size={21} strokeWidth={1.8} aria-hidden="true" />
              <input aria-label="Search orders" value={campaignSearch} onChange={(event) => setCampaignSearch(event.target.value)} placeholder="Search by order number or customer name" />
            </label>
            <div className="create-campaign-table-wrap" onScroll={(event) => { const target = event.currentTarget; if (target.scrollHeight - target.scrollTop - target.clientHeight < 180 && campaignSourcePage.hasMore && !campaignSourceLoading) void loadCampaignOrders(campaignSourcePage.nextOffset); }}>
              <table className="create-campaign-table">
                <thead>
                  <tr>
                    <th className="create-campaign-select-column"><input type="checkbox" aria-label="Select all matching orders" checked={filteredAssignableOrders.length > 0 && visibleSelectedCampaignOrderIds.length === filteredAssignableOrders.length} onChange={(event) => setCampaignSelectedOrderIds(event.target.checked ? filteredAssignableOrders.map((order) => order.id) : [])} /></th>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Date</th>
                    <th>Total</th>
                    <th>Payment</th>
                    <th>Fulfillment</th>
                  </tr>
                </thead>
                <tbody>
                  {renderedAssignableOrders.map((order) => (
                    <tr key={order.id} className={campaignSelectedOrderIds.includes(order.id) ? "selected" : ""}>
                      <td className="create-campaign-select-column"><input type="checkbox" aria-label={`Select ${order.orderNumber}`} checked={campaignSelectedOrderIds.includes(order.id)} onChange={() => setCampaignSelectedOrderIds((current) => current.includes(order.id) ? current.filter((value) => value !== order.id) : [...current, order.id])} /></td>
                      <td><strong>{order.orderNumber}</strong></td>
                      <td>{order.customerName}</td>
                      <td>{campaignDate(order.createdAt)}</td>
                      <td>{campaignCurrency.format(order.amount / 100)}</td>
                      <td><span className={`create-campaign-badge payment-${order.paymentMethod.toLowerCase()}`}>{order.paymentMethod}</span></td>
                      <td><span className={`create-campaign-badge ${isHistoricalUnfulfilled(order.currentStatus || order.status) ? "status-unfulfilled" : "status-fulfilled"}`}>{isHistoricalUnfulfilled(order.currentStatus || order.status) ? "Unfulfilled" : "Fulfilled"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!campaignSourceLoading && !filteredAssignableOrders.length && (
                <div className="create-campaign-empty">
                  <strong>No orders match these filters</strong>
                  <span>Adjust the campaign filters above to populate the selection list.</span>
                </div>
              )}
            </div>
            <div className="create-campaign-table-footer">
              <span>{campaignSourceLoading ? "Loading orders…" : `${filteredAssignableOrders.length} matching orders · ${campaignSourceOrders.length} of ${campaignSourcePage.total} loaded`}</span>
              {campaignSourcePage.hasMore && !campaignSourceLoading && <button className="small-button" type="button" onClick={() => void loadCampaignOrders(campaignSourcePage.nextOffset)}>Load older orders</button>}
              {campaignSourceError && <><span role="alert">{campaignSourceError}</span><button className="small-button" type="button" onClick={() => void loadCampaignOrders(campaignSourcePage.nextOffset)}>Retry</button></>}
            </div>
          </section>
          <section className="create-campaign-submit-bar">
            <span>{campaignFilters.autoAssignFutureMatching ? "Future orders with every selected tag will be added automatically." : "Select current orders to add them to this campaign."}</span>
            <button className="create-campaign-submit" disabled={(!visibleSelectedCampaignOrderIds.length && !(campaignFilters.autoAssignFutureMatching && campaignFilters.tags.length > 0)) || !campaignAgentId || !campaignName.trim() || invalidOrderNumberFormat || unknownOrderNumbers.length > 0} onClick={() => void submitCampaignCreation()}>
              Submit
            </button>
          </section>
        </div>
      </div>}
      {selectedCampaignDetail && <div className="confirmation-dialog-backdrop" role="presentation" onClick={() => setSelectedCampaignDetailId(null)}>
        <div className="confirmation-dialog confirmation-campaign-detail-dialog" role="dialog" aria-modal="true" aria-label="Campaign detail" onClick={(event) => event.stopPropagation()}>
          <button className="confirmation-dialog-close" onClick={() => setSelectedCampaignDetailId(null)} aria-label="Close dialog">×</button>
          <div className="confirmation-dialog-head">
            <p className="eyebrow">CAMPAIGN DETAIL</p>
            <h2>{selectedCampaignDetail.name}</h2>
            <span>{selectedCampaignDetail.description || buildCampaignCriteriaSummary(selectedCampaignDetail.criteria)}</span>
          </div>
          <div className="confirmation-campaign-detail-summary">
            <div><span>Board priority</span><strong>#{selectedCampaignDetail.position + 1}</strong></div>
            <div><span>Assigned agent</span><strong>{selectedCampaignDetail.assignedAgentName || "Unassigned"}</strong></div>
            <div><span>Orders</span><strong>{selectedCampaignOrders.length}</strong></div>
            <div><span>Created by</span><strong>{selectedCampaignDetail.createdByName || "Unknown"}</strong></div>
          </div>
          <div className="confirmation-campaign-detail-orders">
            <table>
              <thead><tr><th>Order</th><th>Customer</th><th>Phone</th><th>Products</th><th>Payment</th><th>Status</th></tr></thead>
              <tbody>{selectedCampaignOrders.map((order) => <tr key={order.id}><td><strong>{order.orderNumber}</strong></td><td>{order.customerName}</td><td>{confirmationPhone(order, modalOrders)}</td><td>{order.lines.map((line) => `${line.quantity}× ${line.name}`).join(", ")}</td><td>{order.paymentMethod}</td><td>{order.currentStatus || order.status}</td></tr>)}</tbody>
            </table>
            {!selectedCampaignOrders.length && <p>No orders are currently assigned to this campaign.</p>}
          </div>
        </div>
      </div>}
    </div>
  );

  const approvalsView = (
    <div className="confirmation-admin-grid">
      <article className="panel confirmation-admin-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">EDIT APPROVALS</p>
            <h2>Pending field edits</h2>
          </div>
          <span className="count-badge">{data.pendingEditRequests.length} waiting</span>
        </div>
        {data.pendingEditRequests.length ? (
          <div className="confirmation-review-list">
            {data.pendingEditRequests.map((request) => (
              <div key={request.id} className="confirmation-review-row">
                <div>
                  <strong>{request.orderNumber} · {request.customerName}</strong>
                  <p>{request.fieldName.replaceAll("_", " ")} · {request.requestedByName || "Unknown agent"} · {age(request.createdAt)} ago</p>
                  <span>{request.oldValue || "Empty"} → {request.newValue}</span>
                </div>
                <div className="confirmation-review-actions">
                  <textarea value={reviewNotes[request.id] ?? ""} onChange={(event) => setReviewNotes((notes) => ({ ...notes, [request.id]: event.target.value }))} placeholder="Optional review note" />
                  <div className="row-actions">
                    <button className="small-button" onClick={() => onAdminAction("review-edit", { requestId: request.id, decision: "REJECT", reviewNote: reviewNotes[request.id] ?? "" }, "Edit request rejected")}>Reject</button>
                    <button className="primary-button small" onClick={() => onAdminAction("review-edit", { requestId: request.id, decision: "APPROVE", reviewNote: reviewNotes[request.id] ?? "" }, "Edit request approved")}>Approve</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No pending edits" detail="Confirmation agents do not currently have any name, phone, or address changes waiting for approval." />
        )}
      </article>
      <article className="panel confirmation-admin-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">CANCELLATION APPROVALS</p>
            <h2>Pending cancellation requests</h2>
          </div>
          <span className="count-badge">{cancellationRequests.length} waiting</span>
        </div>
        {cancellationRequests.length ? (
          <div className="confirmation-review-list">
            {cancellationRequests.map((order) => {
              const latestAttempt = order.confirmationAttempts[order.confirmationAttempts.length - 1];
              const reviewKey = `cancel:${order.id}`;
              return (
                <div key={order.id} className="confirmation-review-row">
                  <div>
                    <strong>{order.orderNumber} · {order.customerName}</strong>
                    <p>{order.assignedCampaign?.assignedAgentName || "Unassigned"} · {latestAttempt?.rejectionReason ? latestAttempt.rejectionReason.replaceAll("_", " ") : "No reason captured"}</p>
                    <span>{order.cancellationReason || latestAttempt?.note || "No cancellation note captured"}</span>
                  </div>
                  <div className="confirmation-review-actions">
                    <textarea value={reviewNotes[reviewKey] ?? ""} onChange={(event) => setReviewNotes((notes) => ({ ...notes, [reviewKey]: event.target.value }))} placeholder="Approval note" />
                    <div className="row-actions">
                      <button className="small-button" onClick={() => reviewCancellation(order, "cancel-rejected")}>Keep active</button>
                      <button className="danger-button" onClick={() => reviewCancellation(order, "cancelled")}>Approve cancellation</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty title="No pending cancellations" detail="Cancellation requests from confirmation agents will land here for manager/admin review." />
        )}
      </article>
    </div>
  );

  return <div className="confirmation-layout">{reviewer && <div className="filter-row confirmation-tab-row"><div className="segmented confirmation-tabs"><button className={reviewTab === "queue" ? "active" : ""} onClick={() => setReviewTab("queue")}>Queue</button><button className={reviewTab === "campaigns" ? "active" : ""} onClick={() => setReviewTab("campaigns")}>Campaign Assignment</button><button className={reviewTab === "approvals" ? "active" : ""} onClick={() => setReviewTab("approvals")}>Approval Queue</button></div></div>}{!reviewer ? queueView : reviewTab === "queue" ? queueView : reviewTab === "campaigns" ? campaignsView : approvalsView}{expandedOrder && <ConfirmationAttemptsDialog order={expandedOrder} draft={attemptDraft(expandedOrder.id)} snapshotTime={snapshotTime} reviewer={reviewer} overrideReason={overrideReasons[expandedOrder.id] ?? ""} setOverrideReason={(value) => setOverrideReasons((current) => ({ ...current, [expandedOrder.id]: value }))} setDraft={(nextDraft) => setAttemptDrafts((drafts) => ({ ...drafts, [expandedOrder.id]: nextDraft }))} nextAttemptNumber={nextAttemptNumber} canLogAttempt={canLogAttempt} onAdminAction={onAdminAction} onSubmitOutcome={submitOutcome} onClose={() => setExpandedOrderId(null)} />}{quickAction && quickOrder && <ConfirmationQuickActionDialog action={quickAction.type} order={quickOrder} quickActionNote={quickActionNote} quickActionReason={quickActionReason} setQuickActionNote={setQuickActionNote} setQuickActionReason={setQuickActionReason} editDrafts={editDrafts} draftKey={draftKey} pendingRequest={pendingRequest} setEditDrafts={setEditDrafts} onSubmitEditRequest={submitEditRequest} onSubmitApproved={submitQuickApproved} onSubmitRejection={submitQuickRejection} onClose={closeQuickAction} reviewer={reviewer} />}</div>;
}

function ConfirmationAttemptsDialog({ order, draft, snapshotTime, reviewer, overrideReason, setOverrideReason, setDraft, nextAttemptNumber, canLogAttempt, onAdminAction, onSubmitOutcome, onClose }: { order: OrderView; draft: { note: string; callbackAt: string; callPicked: "yes" | "no"; rejectionReason: string }; snapshotTime: number; reviewer: boolean; overrideReason: string; setOverrideReason: (value: string) => void; setDraft: (draft: { note: string; callbackAt: string; callPicked: "yes" | "no"; rejectionReason: string }) => void; nextAttemptNumber: (order: OrderView) => number; canLogAttempt: (order: OrderView) => boolean; onAdminAction: (action: string, payload: Record<string, unknown>, success?: string) => Promise<void>; onSubmitOutcome: (order: OrderView, outcome: string, success: string) => Promise<void>; onClose: () => void }) {
  const latestAttempt = order.confirmationAttempts[order.confirmationAttempts.length - 1];
  const cancellationRequested = order.confirmationStatus === "cancel-requested";
  const coolingUntil = latestAttempt?.nextActionAt ? new Date(latestAttempt.nextActionAt) : null;
  const recallBlocked = Boolean(coolingUntil && coolingUntil.getTime() > snapshotTime && canLogAttempt(order));
  const cooldownCopy = coolingUntil ? `Next call available at ${coolingUntil.toLocaleString("en-IN")}` : "Cooldown active";
  const actionLocked = recallBlocked && !reviewer && !cancellationRequested;

  return <div className="confirmation-dialog-backdrop" role="presentation" onClick={onClose}><div className="confirmation-dialog confirmation-attempts-dialog" role="dialog" aria-modal="true" aria-label={`Call log for ${order.orderNumber}`} onClick={(event) => event.stopPropagation()}><button className="confirmation-dialog-close" onClick={onClose} aria-label="Close dialog">×</button><div className="confirmation-dialog-head"><p className="eyebrow">CALL LOG</p><h2>{order.orderNumber}</h2><span>{order.lines.map((line) => `${line.quantity}x ${line.name}`).join(", ")}</span></div><div className="confirmation-attempts-grid"><section className="confirmation-history"><div className="confirmation-section-head"><strong>Attempt history</strong><span>{order.customerName} · {order.customerPhone || "No phone saved"}</span></div>{order.confirmationAttempts.length ? order.confirmationAttempts.map((attempt) => <div className="confirmation-history-row" key={attempt.id}><span className={`mini-status ${toneForAttempt(attempt.outcome)}`}>Recall {attempt.attemptNumber}</span><div><strong>{prettyOutcome(attempt.outcome)}</strong><p>{attempt.note || "No note captured"}</p></div><div><strong>{attempt.callPicked ? "Answered" : "Not answered"}</strong><p>{attempt.rejectionReason ? attempt.rejectionReason.replaceAll("_", " ") : (attempt.nextActionAt ? `Next action ${shortDate(attempt.nextActionAt)} ${new Date(attempt.nextActionAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}` : "No recall scheduled")}</p></div></div>) : <p className="muted">No recalls logged yet for this order.</p>}</section><section className="confirmation-composer"><div className="confirmation-section-head"><strong>{cancellationRequested ? "Awaiting approval" : canLogAttempt(order) ? `Recall ${nextAttemptNumber(order)} action` : "Recall limit reached"}</strong><span>{order.lines.map((line) => line.sku).join(", ")}</span></div>{canLogAttempt(order) || cancellationRequested ? <>{recallBlocked && !cancellationRequested && <div className="confirmation-cooldown-banner"><strong>{cooldownCopy}</strong>{reviewer && <div className="confirmation-override-inline"><input value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} placeholder="Override reason" /><button className="small-button" disabled={!overrideReason.trim()} onClick={() => void onAdminAction("override-cooldown", { orderId: order.id, reason: overrideReason }, "Cooldown override applied")}>Override now</button></div>}</div>}<label>Call note<textarea value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="Capture what the customer said on this recall." /></label><div className="confirmation-composer-grid"><label>Callback time<input type="datetime-local" value={draft.callbackAt} onChange={(event) => setDraft({ ...draft, callbackAt: event.target.value })} /></label><label>Call picked<select value={draft.callPicked} onChange={(event) => setDraft({ ...draft, callPicked: event.target.value as "yes" | "no" })}><option value="yes">Yes</option><option value="no">No</option></select></label></div><div className="task-actions"><button className="warning-button" disabled={actionLocked || !draft.note.trim()} onClick={() => void onSubmitOutcome(order, "callback", "Callback recorded")}>Callback</button><button className="info-button" disabled={actionLocked || !draft.note.trim()} onClick={() => void onSubmitOutcome(order, "unreachable", "Attempt recorded")}>No answer</button></div></> : <p className="muted">Recall 1, 2, and 3 are already used for this order. Review history above or wait for a manager decision.</p>}</section></div></div></div>;
}

function ConfirmationQuickActionDialog({ action, order, quickActionNote, quickActionReason, setQuickActionNote, setQuickActionReason, editDrafts, draftKey, pendingRequest, setEditDrafts, onSubmitEditRequest, onSubmitApproved, onSubmitRejection, onClose, reviewer }: { action: "approved" | "rejection" | "edit"; order: OrderView; quickActionNote: string; quickActionReason: ConfirmationRejectionReason | ""; setQuickActionNote: Dispatch<SetStateAction<string>>; setQuickActionReason: Dispatch<SetStateAction<ConfirmationRejectionReason | "">>; editDrafts: Record<string, string>; draftKey: (orderId: string, fieldName: string) => string; pendingRequest: (order: OrderView, fieldName: "customer_name" | "shipping_address" | "customer_phone") => OrderView["pendingEditRequests"][number] | null; setEditDrafts: Dispatch<SetStateAction<Record<string, string>>>; onSubmitEditRequest: (order: OrderView, fieldName: "customer_name" | "shipping_address" | "customer_phone") => Promise<void>; onSubmitApproved: (order: OrderView) => Promise<void>; onSubmitRejection: (order: OrderView) => Promise<void>; onClose: () => void; reviewer: boolean }) {
  const nameValue = editDrafts[draftKey(order.id, "customer_name")] ?? order.customerName;
  const phoneValue = editDrafts[draftKey(order.id, "customer_phone")] ?? (order.customerPhone ?? "");
  const addressValue = editDrafts[draftKey(order.id, "shipping_address")] ?? (order.customerAddress ?? "");

  return <div className="confirmation-dialog-backdrop" role="presentation" onClick={onClose}><div className={`confirmation-dialog ${action === "edit" ? "confirmation-edit-dialog" : ""}`} role="dialog" aria-modal="true" aria-label={action === "approved" ? "Approve order" : action === "rejection" ? "Reject order" : "Edit order details"} onClick={(event) => event.stopPropagation()}><button className="confirmation-dialog-close" onClick={onClose} aria-label="Close dialog">×</button>{action === "approved" && <><div className="confirmation-dialog-head"><p className="eyebrow">APPROVED</p><h2>{order.orderNumber}</h2><span>Confirm directly from the table. A note is still required for audit history.</span></div><label>Confirmation note<textarea value={quickActionNote} onChange={(event) => setQuickActionNote(event.target.value)} placeholder="Capture what the customer said." /></label><div className="confirmation-dialog-actions"><button className="secondary-button" onClick={onClose}>Close</button><button className="success-button" disabled={!quickActionNote.trim()} onClick={() => void onSubmitApproved(order)}>Submit confirmed</button></div></>}{action === "rejection" && <><div className="confirmation-dialog-head"><p className="eyebrow">REJECTION</p><h2>{order.orderNumber}</h2><span>{reviewer ? "Managers and admins cancel directly. Agents send the request to the Approval Queue." : "Submit a cancellation request with both the rejection reason and note."}</span></div><label>Rejection reason<select value={quickActionReason} onChange={(event) => setQuickActionReason(event.target.value as ConfirmationRejectionReason | "")}><option value="">Choose reason</option><option value="wrong_item">Wrong item</option><option value="changed_mind">Changed mind</option><option value="price_issue">Price issue</option><option value="duplicate_order">Duplicate order</option><option value="delivery_delay">Delivery delay</option><option value="ordered_by_mistake">Ordered by mistake</option><option value="unreachable">Unreachable</option><option value="other">Other</option></select></label><label>Cancellation note<textarea value={quickActionNote} onChange={(event) => setQuickActionNote(event.target.value)} placeholder="Explain why this order should be cancelled." /></label><div className="confirmation-dialog-actions"><button className="secondary-button" onClick={onClose}>Close</button><button className="danger-button" disabled={!quickActionReason || !quickActionNote.trim()} onClick={() => void onSubmitRejection(order)}>{reviewer ? "Cancel order" : "Send for approval"}</button></div></>}{action === "edit" && <><div className="confirmation-dialog-head"><p className="eyebrow">EDIT REQUESTS</p><h2>{order.orderNumber}</h2><span>Request name, phone, or address changes without changing the existing approval and Shopify write-back flow.</span></div><div className="confirmation-edit-dialog-grid"><ConfirmationEditField label="Customer name" value={nameValue} originalValue={order.customerName} pendingRequest={pendingRequest(order, "customer_name")} onChange={(value) => setEditDrafts((drafts) => ({ ...drafts, [draftKey(order.id, "customer_name")]: value }))} onSubmit={() => void onSubmitEditRequest(order, "customer_name")} /><ConfirmationEditField label="Phone number" value={phoneValue} originalValue={order.customerPhone ?? ""} pendingRequest={pendingRequest(order, "customer_phone")} onChange={(value) => setEditDrafts((drafts) => ({ ...drafts, [draftKey(order.id, "customer_phone")]: value }))} onSubmit={() => void onSubmitEditRequest(order, "customer_phone")} /><ConfirmationEditField label="Address" value={addressValue} originalValue={order.customerAddress ?? ""} pendingRequest={pendingRequest(order, "shipping_address")} onChange={(value) => setEditDrafts((drafts) => ({ ...drafts, [draftKey(order.id, "shipping_address")]: value }))} onSubmit={() => void onSubmitEditRequest(order, "shipping_address")} multiline /></div><div className="confirmation-dialog-actions"><button className="secondary-button" onClick={onClose}>Close</button></div></>}</div></div>;
}

function ConfirmationEditField({ label, value, originalValue, pendingRequest, onChange, onSubmit, multiline = false }: { label: string; value: string; originalValue: string; pendingRequest: OrderView["pendingEditRequests"][number] | null; onChange: (value: string) => void; onSubmit: () => void; multiline?: boolean }) {
  const changed = value.trim().length > 0 && value.trim() !== originalValue.trim();
  return <label className="confirmation-edit-field">{label}{multiline ? <textarea value={value} onChange={(event) => onChange(event.target.value)} disabled={Boolean(pendingRequest)} /> : <input value={value} onChange={(event) => onChange(event.target.value)} disabled={Boolean(pendingRequest)} />}{pendingRequest ? <span className="pending-badge">Pending approval</span> : <button className="small-button" disabled={!changed} onClick={onSubmit}>Request change</button>}</label>;
}

function SortableCampaignCard({ campaign, assignedOrders, onOpen }: { campaign: DashboardSnapshot["campaigns"][number]; assignedOrders: OrderView[]; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: campaign.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.88 : 1,
  };
  const tone = campaign.position === 0 ? "danger" : campaign.position < 3 ? "warning" : "success";

  return <article ref={setNodeRef} style={style} className="confirmation-campaign-card" onClick={onOpen}>
    <GripVertical className="confirmation-campaign-grip" size={20} aria-label="Drag campaign" onClick={(event) => event.stopPropagation()} {...attributes} {...listeners} />
    <h3>{campaign.name}</h3>
    <span className={`status-pill ${tone}`}>Priority #{campaign.position + 1}</span>
    <strong className="confirmation-campaign-order-count">{assignedOrders.length} orders</strong>
    <span className="confirmation-campaign-agent"><Users size={16} />{campaign.assignedAgentName || "Unassigned"}</span>
    <button className="confirmation-campaign-more" type="button" aria-label={`Open ${campaign.name}`} onClick={(event) => { event.stopPropagation(); onOpen(); }}><MoreHorizontal size={19} /></button>
  </article>;
}

function ToggleSwitchField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <div className="create-campaign-field create-campaign-toggle-field">
    <span>{label}</span>
    <button type="button" role="switch" aria-label={label} aria-checked={checked} className={checked ? "active" : ""} onClick={() => onChange(!checked)}>
      <i />
    </button>
  </div>;
}

function MultiSelectField({ title, placeholder, options, selected, onChange }: { title: string; placeholder: string; options: string[]; selected: string[]; onChange: (values: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const filteredOptions = options.filter((option) => option.toLowerCase().includes(search.trim().toLowerCase()));

  useEffect(() => {
    function handleDocumentClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("click", handleDocumentClick);
    return () => document.removeEventListener("click", handleDocumentClick);
  }, []);

  function toggleValue(value: string) {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return <div className="create-campaign-field create-campaign-multi-select" ref={rootRef} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <span>{title}</span>
    <button className={open ? "create-campaign-select-trigger active" : "create-campaign-select-trigger"} type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <span>{selected.length ? `${selected.length} selected` : placeholder}</span>
      <b>⌄</b>
    </button>
    <div className="create-campaign-chip-list">
      {selected.length ? selected.map((value) => <button key={value} type="button" onClick={(event) => { event.preventDefault(); onChange(selected.filter((item) => item !== value)); }}>{value}<b>×</b></button>) : <small>No {title.toLowerCase()} selected</small>}
    </div>
    {open && <div className="create-campaign-select-menu" role="listbox" aria-label={title}>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${title.toLowerCase()}`} autoFocus />
      <div className="create-campaign-select-options">
        {filteredOptions.map((option) => <label key={option}>
          <input type="checkbox" checked={selected.includes(option)} onChange={() => toggleValue(option)} />
          <span>{option}</span>
        </label>)}
        {!filteredOptions.length && <p>No options found</p>}
      </div>
    </div>}
  </div>;
}

function toneForAttempt(outcome: string) {
  if (outcome === "confirmed") return "confirmed";
  if (outcome === "callback") return "callback";
  if (outcome === "unreachable") return "unreachable";
  if (outcome === "cancel-requested" || outcome === "cancelled") return "cancelled";
  return "used";
}

function prettyOutcome(value: string) {
  if (value === "cancel-requested") return "Cancellation requested";
  if (value === "cancel-rejected") return "Cancellation rejected";
  return value.replaceAll("-", " ");
}

function confirmationPhone(order: OrderView, orders: OrderView[]) {
  const isUsable = (value: string | null) => Boolean(value && !/[x•*]/i.test(value));
  if (isUsable(order.customerPhone)) return order.customerPhone as string;
  const orderNumber = order.orderNumber.replace(/^#/, "").toUpperCase();
  const matchingOrder = orders.find((candidate) => candidate.id !== order.id && candidate.orderNumber.replace(/^#/, "").toUpperCase() === orderNumber && isUsable(candidate.customerPhone));
  return matchingOrder?.customerPhone || "Phone unavailable in synced data";
}

function Fulfillment({ data, orders, role, onAction, onUpload, onPackaging, onIntegrationSync, loadMoreError, onLoadMore: loadQueuePage }: { data: DashboardSnapshot; orders: OrderView[]; role: DashboardSnapshot["currentUser"]["role"]; onAction: (id: string, action: string, payload?: Record<string, unknown>, success?: string) => Promise<void>; onUpload: (id: string, file: File) => Promise<void>; onPackaging: (id: string, lines: Array<{ componentId: string; quantity: number }>) => Promise<void>; onIntegrationSync: (success?: string) => Promise<void>; loadMoreError: string; onLoadMore: (queue: FulfillmentQueueKey, offset: number, sort: FulfillmentSortKey) => Promise<FulfillmentQueuePage | null> }) {
  const canOperate = ["ADMIN", "MANAGER", "OPERATIONS"].includes(role);
  const canHandoff = ["ADMIN", "MANAGER", "WAREHOUSE"].includes(role);
  const boxes = data.inventory.filter((item) => item.componentType === "COURIER_BOX");
  const boxesConfigured = boxes.length > 0;
  const boxRulesConfigured = data.packagingProfiles.some((profile) => profile.boxes.length > 0);
  const [activeQueue, setActiveQueue] = useState<FulfillmentQueueKey>("new-orders");
  const [queuePages, setQueuePages] = useState<Record<FulfillmentQueueKey, { initialized: boolean; nextOffset: number; hasMore: boolean }>>({
    "new-orders": { initialized: false, nextOffset: 0, hasMore: true },
    "labels-generated": { initialized: false, nextOffset: 0, hasMore: true },
    shipped: { initialized: false, nextOffset: 0, hasMore: true },
    "confirmed-orders": { initialized: false, nextOffset: 0, hasMore: true },
    all: { initialized: false, nextOffset: 0, hasMore: true },
  });
  const [queueLoading, setQueueLoading] = useState<Record<FulfillmentQueueKey, boolean>>({ "new-orders": false, "labels-generated": false, shipped: false, "confirmed-orders": false, all: false });
  const [fulfillmentSort, setFulfillmentSort] = useState<FulfillmentSortKey>("order-asc");
  const [selected, setSelected] = useState<string[]>([]);
  const [manifesting, setManifesting] = useState(false);
  const [queueSearch, setQueueSearch] = useState("");
  const [bulkStatus, setBulkStatus] = useState<{ kind: "copy" | "export"; message: string } | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterOrderIds, setFilterOrderIds] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterProducts, setFilterProducts] = useState<string[]>([]);
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [expandedPackagingOrderId, setExpandedPackagingOrderId] = useState<string | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const nextPageRef = useRef<HTMLTableRowElement | null>(null);
  const activePage = queuePages[activeQueue];
  const loadingMore = queueLoading[activeQueue];
  const requestNextPage = useCallback(async (queue = activeQueue) => {
    const current = queuePages[queue];
    if (queueLoading[queue] || (current.initialized && !current.hasMore)) return;
    setQueueLoading((loading) => ({ ...loading, [queue]: true }));
    try {
      const page = await loadQueuePage(queue, current.initialized ? current.nextOffset : 0, fulfillmentSort);
      if (!page) return;
      setQueuePages((pages) => ({ ...pages, [queue]: { initialized: true, nextOffset: page.nextOffset, hasMore: page.hasMore } }));
    } finally {
      setQueueLoading((loading) => ({ ...loading, [queue]: false }));
    }
  }, [activeQueue, fulfillmentSort, loadQueuePage, queueLoading, queuePages]);
  useEffect(() => {
    if (!bulkStatus) return;
    const timer = window.setTimeout(() => setBulkStatus(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [bulkStatus]);
  useEffect(() => {
    tableScrollRef.current?.scrollTo({ left: 0, behavior: "auto" });
  }, [activeQueue]);
  useEffect(() => {
    if (activePage.initialized || loadingMore) return;
    const timer = window.setTimeout(() => void requestNextPage(activeQueue), 0);
    return () => window.clearTimeout(timer);
  }, [activePage.initialized, activeQueue, loadingMore, requestNextPage]);
  useEffect(() => {
    if (!activePage.hasMore || loadingMore || !nextPageRef.current || !tableScrollRef.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void requestNextPage();
    }, { root: tableScrollRef.current, rootMargin: "320px 0px" });
    observer.observe(nextPageRef.current);
    return () => observer.disconnect();
  }, [activePage.hasMore, loadingMore, requestNextPage, orders.length]);

  const hasCourierPickup = (order: OrderView) => fulfillmentShipmentBucket(order) === "shipped";
  const hasGeneratedLabel = (order: OrderView) => fulfillmentShipmentBucket(order) === "labels-generated";
  const canManifestOrder = (order: OrderView) => !isCancelledOrder(order) && confirmationCleared(order) && !hasGeneratedLabel(order) && !hasCourierPickup(order);
  const sortFulfillmentOrders = (rows: OrderView[], queue: FulfillmentQueueKey) => [...rows].sort((left, right) => {
    if (fulfillmentSort !== "order-asc") return fulfillmentActivityMs(right, queue) - fulfillmentActivityMs(left, queue) || right.id.localeCompare(left.id);
    const leftNumber = left.orderNumber.replace(/^#/, "");
    const rightNumber = right.orderNumber.replace(/^#/, "");
    const prefixDelta = Number(!leftNumber.startsWith("SI")) - Number(!rightNumber.startsWith("SI"));
    return prefixDelta || leftNumber.localeCompare(rightNumber, undefined, { numeric: true, sensitivity: "base" }) || left.id.localeCompare(right.id);
  });
  const newOrders = sortFulfillmentOrders(orders.filter((order) => !isCancelledOrder(order) && !order.confirmationSelected && fulfillmentShipmentBucket(order) === "new-orders"), "new-orders");
  const labelsGenerated = sortFulfillmentOrders(orders.filter((order) => !isCancelledOrder(order) && !hasCourierPickup(order) && hasGeneratedLabel(order)), "labels-generated");
  const shipped = sortFulfillmentOrders(orders.filter((order) => !isCancelledOrder(order) && hasCourierPickup(order)), "shipped");
  const confirmedOrders = sortFulfillmentOrders(orders.filter((order) => !isCancelledOrder(order) && order.confirmationStatus === "confirmed" && !hasGeneratedLabel(order) && !hasCourierPickup(order)), "confirmed-orders");
  const bulkManifestEnabled = canOperate && (activeQueue === "new-orders" || activeQueue === "confirmed-orders");
  const queueMap = {
    "new-orders": newOrders,
    "labels-generated": labelsGenerated,
    shipped,
    "confirmed-orders": confirmedOrders,
    all: sortFulfillmentOrders(orders, "all"),
  } as const;
  const queueMeta = {
    "new-orders": {
      title: "New orders",
      detail: "Orders received but not processed and not sent to the confirmation team. Cancelled orders are excluded.",
      badge: "Not processed",
    },
    "labels-generated": {
      title: "Labels generated",
      detail: "Orders processed with a label or AWB, but not yet picked up by the courier partner.",
      badge: "Awaiting courier pickup",
    },
    shipped: {
      title: "Shipped orders",
      detail: "Orders picked up by the courier partner and now moving through delivery or return tracking.",
      badge: "Courier picked up",
    },
    "confirmed-orders": {
      title: "Confirmed orders",
      detail: "Orders confirmed by the customer and awaiting label generation or courier processing.",
      badge: "Customer confirmed",
    },
    all: {
      title: "All fulfillment orders",
      detail: "Every locally stored order, including confirmation, processing, shipment, cancellation, and return stages.",
      badge: "Complete local order view",
    },
  } as const;
  const queueTotals = {
    "new-orders": data.fulfillmentCounts.newOrders,
    "labels-generated": data.fulfillmentCounts.labelsGenerated,
    shipped: data.fulfillmentCounts.shipped,
    "confirmed-orders": data.fulfillmentCounts.confirmedOrders,
    all: data.fulfillmentCounts.total,
  } as const;
  const activeQueueTotal = queueTotals[activeQueue];
  const hasMore = activePage.hasMore;
  const onLoadMore = () => { void requestNextPage(); };
  const openQueue = (queue: FulfillmentQueueKey) => {
    setActiveQueue(queue);
    setSelected([]);
    if (!queuePages[queue].initialized && !queueLoading[queue]) void requestNextPage(queue);
  };
  const fulfillmentProductOptions = [...new Set(orders.flatMap((order) => order.lines.map((line) => line.name)).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const fulfillmentTagOptions = [...new Set(orders.flatMap((order) => order.shopifyTags).map((tag) => tag.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const parsedFilterOrderIds = filterOrderIds ? filterOrderIds.split(",") : [];
  const filterOrderIdsInvalid = Boolean(filterOrderIds && (!/^[A-Za-z0-9-]+(?:,[A-Za-z0-9-]+)*$/.test(filterOrderIds) || filterOrderIds.includes("#") || filterOrderIds.includes(" ")));
  const normalizedFilterOrderIds = parsedFilterOrderIds.map((value) => value.toUpperCase());
  const activeFilterCount = Number(Boolean(filterOrderIds)) + Number(Boolean(filterDateFrom || filterDateTo)) + Number(filterProducts.length > 0) + Number(filterTags.length > 0);
  const visible = queueMap[activeQueue].filter((order) => {
    if (!orderMatchesSearch(order, queueSearch)) return false;
    if (!filterOrderIdsInvalid && normalizedFilterOrderIds.length && !normalizedFilterOrderIds.includes(order.orderNumber.replace(/^#/, "").toUpperCase())) return false;
    const createdAt = new Date(order.createdAt).getTime();
    if (filterDateFrom && createdAt < new Date(`${filterDateFrom}T00:00:00`).getTime()) return false;
    if (filterDateTo && createdAt > new Date(`${filterDateTo}T23:59:59.999`).getTime()) return false;
    if (filterProducts.length && !order.lines.some((line) => filterProducts.includes(line.name))) return false;
    if (filterTags.length && !filterTags.some((tag) => order.shopifyTags.includes(tag))) return false;
    return true;
  });
  const selectedVisible = selected.filter((id) => visible.some((order) => order.id === id));
  const bulkOrders = selectedVisible.length ? visible.filter((order) => selectedVisible.includes(order.id)) : visible;
  const toggle = (id: string) => setSelected((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);

  async function copyOrderNumbers() {
    const value = bulkOrders.map((order) => order.orderNumber.replace(/^#/, "")).join(",");
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setBulkStatus({ kind: "copy", message: `${bulkOrders.length} order IDs copied` });
  }

  function exportShipmentSheet() {
    const escapeCsv = (value: unknown) => {
      const raw = String(value ?? "");
      const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const rows = bulkOrders.map((order) => [
      order.orderNumber.replace(/^#/, ""), order.customerName, order.customerPhone || "", order.customerAddress || "",
      order.lines.map((line) => `${line.quantity}x ${line.name} (${line.sku})`).join(" | "), currency.format(order.amount / 100),
      orderStageLabel(order), currentStatusLabel(order), order.paymentMethod, order.awb || "", order.rtoRisk || "", campaignDate(order.createdAt),
    ]);
    const csv = [["Order ID", "Customer", "Phone", "Address", "Items", "Total", "Order stage", "Shipping status", "Payment", "AWB", "RTO risk", "Order date"], ...rows]
      .map((row) => row.map(escapeCsv).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `satmi-${activeQueue}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setBulkStatus({ kind: "export", message: `${bulkOrders.length} rows exported` });
  }

  async function manifestSelected() {
    setManifesting(true);
    for (const id of selectedVisible) await onAction(id, "manifest", {}, "Order manifested in Shiprocket");
    setSelected((ids) => ids.filter((id) => !selectedVisible.includes(id)));
    setManifesting(false);
  }

  const canSyncIntegrations = ["ADMIN", "MANAGER"].includes(role);
  const integrationHealthy = data.integrations.length > 0 && data.integrations.every((integration) => integration.status === "connected");
  const integrationSyncing = data.integrations.some((integration) => integration.status === "syncing");
  const lastIntegrationSync = data.integrations.map((integration) => integration.lastSyncedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  const orderFeedStale = data.orderFreshness.ageHours !== null && data.orderFreshness.ageHours >= 24;
  const orderFeedLabel = data.orderFreshness.latestOrderAt
    ? `Latest local order ${age(data.orderFreshness.latestOrderAt)} ago`
    : "No local orders received yet";

  return <div className="fulfillment-layout fulfillment-workbench">
    <div className="fulfillment-filter-row">
    <div className="fulfillment-filter-tabs" role="tablist" aria-label="Fulfillment queues">
      <button role="tab" aria-selected={activeQueue === "new-orders"} className={activeQueue === "new-orders" ? "active" : ""} onClick={() => openQueue("new-orders")}><span>New orders</span><b>{data.fulfillmentCounts.newOrders}</b></button>
      <button role="tab" aria-selected={activeQueue === "labels-generated"} className={activeQueue === "labels-generated" ? "active" : ""} onClick={() => openQueue("labels-generated")}><span>Labels Generated</span><b>{data.fulfillmentCounts.labelsGenerated}</b></button>
      <button role="tab" aria-selected={activeQueue === "shipped"} className={activeQueue === "shipped" ? "active" : ""} onClick={() => openQueue("shipped")}><span>Shipped</span><b>{data.fulfillmentCounts.shipped}</b></button>
      <button role="tab" aria-selected={activeQueue === "confirmed-orders"} className={activeQueue === "confirmed-orders" ? "active" : ""} onClick={() => openQueue("confirmed-orders")}><span>Confirmed orders</span><b>{data.fulfillmentCounts.confirmedOrders}</b></button>
      <button role="tab" aria-selected={activeQueue === "all"} className={activeQueue === "all" ? "active" : ""} onClick={() => openQueue("all")}><span>All</span><b>{data.fulfillmentCounts.total}</b></button>
    </div>
    <div className="fulfillment-filter-actions">
      <span className={orderFeedStale ? "fulfillment-sync-state warning" : integrationHealthy ? "fulfillment-sync-state healthy" : integrationSyncing ? "fulfillment-sync-state syncing" : "fulfillment-sync-state warning"} title={`${orderFeedLabel}\n${data.integrations.map((item) => `${item.provider}: ${item.detail || item.status}`).join("\n")} `}><i />{orderFeedStale ? orderFeedLabel : integrationSyncing ? "Syncing providers…" : integrationHealthy ? `Synced${lastIntegrationSync ? ` ${age(lastIntegrationSync)} ago` : ""}` : "Sync needs review"}</span>
      {canSyncIntegrations && <button className="fulfillment-sync-button" type="button" title="Sync Shopify and Shiprocket" aria-label="Sync Shopify and Shiprocket" onClick={() => void onIntegrationSync("Integration sync started in the background")}><RefreshCw size={17} /></button>}
      <button className={filterOpen ? "fulfillment-filter-button active" : "fulfillment-filter-button"} type="button" aria-expanded={filterOpen} aria-controls="fulfillment-advanced-filters" onClick={() => setFilterOpen((current) => !current)}><Funnel size={17} /><span>Filters</span>{activeFilterCount > 0 && <b>{activeFilterCount}</b>}</button>
    </div>
    </div>

    {filterOpen && <section id="fulfillment-advanced-filters" className="fulfillment-advanced-filters">
      <label className="fulfillment-filter-field fulfillment-filter-order-ids"><span>Order IDs</span><input value={filterOrderIds} onChange={(event) => setFilterOrderIds(event.target.value.toUpperCase())} placeholder="SI0715676,SI0715677" /><small className={filterOrderIdsInvalid ? "error" : ""}>{filterOrderIdsInvalid ? "Use comma-separated IDs without spaces or # symbols." : "Enter any number of IDs separated by commas."}</small></label>
      <label className="fulfillment-filter-field"><span>From date</span><input type="date" value={filterDateFrom} onChange={(event) => setFilterDateFrom(event.target.value)} /></label>
      <label className="fulfillment-filter-field"><span>To date</span><input type="date" min={filterDateFrom || undefined} value={filterDateTo} onChange={(event) => setFilterDateTo(event.target.value)} /></label>
      <details className="fulfillment-filter-multi"><summary><span>Products</span><strong>{filterProducts.length ? `${filterProducts.length} selected` : "All products"}</strong></summary><div>{fulfillmentProductOptions.map((product) => <label key={product}><input type="checkbox" checked={filterProducts.includes(product)} onChange={() => setFilterProducts((current) => current.includes(product) ? current.filter((item) => item !== product) : [...current, product])} /><span>{product}</span></label>)}</div></details>
      <details className="fulfillment-filter-multi"><summary><span>Shopify tags</span><strong>{filterTags.length ? `${filterTags.length} selected` : "All tags"}</strong></summary><div>{fulfillmentTagOptions.map((tag) => <label key={tag}><input type="checkbox" checked={filterTags.includes(tag)} onChange={() => setFilterTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])} /><span>{tag}</span></label>)}</div></details>
      <button className="small-button fulfillment-clear-filters" disabled={!activeFilterCount} onClick={() => { setFilterOrderIds(""); setFilterDateFrom(""); setFilterDateTo(""); setFilterProducts([]); setFilterTags([]); }}>Clear filters</button>
    </section>}

    <div className="fulfillment-grid">
      <article className="panel queue-panel">
        <div className="panel-heading">
          <div>
            <h2>{queueMeta[activeQueue].title}</h2>
            <span className="panel-subtitle">{queueMeta[activeQueue].detail}</span>
          </div>
          <div className="row-actions">
            <div className="fulfillment-inline-search">
              <input value={queueSearch} onChange={(event) => setQueueSearch(event.target.value)} placeholder="Search order, customer, phone, AWB, SKU, or RTO tag" />
            </div>
            <label className="fulfillment-sort-control"><select aria-label="Order sort" disabled={Object.values(queueLoading).some(Boolean)} value={fulfillmentSort} onChange={(event) => {
              const nextSort = event.target.value as FulfillmentSortKey;
              setFulfillmentSort(nextSort);
              setQueuePages({ "new-orders": { initialized: false, nextOffset: 0, hasMore: true }, "labels-generated": { initialized: false, nextOffset: 0, hasMore: true }, shipped: { initialized: false, nextOffset: 0, hasMore: true }, "confirmed-orders": { initialized: false, nextOffset: 0, hasMore: true }, all: { initialized: false, nextOffset: 0, hasMore: true } });
              setSelected([]);
            }}><option value="order-asc">Order ID: ascending</option><option value="activity-desc">Latest activity first</option></select></label>
            <div className="fulfillment-action-popover-wrap"><button className="small-button fulfillment-bulk-button" disabled={!bulkOrders.length} onClick={() => void copyOrderNumbers()}><Clipboard size={15} /> Copy IDs</button>{bulkStatus?.kind === "copy" && <span className="fulfillment-action-popover" role="status">{bulkStatus.message}</span>}</div>
            <div className="fulfillment-action-popover-wrap"><button className="small-button fulfillment-bulk-button" disabled={!bulkOrders.length} onClick={exportShipmentSheet}><Download size={15} /> Export sheet</button>{bulkStatus?.kind === "export" && <span className="fulfillment-action-popover" role="status">{bulkStatus.message}</span>}</div>
            
          </div>
        </div>
        {!visible.length ? <div><Empty title={loadingMore ? "Loading this queue…" : "Queue is clear"} detail={loadingMore ? `Looking through older stored orders for ${queueMeta[activeQueue].title.toLowerCase()}.` : queueSearch.trim() || activeFilterCount ? "No loaded rows match the current search and filters." : activeQueueTotal > 0 ? `${activeQueueTotal} orders exist in this queue. Load older pages to display them.` : "No orders match this fulfillment view right now."} />{hasMore && !loadingMore && <div className="fulfillment-next-page"><button type="button" className="small-button" onClick={onLoadMore}>Load matching older orders</button></div>}</div> : <div ref={tableScrollRef} className="table-scroll fulfillment-table-scroll" onScroll={(event) => { const target = event.currentTarget; if (hasMore && !loadingMore && target.scrollHeight - target.scrollTop - target.clientHeight < 480) onLoadMore(); }}><table className="fulfillment-table"><thead><tr><th className="fulfillment-check-column fulfillment-sticky-check"><input type="checkbox" aria-label="Select all visible orders" checked={visible.length > 0 && selectedVisible.length === visible.length} onChange={(event) => setSelected(event.target.checked ? visible.map((order) => order.id) : [])} /></th><th className="fulfillment-sticky-order">Order</th><th className="fulfillment-sticky-customer">Customer</th><th>Order stage</th><th>Shipping status</th><th>Courier pickup SLA</th><th>RTO</th><th>Stock and packaging</th><th>Actions</th></tr></thead><tbody>{visible.map((order) => {
          const canFetchLabel = canOperate && Boolean(order.shipmentId || order.shiprocketOrderId) && !order.labelKey && !isCancelledOrder(order);
          const packagingDetail = packagingBlockerMessage(order, boxesConfigured, boxRulesConfigured);
          const pickupStatus = awaitingPickup(order)
            ? `${daysSince(order.manifestedAt)} since shipment creation`
            : order.pickedUpAt
              ? `Picked up ${daysSince(order.pickedUpAt)} ago`
              : "No pickup wait";
          const pickupDeadline = awaitingPickup(order)
            ? `Auto-cancel in ${daysUntil(order.autoCancelDeadline)}`
            : order.autoCancelDeadline
              ? `Courier SLA ${daysUntil(order.autoCancelDeadline)} left`
              : "No courier SLA";
          return <Fragment key={order.id}>
            <tr>
              <td className="fulfillment-check-column fulfillment-sticky-check"><input aria-label={`Select ${order.orderNumber}`} type="checkbox" checked={selected.includes(order.id)} onChange={() => toggle(order.id)} /></td>
              <td className="fulfillment-sticky-order">
                <div className="fulfillment-order-block">
                  <strong>{order.orderNumber}</strong>
                  <span>{currency.format(order.amount / 100)} · {activeQueue === "shipped" ? `Shipment updated ${age(order.latestShipmentEventAt || order.pickedUpAt || order.createdAt)} ago` : `${age(order.createdAt)} old`}</span>
                  <span>{order.lines.map((line) => `${line.quantity}x ${line.sku}`).join(", ")}</span>
                </div>
              </td>
              <td className="fulfillment-sticky-customer">
                <strong>{order.customerName}</strong>
                <span>{order.customerPhone || "Phone not available"}</span>
                <span>{order.customerAddress || "Address not available"}</span>
              </td>
              <td>
                <div className="shipment-detail">
                  <strong>{orderStageLabel(order)}</strong>
                  <span>{queueMeta[activeQueue].badge}</span>
                  <span>{orderStageDetail(order)}</span>
                </div>
              </td>
              <td>
                <div className="shipment-detail">
                  <strong>{currentStatusLabel(order)}</strong>
                  <span>{order.awb ? `AWB ${order.awb}` : order.shiprocketOrderId ? "Matched in Shiprocket" : "Not yet matched in Shiprocket"}</span>
                  <span>{order.labelKey ? "Label PDF saved" : order.awb || order.currentStatus === "LABEL_PRINTED" ? "Label generated by Shiprocket" : order.shipmentId || order.shiprocketOrderId ? "Label not generated yet" : "Shipment not created yet"}</span>
                </div>
              </td>
              <td>
                <div className="shipment-detail">
                  <strong>{pickupStatus}</strong>
                  <span>{pickupDeadline}</span>
                  <span>{order.courierAutoCancelDays ? `${order.courierAutoCancelDays} day courier pickup window` : "Courier pickup SLA unavailable"}</span>
                </div>
              </td>
              <td>
                <div className="shipment-detail">
                  <strong>{rtoLabel(order)}</strong>
                  <span>{order.rtoRisk === "UNTAGGED" || !order.rtoRisk ? "No Shopify tag yet" : `Shopify tag: ${prettyStatus(order.rtoRisk)}`}</span>
                </div>
              </td>
              <td>
                <div className="shipment-detail">
                  <strong>{order.requirementStatus === "complete" ? "Stock and packaging ready" : order.requirementStatus === "missing" || !order.requirementStatus ? "Recipe setup missing" : order.requirementStatus === "packaging-required" ? "Packaging choice needed" : order.shortageSummary || "Stock issue"}</strong>
                  <span>{packagingDetail}</span>
                  <span>{order.shortageSummary || `${order.requirements.length} requirement lines tracked`}</span>
                </div>
              </td>
              <td>
                <div className="fulfillment-action-cell">
                  <div className="fulfillment-status-stack">
                    <StatusPill order={order}/>
                    {order.cancelledAt && <span className="fulfillment-inline-note">{shortDate(order.cancelledAt)} · {order.cancelledBy || "System"}</span>}
                  </div>
                  <div className="row-actions fulfillment-actions">
                    
                    {canOperate && !order.shiprocketOrderId && !isCancelledOrder(order) && <button className="small-button" onClick={() => onAction(order.id, "sync-shiprocket", {}, "Shiprocket record matched")}>Match in Shiprocket</button>}
                    {canFetchLabel && <button className="primary-button small" onClick={() => onAction(order.id, "fetch-label", {}, "Label fetched from Shiprocket")}>Get label</button>}
                    {!order.labelKey && canOperate && <label className="upload-button subtle-upload">Upload fallback<input type="file" accept="application/pdf" onChange={(event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) onUpload(order.id, file); }}/></label>}
                    {order.labelKey && <a className="small-button" href={`/api/labels/${order.id}`}>Download label</a>}
                    {order.labelKey && !order.warehouseAcknowledged && canHandoff && <button className="success-button small" onClick={() => onAction(order.id, "warehouse-ack", {}, "Warehouse handoff acknowledged")}>Mark handed to warehouse</button>}
                    {canOperate && ["complete", "packaging-required"].includes(order.requirementStatus || "") && <button className="small-button" aria-expanded={expandedPackagingOrderId === order.id} onClick={() => setExpandedPackagingOrderId((current) => current === order.id ? null : order.id)}>{expandedPackagingOrderId === order.id ? "Close packaging" : "Packaging"}</button>}
                  </div>
                </div>
              </td>
            </tr>
            {canOperate && expandedPackagingOrderId === order.id && ["complete", "packaging-required"].includes(order.requirementStatus || "") && (
              <tr className="fulfillment-detail-row">
                <td colSpan={9}>
                  <PackagingPlanEditor order={order} boxes={boxes} boxesConfigured={boxesConfigured} boxRulesConfigured={boxRulesConfigured} onConfirm={onPackaging}/>
                </td>
              </tr>
            )}
          </Fragment>;
        })}{hasMore && <tr ref={nextPageRef}><td colSpan={9} className="fulfillment-next-page"><button type="button" className="small-button" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "Loading more orders…" : "Load more orders"}</button>{loadMoreError && <span role="alert">{loadMoreError}</span>}</td></tr>}{!hasMore && orders.length > 0 && <tr><td colSpan={9} className="fulfillment-next-page">All {activeQueueTotal} orders in this queue are loaded.</td></tr>}</tbody></table></div>}
      </article>
    </div>
  </div>;
}

function PackagingPlanEditor({ order, boxes, boxesConfigured, boxRulesConfigured, onConfirm }: { order: OrderView; boxes: DashboardSnapshot["inventory"]; boxesConfigured: boolean; boxRulesConfigured: boolean; onConfirm: (id: string, lines: Array<{ componentId: string; quantity: number }>) => Promise<void> }) {
  const current = order.requirements.filter((requirement) => requirement.source === "COURIER_BOX");
  const [open, setOpen] = useState(order.requirementStatus === "packaging-required");
  const [lines, setLines] = useState(current.length ? current.map((requirement) => ({ componentId: requirement.componentId, quantity: requirement.requiredQuantity })) : [{ componentId: boxes[0]?.id ?? "", quantity: 1 }]);
  if (!boxesConfigured || !boxRulesConfigured) return <div className="packaging-inline compact packaging-blocked"><div><strong>Packaging cannot be selected yet</strong><span>{packagingBlockerMessage(order, boxesConfigured, boxRulesConfigured)}</span></div></div>;
  if (!open) return <div className="packaging-inline compact"><div><strong>{order.packagingPlanStatus === "manual" ? "Manual packaging confirmed" : "Automatic packaging suggestion"}</strong><span>{current.map((requirement) => `${requirement.requiredQuantity}× ${requirement.name}`).join(", ") || "No courier box selected"}</span></div><button className="small-button" onClick={() => setOpen(true)}>Override boxes</button></div>;
  return <div className="packaging-inline"><div><strong>{order.requirementStatus === "packaging-required" ? "Packaging decision required" : "Audited packaging override"}</strong><span>{order.requirementStatus === "packaging-required" ? "Mixed or unusual order · choose actual courier boxes" : `Current: ${current.map((requirement) => `${requirement.requiredQuantity}× ${requirement.name}`).join(", ")}`}</span></div>{lines.map((line, index) => <div className="packaging-choice" key={index}><select aria-label={`Courier box ${index + 1}`} value={line.componentId} onChange={(event) => setLines(lines.map((item, i) => i === index ? { ...item, componentId: event.target.value } : item))}><option value="">Choose courier box</option>{boxes.map((box) => <option value={box.id} key={box.id}>{box.name} · {box.available} available</option>)}</select><input aria-label={`Box quantity ${index + 1}`} type="number" min={1} value={line.quantity} onChange={(event) => setLines(lines.map((item, i) => i === index ? { ...item, quantity: Number(event.target.value) } : item))}/></div>)}<div className="row-actions"><button className="small-button" onClick={() => setLines([...lines, { componentId: boxes[0]?.id ?? "", quantity: 1 }])}>+ Another box</button>{order.requirementStatus !== "packaging-required" && <button className="small-button" onClick={() => setOpen(false)}>Cancel</button>}<button className="primary-button" onClick={() => onConfirm(order.id, lines)}>Confirm packaging</button></div></div>;
}

function Inventory({ data, role, onAdjust, onImport, onBulkSet }: { data: DashboardSnapshot; role: DashboardSnapshot["currentUser"]["role"]; onAdjust: (id: string, qty: number, reason: string) => Promise<void>; onImport: (file: File) => Promise<void>; onBulkSet: (items: Array<{ componentId: string; onHand: number }>) => Promise<void> }) {
  const [selected, setSelected] = useState(data.inventory[0]?.id ?? ""); const [quantity, setQuantity] = useState(0); const [reason, setReason] = useState("Cycle count correction");
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditResult, setAuditResult] = useState<{ isHealthy: boolean; summary: string; discrepancyCount: number } | null>(null);
  const [bulkIds, setBulkIds] = useState<string[]>([]);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkValues, setBulkValues] = useState<Record<string, number>>({});
  const totalOnHand = data.inventory.reduce((sum, item) => sum + item.onHand, 0); const totalAvailable = data.inventory.reduce((sum, item) => sum + item.available, 0);
  const canAdjust = ["ADMIN", "MANAGER", "WAREHOUSE"].includes(role);
  const allBulkSelected = data.inventory.length > 0 && data.inventory.every((item) => bulkIds.includes(item.id));
  const toggleBulk = (componentId: string) => setBulkIds((current) => current.includes(componentId) ? current.filter((id) => id !== componentId) : [...current, componentId]);
  const beginBulkEdit = () => {
    if (!bulkIds.length) return;
    setBulkValues(Object.fromEntries(data.inventory.filter((item) => bulkIds.includes(item.id)).map((item) => [item.id, item.onHand])));
    setBulkMode(true);
  };
  const saveBulkEdit = async () => {
    await onBulkSet(bulkIds.map((componentId) => ({ componentId, onHand: Number(bulkValues[componentId] ?? 0) })));
    setBulkMode(false); setBulkIds([]); setBulkValues({});
  };

  const runConsistencyCheck = async () => {
    setAuditLoading(true);
    try {
      const res = await fetch("/api/inventory/consistency");
      const json = await res.json() as { isHealthy: boolean; summary: string; discrepancyCount: number };
      setAuditResult(json);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Consistency check failed");
    } finally {
      setAuditLoading(false);
    }
  };

  return <><section className="inventory-summary"><div><span>On hand</span><strong>{totalOnHand}</strong><p>Physical component units</p></div><div><span>Allocated</span><strong>{data.inventory.reduce((sum, item) => sum + item.allocated, 0)}</strong><p>Reserved across orders</p></div><div><span>Available</span><strong>{totalAvailable}</strong><p>Unreserved components</p></div><div className="rto"><span>Incoming recoverable</span><strong>+{data.inventory.reduce((sum, item) => sum + item.incomingRto, 0)}</strong><p>Potential · pending QC</p></div></section>
  {auditResult && (
    <div style={{ marginBottom: "16px", padding: "12px 16px", background: auditResult.isHealthy ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)", border: `1px solid ${auditResult.isHealthy ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`, borderRadius: "8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span><strong>Ledger Consistency Audit:</strong> {auditResult.summary}</span>
      <span className={`status-pill ${auditResult.isHealthy ? "green" : "red"}`}><i/>{auditResult.isHealthy ? "100% Consistent" : `${auditResult.discrepancyCount} Issues`}</span>
    </div>
  )}
  <div className="inventory-layout"><article className="panel table-panel"><div className="panel-heading"><div><p className="eyebrow">COMPONENT LEDGER</p><h2>Every physical item</h2></div><div className="heading-actions">{canAdjust && !bulkMode && <button className="small-button" disabled={!bulkIds.length} onClick={beginBulkEdit}>Bulk count{bulkIds.length ? ` (${bulkIds.length})` : ""}</button>}{bulkMode && <><button className="small-button" onClick={() => { setBulkMode(false); setBulkValues({}); }}>Cancel</button><button className="primary-button" onClick={() => void saveBulkEdit()}>Save bulk count</button></>}{["ADMIN", "MANAGER"].includes(role) && <button className="small-button" onClick={runConsistencyCheck} disabled={auditLoading}>{auditLoading ? "Auditing..." : "Audit Consistency"}</button>}{["ADMIN", "MANAGER"].includes(role) && <label className="upload-button">Reconcile component CSV<input type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); }}/></label>}<span className="date-pill">One warehouse</span></div></div>{bulkMode && <p className="inventory-bulk-note">Enter the counted quantity for selected components. Saving writes one auditable ledger adjustment per changed component.</p>}<div className="table-scroll"><table><thead><tr>{canAdjust && <th><input type="checkbox" aria-label="Select all components for bulk count" disabled={bulkMode} checked={allBulkSelected} onChange={(event) => setBulkIds(event.target.checked ? data.inventory.map((item) => item.id) : [])}/></th>}<th>Component</th><th>Type</th><th>On hand</th><th>Allocated</th><th>Available</th><th>RTO policy</th><th>Incoming</th></tr></thead><tbody>{data.inventory.map((item) => <tr key={item.id}>{canAdjust && <td><input type="checkbox" aria-label={`Select ${item.name} for bulk count`} disabled={bulkMode} checked={bulkIds.includes(item.id)} onChange={() => toggleBulk(item.id)}/></td>}<td><strong>{item.name}</strong><span>{item.sku}</span></td><td><span className="role-pill">{item.componentType.replaceAll("_", " ")}</span></td><td>{bulkMode && bulkIds.includes(item.id) ? <input className="inventory-bulk-input" aria-label={`Counted stock for ${item.name}`} type="number" min={0} step={1} value={bulkValues[item.id] ?? 0} onChange={(event) => setBulkValues((current) => ({ ...current, [item.id]: Number(event.target.value) }))}/> : <strong>{item.onHand}</strong>}</td><td>{item.allocated}</td><td><strong className={item.available < 0 ? "negative" : "positive"}>{item.available}</strong></td><td>{item.componentType === "COURIER_BOX" ? "Never returns" : item.rtoRecoverable ? "Recoverable" : "Consumed"}</td><td><span className="rto-value">+{item.incomingRto}</span></td></tr>)}</tbody></table>{data.inventory.length === 0 && <Empty title="No components configured" detail="Create physical components in Product setup, then upload the actual stock CSV."/>}</div></article>{canAdjust ? <form className="panel adjustment-card" onSubmit={(event: FormEvent) => { event.preventDefault(); onAdjust(selected, quantity, reason); setQuantity(0); }}><p className="eyebrow">AUDITED MOVEMENT</p><h2>Adjust component stock</h2><p>Every physical change is written to the immutable component ledger.</p><label>Component<select value={selected} onChange={(event) => setSelected(event.target.value)} required><option value="">Choose component</option>{data.inventory.map((item) => <option value={item.id} key={item.id}>{item.sku} · {item.name}</option>)}</select></label><label>Quantity change<input type="number" value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} required/><small>Use a negative value to remove stock.</small></label><label>Reason<input value={reason} onChange={(event) => setReason(event.target.value)} required/></label><button className="primary-button" disabled={!selected}>Post adjustment</button></form> : <aside className="panel adjustment-card"><p className="eyebrow">READ-ONLY ACCESS</p><h2>Component visibility</h2><p>Your role can inspect physical balances, allocations, shortages and recoverable RTO units.</p></aside>}</div></>;
}

function ShopifyProductSync({ onRequest }: { onRequest: (path: string, options: RequestInit, success: string) => Promise<void> }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ shopifyTotalVariants: number; shopifyActiveVariants: number; inserted: number; updated: number; localTotalProducts: number } | null>(null);

  const handleSync = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/catalog/products/import-shopify", { method: "POST" });
      const json = await res.json() as { error?: string; shopifyTotalVariants: number; shopifyActiveVariants: number; inserted: number; updated: number; localTotalProducts: number };
      if (!res.ok) throw new Error(json.error || "Failed to import Shopify products");
      setResult(json);
      await onRequest("/api/state", { method: "GET" }, "Shopify catalog imported successfully");
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel" style={{ marginBottom: "16px", padding: "16px", borderRadius: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <p className="eyebrow" style={{ color: "#3b82f6", fontWeight: "bold", margin: "0 0 4px" }}>SHOPIFY PRODUCT CATALOG</p>
          <h3 style={{ margin: "0 0 4px" }}>Direct Store Catalog Sync</h3>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted, #9ca3af)" }}>
            Pull all live products and variants from Shopify Admin API proactively into local products.
          </p>
        </div>
        <button className="primary-button" onClick={handleSync} disabled={loading} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {loading ? "Importing from Shopify..." : "Import Products from Shopify"}
        </button>
      </div>
      {result && (
        <div style={{ marginTop: "12px", padding: "10px 14px", background: "rgba(59, 130, 246, 0.1)", border: "1px solid rgba(59, 130, 246, 0.3)", borderRadius: "8px", fontSize: "13px" }}>
          <strong>Sync Result:</strong> {result.shopifyTotalVariants} Shopify variants found ({result.shopifyActiveVariants} active) · <strong>+{result.inserted} newly inserted</strong> · {result.updated} updated · <strong>{result.localTotalProducts} total in local catalog</strong>.
        </div>
      )}
    </div>
  );
}

function ProductCreator({ data, onRequest }: { data: DashboardSnapshot; onRequest: (path: string, options: RequestInit, success: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [variant, setVariant] = useState("Default");
  const [packagingProfileId, setProfileId] = useState(data.packagingProfiles[0]?.id ?? "");
  const recipeComponents = data.inventory.filter((component) => component.componentType !== "COURIER_BOX");
  const [items, setItems] = useState([{ componentId: recipeComponents[0]?.id ?? "", quantity: 1 }]);
  const [open, setOpen] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await onRequest("/api/catalog/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, sku, variant, packagingProfileId, items }),
    }, "Manual product & BOM recipe created");
    setName("");
    setSku("");
    setVariant("Default");
    setOpen(false);
  };

  if (!open) {
    return (
      <div style={{ marginBottom: "16px" }}>
        <button className="secondary-button" onClick={() => setOpen(true)}>
          + Create Custom / Manual Product
        </button>
      </div>
    );
  }

  return (
    <form className="panel setup-form" onSubmit={handleSubmit} style={{ marginBottom: "16px" }}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">CUSTOM / LOCAL CATALOG</p>
          <h2>Create manual sellable product</h2>
        </div>
        <button type="button" className="small-button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <div className="form-grid">
        <label>
          Product Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali Gift Hamper 2026" required />
        </label>
        <label>
          Sellable SKU
          <input value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} placeholder="e.g. BNDL-DIWALI-01" required />
        </label>
        <label>
          Variant
          <input value={variant} onChange={(e) => setVariant(e.target.value)} placeholder="Default" />
        </label>
        <label>
          Packaging Profile
          <select value={packagingProfileId} onChange={(e) => setProfileId(e.target.value)} required>
            <option value="">Choose profile</option>
            {data.packagingProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      <div className="recipe-lines" style={{ marginTop: "12px" }}>
        <div className="recipe-columns">
          <span>Component in Recipe</span>
          <span>Quantity</span>
        </div>
        {items.map((item, idx) => (
          <div className="recipe-line" key={idx}>
            <select value={item.componentId} onChange={(e) => setItems(items.map((it, i) => i === idx ? { ...it, componentId: e.target.value } : it))} required>
              <option value="">Choose component</option>
              {recipeComponents.map((c) => <option key={c.id} value={c.id}>{c.sku} · {c.name}</option>)}
            </select>
            <input type="number" min={1} value={item.quantity} onChange={(e) => setItems(items.map((it, i) => i === idx ? { ...it, quantity: Number(e.target.value) } : it))} />
            {items.length > 1 && <button type="button" className="danger-button" onClick={() => setItems(items.filter((_, i) => i !== idx))}>Remove</button>}
          </div>
        ))}
        <button type="button" className="small-button" onClick={() => setItems([...items, { componentId: recipeComponents[0]?.id ?? "", quantity: 1 }])}>+ Add Component to Recipe</button>
      </div>
      <div style={{ marginTop: "16px" }}>
        <button className="primary-button">Save Product & Recipe</button>
      </div>
    </form>
  );
}

function ProductSetup({ data, onRequest }: { data: DashboardSnapshot; onRequest: (path: string, options: RequestInit, success: string) => Promise<void> }) {
  const [productId, setProductId] = useState(data.products[0]?.id ?? "");
  return <div className="setup-stack"><ShopifyProductSync onRequest={onRequest}/><ProductCreator data={data} onRequest={onRequest}/><ComponentCreator onRequest={onRequest}/><ComponentManager data={data} onRequest={onRequest}/><PackagingRules data={data} onRequest={onRequest}/><article className="panel"><div className="panel-heading"><div><p className="eyebrow">VERSIONED BILL OF MATERIALS</p><h2>Sellable product recipes</h2></div><span className="count-badge">{data.products.filter((product) => product.recipeVersion).length}/{data.products.length} configured</span></div><label className="setup-select">Sellable SKU<select value={productId} onChange={(event) => setProductId(event.target.value)}><option value="">Choose product</option>{data.products.map((product) => <option value={product.id} key={product.id}>{product.sku} · {product.name} {product.isManual ? " [MANUAL]" : " [SHOPIFY]"}{product.recipeVersion ? ` · v${product.recipeVersion}` : " · missing recipe"}</option>)}</select></label>{data.products.find((product) => product.id === productId) ? <RecipeEditor key={productId} product={data.products.find((product) => product.id === productId)!} data={data} onRequest={onRequest}/> : <Empty title="Choose a sellable SKU" detail="Recipes connect actual store products to physical inventory components."/>}</article></div>;
}

function ComponentCreator({ onRequest }: { onRequest: (path: string, options: RequestInit, success: string) => Promise<void> }) {
  const [name, setName] = useState(""); const [sku, setSku] = useState(""); const [componentType, setType] = useState<ComponentType | "">(""); const [recoverable, setRecoverable] = useState(true);
  return <form className="panel setup-form" onSubmit={(event) => { event.preventDefault(); onRequest("/api/catalog/components", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, sku, componentType, unit: "unit", rtoRecoverable: componentType === "COURIER_BOX" ? false : recoverable }) }, "Inventory component created"); setName(""); setSku(""); setType(""); }}><div className="panel-heading"><div><p className="eyebrow">PHYSICAL INVENTORY</p><h2>Create component</h2></div></div><div className="form-grid"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Agarbatti stand" required/></label><label>Component SKU<input value={sku} onChange={(event) => setSku(event.target.value.toUpperCase())} placeholder="STAND-01" required/></label><label>Type<select required value={componentType} onChange={(event) => setType(event.target.value as ComponentType)}><option value="" disabled>Choose component type</option>{["ACCESSORY", "INSERT", "INNER_PACKAGING", "OUTER_PACKAGING", "COURIER_BOX", "OTHER"].map((type) => <option key={type}>{type}</option>)}</select></label><label className="check-label"><input type="checkbox" checked={componentType !== "COURIER_BOX" && recoverable} disabled={componentType === "COURIER_BOX"} onChange={(event) => setRecoverable(event.target.checked)}/>Recover after passed RTO QC</label><button className="primary-button">Create component</button></div></form>;
}

function ComponentManager({ data, onRequest, query = "", readOnly = false }: { data: DashboardSnapshot; onRequest: (path: string, options: RequestInit, success: string) => Promise<void>; query?: string; readOnly?: boolean }) {
  const components = data.inventory.filter((component) => `${component.sku} ${component.name} ${component.componentType}`.toLowerCase().includes(query.toLowerCase()));
  const update = (component: DashboardSnapshot["inventory"][number], changes: { rtoRecoverable?: boolean; active?: boolean }, success: string) => onRequest("/api/catalog/components", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: component.id, sku: component.sku, name: component.name, componentType: component.componentType, unit: component.unit, rtoRecoverable: changes.rtoRecoverable ?? component.rtoRecoverable, active: changes.active ?? true }),
  }, success);
  return <article className="panel table-panel"><div className="panel-heading"><div><p className="eyebrow">YOUR COMPONENTS</p><h2>Every physical item in one list</h2></div><span className="count-badge">{components.length} shown</span></div><div className="table-scroll"><table><thead><tr><th>Component</th><th>Type</th><th>RTO behavior</th>{!readOnly && <th>Actions</th>}</tr></thead><tbody>{components.map((component) => <tr key={component.id}><td><strong>{component.name}</strong><span>{component.sku}</span></td><td>{component.componentType.replaceAll("_", " ")}</td><td>{component.componentType === "COURIER_BOX" ? "Always consumed" : component.rtoRecoverable ? "Recover after QC pass" : "Never recover"}</td>{!readOnly && <td><div className="row-actions">{component.componentType !== "COURIER_BOX" && <button className="small-button" onClick={() => update(component, { rtoRecoverable: !component.rtoRecoverable }, "RTO recovery rule updated")}>{component.rtoRecoverable ? "Mark non-recoverable" : "Mark recoverable"}</button>}<button className="danger-button" onClick={() => { if (window.confirm(`Deactivate ${component.sku}? Existing order snapshots remain unchanged.`)) update(component, { active: false }, "Component deactivated"); }}>Deactivate</button></div></td>}</tr>)}</tbody></table>{!components.length && <Empty title={query ? "No matching component" : "No physical components yet"} detail={query ? "Try a different component name or SKU." : "Create only real component records; no stock is inferred."}/>}</div></article>;
}

function PackagingRules({ data, onRequest }: { data: DashboardSnapshot; onRequest: (path: string, options: RequestInit, success: string) => Promise<void> }) {
  const boxes = data.inventory.filter((item) => item.componentType === "COURIER_BOX"); const [name, setName] = useState(""); const [profileId, setProfileId] = useState(data.packagingProfiles[0]?.id ?? ""); const [componentId, setComponentId] = useState(boxes[0]?.id ?? ""); const [capacity, setCapacity] = useState(1);
  return <div className="setup-pair"><form className="panel setup-form" onSubmit={(event) => { event.preventDefault(); onRequest("/api/catalog/packaging", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create-profile", name }) }, "Packaging profile created"); setName(""); }}><p className="eyebrow">PACKAGING FAMILY</p><h2>Create profile</h2><label>Profile name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Agarbatti" required/></label><button className="secondary-button">Add profile</button></form><form className="panel setup-form" onSubmit={(event) => { event.preventDefault(); onRequest("/api/catalog/packaging", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save-box", profileId, componentId, capacity }) }, "Courier-box capacity saved"); }}><p className="eyebrow">BOX CAPACITY</p><h2>Courier box rule</h2><div className="form-grid"><label>Profile<select value={profileId} onChange={(event) => setProfileId(event.target.value)} required><option value="">Choose profile</option>{data.packagingProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label><label>Courier box<select value={componentId} onChange={(event) => setComponentId(event.target.value)} required><option value="">Choose box</option>{boxes.map((box) => <option value={box.id} key={box.id}>{box.sku} · {box.name}</option>)}</select></label><label>Packing-unit capacity<select value={capacity} onChange={(event) => setCapacity(Number(event.target.value))}><option value={1}>Small · 1</option><option value={2}>Medium · 2</option><option value={3}>Large · 3</option></select></label><button className="secondary-button">Save box rule</button></div><div className="rule-chips">{data.packagingProfiles.flatMap((profile) => profile.boxes.map((box) => <span key={box.id}>{profile.name}: {box.componentName} = {box.capacity}</span>))}</div></form></div>;
}

function RecipeEditor({ product, data, onRequest }: { product: DashboardSnapshot["products"][number]; data: DashboardSnapshot; onRequest: (path: string, options: RequestInit, success: string) => Promise<void> }) {
  const recipeComponents = data.inventory.filter((component) => component.componentType !== "COURIER_BOX");
  const [profileId, setProfileId] = useState(product.packagingProfileId ?? data.packagingProfiles[0]?.id ?? ""); const [packingUnits, setPackingUnits] = useState(product.packingUnits || 1); const [items, setItems] = useState(product.recipeItems.length ? product.recipeItems : [{ componentId: recipeComponents[0]?.id ?? "", quantity: 1 }]);
  const save = (applyTo: "new" | "unshipped") => onRequest(`/api/catalog/recipes/${product.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packagingProfileId: profileId, packingUnits, items, applyTo }) }, applyTo === "new" ? "Recipe saved for new orders" : "Recipe saved and unshipped orders recalculated");
  return <div className="recipe-editor"><div className="recipe-head"><div><strong>{product.name}</strong><span>{product.sku} · {product.variant} <span className="role-pill" style={{ marginLeft: "8px", background: product.isManual ? "rgba(245, 158, 11, 0.2)" : "rgba(59, 130, 246, 0.2)", color: product.isManual ? "#f59e0b" : "#60a5fa" }}>{product.isManual ? "Manual Product" : "Shopify Catalog"}</span> {product.recipeVersion ? ` · current v${product.recipeVersion}` : " · recipe missing"}</span></div><b>{product.buildableUnits} kits buildable now</b></div><div className="form-grid two"><label>Packaging profile<select value={profileId} onChange={(event) => setProfileId(event.target.value)} required><option value="">Choose profile</option>{data.packagingProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label><label>Packing units per sold unit<input type="number" min={1} value={packingUnits} onChange={(event) => setPackingUnits(Number(event.target.value))}/></label></div><div className="recipe-lines"><div className="recipe-columns"><span>Physical component</span><span>Quantity per sold unit</span></div>{items.map((item, index) => <div className="recipe-line" key={index}><select value={item.componentId} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, componentId: event.target.value } : row))}><option value="">Choose component</option>{recipeComponents.map((component) => <option value={component.id} key={component.id}>{component.sku} · {component.name}</option>)}</select><input type="number" min={1} value={item.quantity} onChange={(event) => setItems(items.map((row, i) => i === index ? { ...row, quantity: Number(event.target.value) } : row))}/><button className="danger-button" onClick={() => setItems(items.filter((_, i) => i !== index))}>Remove</button></div>)}<button className="small-button" onClick={() => setItems([...items, { componentId: recipeComponents[0]?.id ?? "", quantity: 1 }])}>+ Add component</button></div><div className="save-choice"><div><strong>How should this version apply?</strong><span>Shipped orders are never changed.</span></div><button className="secondary-button" onClick={() => save("new")}>Save for new orders</button><button className="primary-button" onClick={() => save("unshipped")}>Save & recalculate unshipped</button></div></div>;
}

function Rto({ data, role, query, onQc }: { data: DashboardSnapshot; role: DashboardSnapshot["currentUser"]["role"]; query: string; onQc: (id: string, payload: { lines?: Array<{ orderLineId: string; goodQuantity: number; damagedQuantity: number }>; manualReceipts?: Array<{ componentId: string; quantity: number }>; note?: string }) => Promise<void> }) {
  const canQc = ["ADMIN", "MANAGER", "WAREHOUSE"].includes(role);
  const tasksByOrder = new Map(data.rtoTasks.map((task) => [task.orderId, task]));
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [stage, setStage] = useState<"all" | "initiated" | "transit" | "received" | "qc" | "resolved">("all");
  const statusOf = (order: DashboardSnapshot["rtoOrders"][number]) => {
    const task = tasksByOrder.get(order.id);
    if (task && task.status !== "completed") return "RTO_INSPECTION_PENDING";
    return String(order.currentStatus || order.status).toUpperCase();
  };
  const stages = [
    { key: "all" as const, label: "All RTO", statuses: [] as string[] },
    { key: "initiated" as const, label: "RTO initiated", statuses: ["RTO_INITIATED"] },
    { key: "transit" as const, label: "RTO in transit", statuses: ["RTO_IN_TRANSIT"] },
    { key: "received" as const, label: "RTO received", statuses: ["RTO_RECEIVED"] },
    { key: "qc" as const, label: "QC pending", statuses: ["RTO_INSPECTION_PENDING"] },
    { key: "resolved" as const, label: "QC resolved", statuses: ["RTO_RESTOCKED", "RTO_DAMAGED"] },
  ];
  const activeStage = stages.find((item) => item.key === stage) ?? stages[0];
  const normalizedQuery = query.trim().toLowerCase();
  const stageOrders = (stage === "all" ? data.rtoOrders : data.rtoOrders.filter((order) => activeStage.statuses.includes(statusOf(order))))
    .filter((order) => !normalizedQuery || `${order.orderNumber} ${order.customerName} ${order.awb ?? ""} ${order.courier ?? ""} ${order.lines.map((line) => `${line.sku} ${line.name}`).join(" ")}`.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => (validDate(right.updatedAt)?.getTime() ?? 0) - (validDate(left.updatedAt)?.getTime() ?? 0));
  return <>
    <div className="fulfillment-filter-tabs rto-stage-tabs" role="tablist" aria-label="RTO flow stages">
      {stages.map((item) => {
        const count = item.key === "all" ? data.rtoOrders.length : data.rtoOrders.filter((order) => item.statuses.includes(statusOf(order))).length;
        return <button key={item.key} role="tab" aria-selected={stage === item.key} className={stage === item.key ? "active" : ""} onClick={() => { setStage(item.key); setExpandedOrderId(null); }}><span>{item.label}</span><b>{count}</b></button>;
      })}
    </div>
    <article className="panel queue-panel rto-table-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">RETURN FLOW</p><h2>{activeStage.label}</h2><span className="panel-subtitle">Newest return activity appears first. QC keeps recovered stock unavailable until inspection is completed.</span></div>
        <span className="count-badge">{stageOrders.length} orders</span>
      </div>
      <div className="table-scroll fulfillment-table-scroll">
        <table className="fulfillment-table rto-orders-table">
          <thead><tr><th>Return order</th><th>Customer</th><th>Items</th><th>Courier</th><th>AWB</th><th>Return status</th><th>Dates</th><th>QC</th></tr></thead>
          <tbody>
            {stageOrders.map((order) => {
              const task = tasksByOrder.get(order.id);
              const qcPending = Boolean(task && task.status !== "completed");
              return <Fragment key={order.id}>
                <tr>
                  <td><div className="fulfillment-order-block"><strong>{order.orderNumber}</strong><span>Updated {age(order.updatedAt)} ago</span></div></td>
                  <td><strong>{order.customerName}</strong></td>
                  <td><div className="shipment-detail"><strong>{order.lines.reduce((sum, line) => sum + line.quantity, 0)} units</strong><span>{order.lines.map((line) => `${line.quantity}× ${line.name}`).join(", ") || "Item details unavailable"}</span><span>{order.lines.map((line) => line.sku).filter(Boolean).join(", ") || "SKU unavailable"}</span></div></td>
                  <td>{order.courier || "Courier pending"}</td>
                  <td>{order.awb || "AWB pending"}</td>
                  <td><span className="status-pill purple"><i />{prettyStatus(statusOf(order))}</span></td>
                  <td><div className="shipment-detail"><strong>{order.eta ? `ETA ${shortDate(order.eta)}` : "ETA unavailable"}</strong><span>Last update {shortDate(order.updatedAt)}</span></div></td>
                  <td>{qcPending ? canQc ? <button className="small-button" aria-expanded={expandedOrderId === order.id} onClick={() => setExpandedOrderId((current) => current === order.id ? null : order.id)}>{expandedOrderId === order.id ? "Close QC" : "Inspect return"}</button> : <span className="status-pill warning"><i />QC pending</span> : <span className="status-pill success"><i />{task?.outcome ? prettyStatus(task.outcome) : "No QC pending"}</span>}</td>
                </tr>
                {canQc && qcPending && expandedOrderId === order.id && task && <tr className="fulfillment-detail-row rto-qc-row"><td colSpan={8}><RtoQcCard task={task} order={data.orders.find((item) => item.id === task.orderId)} components={data.inventory} onQc={onQc}/></td></tr>}
              </Fragment>;
            })}
          </tbody>
        </table>
        {!stageOrders.length && <Empty title={`No ${activeStage.label.toLowerCase()} orders`} detail={normalizedQuery ? "No return orders match the current search." : "Orders move here automatically when Shiprocket reports the matching return status."}/>} 
      </div>
      <div className="projection-note"><span>i</span>Courier boxes never return. Recoverable physical components remain non-sellable until warehouse QC passes them.</div>
    </article>
  </>;
}

function RtoQcCard({ task, order, components, onQc }: { task: DashboardSnapshot["rtoTasks"][number]; order?: OrderView; components: DashboardSnapshot["inventory"]; onQc: (id: string, payload: { lines?: Array<{ orderLineId: string; goodQuantity: number; damagedQuantity: number }>; manualReceipts?: Array<{ componentId: string; quantity: number }>; note?: string }) => Promise<void> }) {
  const snapshot = task.lines.some((line) => line.hasSnapshot);
  const [results, setResults] = useState(task.lines.map((line) => ({
    orderLineId: line.id,
    goodQuantity: 0,
    damagedQuantity: line.quantity,
  })));
  const [manual, setManual] = useState([{
    componentId: components.find((item) => item.componentType !== "COURIER_BOX")?.id ?? "",
    quantity: 1,
  }]);
  const [note, setNote] = useState("");
  const preview = snapshot
    ? results.flatMap((result) => (order?.requirements ?? [])
      .filter((requirement) => {
        const component = components.find((item) => item.id === requirement.componentId);
        return requirement.orderLineId === result.orderLineId
          && requirement.source === "BOM"
          && component?.rtoRecoverable
          && component.componentType !== "COURIER_BOX";
      })
      .map((requirement) => ({
        name: requirement.name,
        quantity: (requirement.requiredQuantity / Math.max(1, task.lines.find((line) => line.id === result.orderLineId)?.quantity ?? 1)) * result.goodQuantity,
      })))
      .filter((item) => item.quantity > 0)
    : [];

  return (
    <div className="qc-detail">
      <div className="qc-product">
        <div className="box-icon">□</div>
        <div><strong>{task.orderNumber}</strong><p>{task.customerName} · {task.units} returned units</p></div>
      </div>
      {snapshot ? (
        <div className="qc-lines">
          {task.lines.map((line) => {
            const value = results.find((item) => item.orderLineId === line.id)!;
            return (
              <div key={line.id}>
                <span><strong>{line.name}</strong><small>{line.sku} · total {line.quantity}</small></span>
                <label>Good<input type="number" min={0} max={line.quantity} value={value.goodQuantity} onChange={(event) => {
                  const goodQuantity = Number(event.target.value);
                  setResults(results.map((item) => item.orderLineId === line.id ? { ...item, goodQuantity, damagedQuantity: line.quantity - goodQuantity } : item));
                }}/></label>
                <label>Damaged<input type="number" min={0} max={line.quantity} value={value.damagedQuantity} onChange={(event) => {
                  const damagedQuantity = Number(event.target.value);
                  setResults(results.map((item) => item.orderLineId === line.id ? { ...item, damagedQuantity, goodQuantity: line.quantity - damagedQuantity } : item));
                }}/></label>
              </div>
            );
          })}
          <div className="restock-preview">
            <strong>Will return</strong>
            {preview.length
              ? preview.map((item, index) => <span key={`${item.name}-${index}`}>+{item.quantity} {item.name}</span>)
              : <span>Nothing selected as good</span>}
          </div>
        </div>
      ) : (
        <div className="historical-receipt">
          <p>This historical order has no recipe snapshot. Enter only the components physically recovered.</p>
          {manual.map((row, index) => (
            <div key={index}>
              <select value={row.componentId} onChange={(event) => setManual(manual.map((item, itemIndex) => itemIndex === index ? { ...item, componentId: event.target.value } : item))}>
                {components.filter((item) => item.componentType !== "COURIER_BOX").map((item) => <option value={item.id} key={item.id}>{item.sku} · {item.name}</option>)}
              </select>
              <input type="number" min={1} value={row.quantity} onChange={(event) => setManual(manual.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: Number(event.target.value) } : item))}/>
            </div>
          ))}
          <button className="small-button" onClick={() => setManual([...manual, { componentId: components.find((item) => item.componentType !== "COURIER_BOX")?.id ?? "", quantity: 1 }])}>+ Component</button>
        </div>
      )}
      <label className="qc-note">QC note<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Condition or damage details"/></label>
      <button className="primary-button" disabled={!snapshot && !components.length} onClick={() => onQc(task.id, snapshot ? { lines: results, note } : { manualReceipts: manual, note })}>Complete component QC</button>
    </div>
  );
}

function Team({ data, onUserAction }: { data: DashboardSnapshot; onUserAction: (payload: Record<string, unknown>, success: string) => Promise<void> }) {
  const managerCanResetOnly = data.currentUser.role === "MANAGER";
  const canCreateUsers = data.currentUser.role === "ADMIN";
  const canDeactivateUsers = data.currentUser.role === "ADMIN";
  const canDeleteUsers = data.currentUser.role === "ADMIN";
  const [showCreate, setShowCreate] = useState(false);
  const [resetId, setResetId] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [deleteMessage, setDeleteMessage] = useState("");
  const [menuUserId, setMenuUserId] = useState<string | null>(null);
  const [activeTeamTab, setActiveTeamTab] = useState<"people" | "audits">("people");
  const [auditEvents, setAuditEvents] = useState<DashboardSnapshot["recentAudit"]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditLoaded, setAuditLoaded] = useState(false);
  const [auditError, setAuditError] = useState("");
  
  // Create user state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("VIEWER");
  const [password, setPassword] = useState("");

  // Reset password state
  const [resetPassword, setResetPassword] = useState("");

  const loadAudits = useCallback(async () => {
    setAuditLoading(true);
    setAuditError("");
    try {
      const response = await fetch("/api/audits?limit=200", { cache: "no-store" });
      if (!response.ok) throw new Error("Audit history could not be loaded");
      const result = await response.json() as { events: DashboardSnapshot["recentAudit"]; total: number };
      setAuditEvents(result.events);
      setAuditTotal(result.total);
    } catch (error) {
      setAuditError(error instanceof Error ? error.message : "Audit history could not be loaded");
    } finally {
      setAuditLoaded(true);
      setAuditLoading(false);
    }
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 10) return alert("Password must be at least 10 characters");
    await onUserAction({ action: "create", name, email, role, temporaryPassword: password }, "Team member created with a password");
    setShowCreate(false); setName(""); setEmail(""); setRole("VIEWER"); setPassword("");
  }

  async function handleReset(e: React.FormEvent, id: string) {
    e.preventDefault();
    if (resetPassword.length < 10) return alert("Password must be at least 10 characters");
    await onUserAction({ action: "reset", id, temporaryPassword: resetPassword }, "Password reset");
    setResetId(null); setResetPassword("");
    setMenuUserId(null);
  }

  async function handleDeactivate(user: DashboardSnapshot["users"][number]) {
    if (!window.confirm(`Deactivate ${user.name}? They will be signed out immediately and unable to log back in.`)) return;
    setBusyUserId(user.id);
    try {
      setDeleteMessage("");
      await onUserAction({ action: "deactivate", id: user.id }, "User deactivated and signed out");
      setMenuUserId(null);
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleDelete(user: DashboardSnapshot["users"][number]) {
    const hasHistory = (user.deleteInfo?.historyCount ?? 0) > 0;
    if (user.active && hasHistory) {
      setDeleteMessage(`Deactivate ${user.name} first, then delete permanently. Historical references will stay preserved in audit records.`);
      return;
    }
    if (!window.confirm(`Permanently delete ${user.name}? This removes the user row completely and cannot be undone.`)) return;
    setBusyUserId(user.id);
    try {
      setDeleteMessage("");
      await onUserAction({ action: "delete", id: user.id }, "User permanently deleted");
      setMenuUserId(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "This user could not be deleted.";
      setDeleteMessage(message);
    } finally {
      setBusyUserId(null);
    }
  }

  return <div className="team-workspace">
    <div className="team-tabs" role="tablist" aria-label="People and roles sections">
      <button type="button" role="tab" aria-selected={activeTeamTab === "people"} className={activeTeamTab === "people" ? "active" : ""} onClick={() => setActiveTeamTab("people")}>People and roles</button>
      <button type="button" role="tab" aria-selected={activeTeamTab === "audits"} className={activeTeamTab === "audits" ? "active" : ""} onClick={() => { setActiveTeamTab("audits"); if (!auditLoaded) void loadAudits(); }}>Audits</button>
    </div>
    {activeTeamTab === "people" ? <article className="panel team-panel"><div className="panel-heading"><div><p className="eyebrow">ACCESS CONTROL</p><h2>People and roles</h2><p className="team-heading-detail">Manage account access, assigned roles, and account status.</p></div>{canCreateUsers && !showCreate && <button className="secondary-button" onClick={() => setShowCreate(true)}>+ Add person</button>}</div>
    {managerCanResetOnly && <div className="inline-alert">Managers can review users and reset passwords, but only admins can add, deactivate, or permanently delete people.</div>}
    {deleteMessage && <div className="inline-alert warning">{deleteMessage}</div>}
    {showCreate && (
      <form onSubmit={handleCreate} className="team-form-card">
        <p className="eyebrow">NEW USER</p>
        <div className="form-grid team-form-grid">
          <label>Name<input required value={name} onChange={e => setName(e.target.value)}/></label>
          <label>Email<input required type="email" value={email} onChange={e => setEmail(e.target.value)}/></label>
          <label>Role<select value={role} onChange={e => setRole(e.target.value)}>
            <option value="VIEWER">Viewer</option>
            <option value="MANAGER">Manager</option>
            <option value="CONFIRMATION_AGENT">Confirmation Agent</option>
            <option value="OPERATIONS">Operations</option>
            <option value="WAREHOUSE">Warehouse</option>
            <option value="ADMIN">Admin</option>
          </select></label>
          <label>Password<input required type="password" autoComplete="new-password" minLength={10} value={password} onChange={e => setPassword(e.target.value)}/></label>
          <div className="row-actions team-form-actions">
            <button type="button" className="small-button" onClick={() => setShowCreate(false)}>Cancel</button>
            <button type="submit" className="primary-button small">Create User</button>
          </div>
        </div>
      </form>
    )}
  
  <div className="people-list">{data.users.map((user) => {
    const hasHistory = (user.deleteInfo?.historyCount ?? 0) > 0;
    const deleteDisabled = !canDeleteUsers || busyUserId === user.id || user.id === data.currentUser.id || (user.active && hasHistory);
    const deleteLabel = user.active && hasHistory ? "Deactivate to delete" : "Delete permanently";
    const resetDisabled = !user.active;
    const deactivateDisabled = !canDeactivateUsers || !user.active || busyUserId === user.id || user.id === data.currentUser.id;
    return <div key={user.id} className={`person-card ${user.active ? "" : "inactive"}`}>
    <div className="person-card-grid">
      <div className="avatar muted-avatar">{user.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</div>
      <div className="person-meta person-primary">
        <strong>{user.name}</strong>
        <p>{user.email}</p>
      </div>
      <div className="person-badges">
        <span className="role-pill">{user.role.replaceAll("_", " ")}</span>
        <span className={`role-pill state-pill ${user.active ? "active" : "inactive"}`}>{user.active ? "Active" : "Inactive"}</span>
      </div>
      <div className="person-actions">
        <details className="person-menu" open={menuUserId === user.id} onToggle={(event) => setMenuUserId((event.currentTarget as HTMLDetailsElement).open ? user.id : null)}>
          <summary aria-label={`Actions for ${user.name}`} className="person-menu-trigger">
            <span></span>
            <span></span>
            <span></span>
          </summary>
          <div className="person-menu-popover">
            <button type="button" className="person-menu-item" disabled={resetDisabled} onClick={() => { setResetId(resetId === user.id ? null : user.id); setMenuUserId(null); }}>Reset password</button>
            <button type="button" className="person-menu-item danger" disabled={deactivateDisabled} onClick={() => handleDeactivate(user)}>{busyUserId === user.id ? "Deactivating…" : "Deactivate"}</button>
            <button type="button" className="person-menu-item danger" disabled={deleteDisabled} title={user.deleteInfo?.reason ?? undefined} onClick={() => handleDelete(user)}>{busyUserId === user.id ? "Deleting…" : deleteLabel}</button>
          </div>
        </details>
      </div>
    </div>
    {resetId === user.id && (
      <form onSubmit={(e) => handleReset(e, user.id)} className="inline-reset-form">
        <input required type="password" autoComplete="new-password" minLength={10} placeholder="New password (10+ chars)" value={resetPassword} onChange={e => setResetPassword(e.target.value)} className="inline-reset-input"/>
        <button type="button" className="small-button" onClick={() => setResetId(null)}>Cancel</button>
        <button type="submit" className="primary-button small">Save</button>
      </form>
    )}
  </div>;})}</div></article> : <article className="panel audit-card team-audit-panel">
      <div className="panel-heading"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Recent changes</h2><p className="team-heading-detail">Account, order, campaign, inventory, and integration activity in one chronological record.</p></div><div className="row-actions"><span className="role-pill">{auditTotal} events</span><button className="secondary-button" disabled={auditLoading} onClick={() => void loadAudits()}>{auditLoading ? "Loading…" : "Refresh"}</button></div></div>
      <section className="audit-integrations" aria-labelledby="integration-health-heading">
        <div className="audit-section-heading"><div><p className="eyebrow">INTEGRATIONS</p><h3 id="integration-health-heading">Current connection health</h3></div><a className="secondary-button" href="/auth/shopify">Connect Shopify</a></div>
        <div className="integration-grid">{data.integrations.map((integration) => <div className="integration-row" key={integration.provider}><div className={`integration-logo ${integration.provider}`}>{integration.provider[0].toUpperCase()}</div><div className="integration-copy"><strong>{integration.provider}</strong><p>{integration.detail}</p></div><span className={`status-pill ${integration.status === "connected" ? "success" : "warning"}`}><i/>{integration.status}</span><time>{integration.lastSyncedAt ? `Synced ${age(integration.lastSyncedAt)} ago` : "Never synced"}</time></div>)}</div>
      </section>
      <section className="audit-stream" aria-label="Recent audit events">
        {auditError ? <div className="error-banner">{auditError}</div> : auditLoading && !auditEvents.length ? <p className="muted">Loading recent changes…</p> : auditEvents.length ? auditEvents.map((event) => <div className="audit-row" key={event.id}><i/><div><strong>{event.action.replaceAll(".", " ")}</strong><p>{event.detail}</p></div><span>{event.actorName || "System"} · {age(event.createdAt)}</span></div>) : <Empty title="No changes recorded" detail="Audited activity will appear here."/>}
      </section>
    </article>}
  </div>;
}

function Empty({ title, detail }: { title: string; detail: string }) { return <div className="empty-state"><span>✓</span><h3>{title}</h3><p>{detail}</p></div>; }
