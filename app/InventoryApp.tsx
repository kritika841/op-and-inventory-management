"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType, DashboardSnapshot, InventoryView, OrderView, SellableProductView } from "@/lib/types";
import { normalizeShiprocketTracking } from "@/lib/shipping";
import { useOrderEvents } from "./useOrderEvents";

type Screen = "overview" | "products" | "components" | "sales" | "insights" | "activity";
type Dialog = null | { type: "add-product" } | { type: "add-component" } | { type: "add-component-type" } | { type: "add-manual-sale" } | { type: "adjust"; component?: InventoryView } | { type: "manage"; component: InventoryView } | { type: "edit-recipe"; product: SellableProductView } | { type: "delete-product"; product: SellableProductView };

const componentTypes: Array<{ value: ComponentType; label: string }> = [
  { value: "ACCESSORY", label: "Accessory" },
  { value: "INSERT", label: "Insert / certificate" }, { value: "INNER_PACKAGING", label: "Inner packaging" },
  { value: "OUTER_PACKAGING", label: "Outer packaging" }, { value: "COURIER_BOX", label: "Courier box" },
  { value: "OTHER", label: "Other" },
];

export default function InventoryApp() {
  const [data, setData] = useState<DashboardSnapshot | null>(null);
  const [screen, setScreen] = useState<Screen>("overview");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("REQUIRED");
  const [toast, setToast] = useState("");
  const [loadError, setLoadError] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  });

  const load = useCallback(async () => {
    setLoadError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    let response: Response;
    try { response = await fetch("/api/state?limit=75", { cache: "no-store", credentials: "same-origin", signal: controller.signal }); }
    catch (error) { if (error instanceof DOMException && error.name === "AbortError") throw new Error("The inventory request timed out. Please try again."); throw error; }
    finally { window.clearTimeout(timeout); }
    if (response.status === 401) return void (window.location.href = "/login");
    if (response.status === 428) return void (window.location.href = "/change-password");
    if (!response.ok) throw new Error("Inventory could not be loaded");
    setData(await response.json());
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load().catch(() => setLoadError("The inventory could not be loaded.")); }, [load]);
  useOrderEvents(() => load().catch(() => undefined));
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    if (!dialog) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setDialog(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [dialog]);

  async function request(path: string, options: RequestInit, success: string) {
    let response: Response;
    try { response = await fetch(path, options); } catch { throw new Error("The dashboard could not reach the server. Check that the local app is running and try again."); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "That change could not be saved");
    setToast(success); setDialog(null); await load();
  }
  async function logout() { await fetch("/auth/logout", { method: "POST" }); window.location.href = "/login"; }

  if (!data && loadError) return <main className="iv-loading"><div className="iv-logo">S</div><h1>Inventory did not load</h1><p>{loadError}</p><button onClick={() => load().catch(() => setLoadError("The inventory request timed out or the server is unavailable."))}>Try again</button></main>;
  if (!data) return <main className="iv-loading"><div className="iv-logo">S</div><span className="iv-loader"/><p>Loading real inventory…</p></main>;

  const admin = ["ADMIN", "MANAGER"].includes(data.currentUser.role);
  const stockEditor = admin || data.currentUser.role === "WAREHOUSE";
  const screenInfo: Record<Screen, { title: string; detail: string }> = {
    overview: { title: "Inventory overview", detail: "Current stock health, reserved units and recent inventory movement." },
    products: { title: "Products", detail: "Sellable products and how many units your components can make." },
    components: { title: "Components", detail: "Your physical warehouse stock and reusable items." },
    sales: { title: "Manual sales", detail: "Record a sale and complete it as delivered or RTO." },
    insights: { title: "Order insights", detail: "Received, AWB, shipment and exception performance by date." },
    activity: { title: "Inventory log", detail: "Every addition and subtraction from physical inventory." },
  };

  return <main className="iv-shell">
    <aside className="iv-sidebar">
      {(["ADMIN", "MANAGER"] as const).includes(data.currentUser.role as "ADMIN" | "MANAGER") ? <div className="iv-workspace-menu"><div className="iv-brand"><div className="iv-logo">S</div><div><strong>Satmi</strong><button className="workspace-name-button" type="button" aria-expanded={workspaceOpen} onClick={() => setWorkspaceOpen((open) => !open)}>Inventory <b aria-hidden>{workspaceOpen ? "⌃" : "⌄"}</b></button></div></div>{workspaceOpen && <div className="iv-workspace-dropdown"><button type="button" onClick={() => { window.location.href = "/?workspace=operations"; }}><i>↗</i><span><strong>Operations</strong></span></button></div>}</div> : <div className="iv-brand"><div className="iv-logo">S</div><div><strong>Satmi</strong><span>Inventory</span></div></div>}
      <nav aria-label="Inventory navigation">
        <button className={screen === "overview" ? "active" : ""} onClick={() => { setScreen("overview"); setQuery(""); }}><i>◌</i><span><strong>Overview</strong></span></button>
        <button className={screen === "products" ? "active" : ""} onClick={() => { setScreen("products"); setQuery(""); }}><i>▤</i><span><strong>Products</strong></span></button>
        <button className={screen === "components" ? "active" : ""} onClick={() => { setScreen("components"); setQuery(""); setFilter("REQUIRED"); }}><i>▦</i><span><strong>Components</strong></span></button>
        <button className={screen === "sales" ? "active" : ""} onClick={() => { setScreen("sales"); setQuery(""); }}><i>₹</i><span><strong>Manual sales</strong></span></button>
        <button className={screen === "insights" ? "active" : ""} onClick={() => { setScreen("insights"); setQuery(""); }}><i>↗</i><span><strong>Order insights</strong></span></button>
        <button className={screen === "activity" ? "active" : ""} onClick={() => { setScreen("activity"); setQuery(""); }}><i>↕</i><span><strong>Inventory log</strong></span></button>
      </nav>
      <div className="iv-sidebar-foot"><span><b/>{data.sampleMode ? "Sample inventory" : "Real inventory"}</span><p>{data.currentUser.name}</p><button onClick={logout}>Sign out</button></div>
    </aside>

    <section className="iv-workspace">
      <header className="iv-topbar"><div><h1>{screenInfo[screen].title}</h1><p>{screenInfo[screen].detail}</p></div><div className="iv-top-actions"><button className="iv-theme-toggle" type="button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}><span>{theme === "dark" ? "☾" : "☀"}</span><strong>{theme === "dark" ? "Dark" : "Light"}</strong></button><div className="iv-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={screen === "components" ? "Search component or SKU" : screen === "products" ? "Search sellable products" : screen === "sales" ? "Search sale or product" : screen === "insights" ? "Search order, AWB or customer" : "Search inventory log"}/>{query && <button onClick={() => setQuery("")} aria-label="Clear search">×</button>}</div><div className="iv-avatar">{data.currentUser.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</div></div></header>
      <div className="iv-content">
        {toast && <div className="iv-toast" role="status"><span>✓</span>{toast}<button onClick={() => setToast("")}>×</button></div>}
        {screen === "overview" && <InventoryOverview data={data} onNavigate={setScreen}/>} 
        {screen === "products" && <ProductsScreen data={data} query={query} canEdit={admin} onDialog={setDialog}/>} 
        {screen === "components" && <InventoryScreen data={data} query={query} filter={filter} onFilter={setFilter} canAdd={admin} canAdjust={stockEditor} onDialog={setDialog} onRequest={request} onError={setToast}/>} 
        {screen === "sales" && <ManualSalesScreen data={data} query={query} canEdit={["ADMIN", "MANAGER", "OPERATIONS", "WAREHOUSE"].includes(data.currentUser.role)} onDialog={setDialog} onRequest={request} onError={setToast}/>} 
        {screen === "insights" && <InsightsScreen data={data} query={query}/>}
        {screen === "activity" && <InventoryLogScreen data={data} query={query}/>} 
      </div>
    </section>
    {dialog && <DialogLayer dialog={dialog} data={data} onClose={() => setDialog(null)} onRequest={request} onError={setToast}/>} 
  </main>;
}

function InventoryScreen({ data, query, filter, onFilter, canAdd, canAdjust, onDialog, onRequest, onError }: { data: DashboardSnapshot; query: string; filter: string; onFilter: (value: string) => void; canAdd: boolean; canAdjust: boolean; onDialog: (dialog: Dialog) => void; onRequest: (path: string, options: RequestInit, success: string) => Promise<void>; onError: (message: string) => void }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkEditing, setBulkEditing] = useState(false);
  const [draftStock, setDraftStock] = useState<Record<string, number>>({});
  const rows = useMemo(() => data.inventory.filter((item) => {
    const matchesQuery = `${item.name} ${item.sku} ${item.componentType} ${item.requiredBy.map((product) => product.productName).join(" ")}`.toLowerCase().includes(query.toLowerCase());
    const matchesFilter = filter === "ALL" || (filter === "REQUIRED" ? item.requiredBy.length > 0 : filter === "PACKAGING" ? ["INNER_PACKAGING", "OUTER_PACKAGING", "COURIER_BOX"].includes(item.componentType) : item.componentType === filter);
    return matchesQuery && matchesFilter;
  }), [data.inventory, query, filter]);
  const selectedRows = data.inventory.filter((item) => selected.has(item.id));
  const allVisibleSelected = rows.length > 0 && rows.every((item) => selected.has(item.id));
  const customFilters = data.componentTypes.filter((item) => !["ACCESSORY", "INSERT", "INNER_PACKAGING", "OUTER_PACKAGING", "COURIER_BOX", "OTHER"].includes(item.code));
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const beginBulkEdit = () => {
    if (!selectedRows.length) return;
    setDraftStock(Object.fromEntries(selectedRows.map((item) => [item.id, item.onHand])));
    setBulkEditing(true);
  };
  const cancelBulkEdit = () => { setBulkEditing(false); setDraftStock({}); };
  const saveBulkEdit = async () => {
    try {
      await onRequest("/api/inventory/bulk", jsonBody({ items: selectedRows.map((item) => ({ componentId: item.id, onHand: draftStock[item.id] })) }), "Selected inventory updated");
      setBulkEditing(false); setDraftStock({}); setSelected(new Set());
    } catch (error) { onError(message(error)); }
  };
  return <>
    <section className="iv-card iv-inventory-card">
      <div className="iv-card-head"><div><p>PHYSICAL INVENTORY</p><h2>{rows.length} components shown</h2><small className="iv-card-detail">Select components and edit their physical stock together, like a spreadsheet.</small></div><div className="iv-actions">{canAdjust && !bulkEditing && <button className="iv-secondary" disabled={!selected.size} onClick={beginBulkEdit}>Bulk edit{selected.size ? ` (${selected.size})` : ""}</button>}{bulkEditing && <><button className="iv-secondary" onClick={cancelBulkEdit}>Cancel</button><button className="iv-primary" onClick={saveBulkEdit}>Save stock changes</button></>}{canAdd && !bulkEditing && <button className="iv-secondary" onClick={() => onDialog({ type: "add-component-type" })}>+ Component type</button>}{canAdd && !bulkEditing && <button className="iv-primary" onClick={() => onDialog({ type: "add-component" })}>+ Add component</button>}</div></div>
      {bulkEditing && <div className="iv-bulk-help"><strong>Spreadsheet edit mode</strong><span>Type a stock value, paste a column from Excel, or drag the dotted handle onto another selected row to copy its value.</span></div>}
      <div className="iv-filters">{[{ key: "REQUIRED", label: "Used in product" }, { key: "ALL", label: "All components" }, { key: "ACCESSORY", label: "Accessories" }, { key: "INSERT", label: "Inserts" }, { key: "PACKAGING", label: "Boxes" }, ...customFilters.map((item) => ({ key: item.code, label: item.name }))].map((item) => <button key={item.key} className={filter === item.key ? "active" : ""} onClick={() => onFilter(item.key)}>{item.label}</button>)}</div>
      <div className="iv-table-wrap"><table className="iv-table iv-components-table simplified"><thead><tr><th className="iv-check-column"><input type="checkbox" aria-label="Select all visible components" disabled={bulkEditing} checked={allVisibleSelected} onChange={() => setSelected((current) => { const next = new Set(current); for (const item of rows) { if (allVisibleSelected) next.delete(item.id); else next.add(item.id); } return next; })}/></th><th>Component</th><th>Used in product</th><th>Physical stock</th><th>Reusable after RTO</th><th/></tr></thead><tbody>{rows.map((item) => <tr key={item.id} className={selected.has(item.id) ? "selected" : ""}><td className="iv-check-column"><input type="checkbox" aria-label={`Select ${item.name}`} disabled={bulkEditing} checked={selected.has(item.id)} onChange={() => toggle(item.id)}/></td><td><div className={`iv-item-icon ${item.componentType.toLowerCase()}`}>{item.name.slice(0, 1)}</div><span><strong>{item.name}</strong><small>{item.sku} · {data.componentTypes.find((type) => type.code === item.componentType)?.name ?? typeLabel(item.componentType)}</small></span></td><td>{item.requiredBy.length ? <span className="iv-required-by" title={item.requiredBy.map((product) => `${product.productName}: ${product.quantity}`).join("\n")}><strong>{shortProductName(item.requiredBy[0].productName)}</strong><small>{item.requiredBy[0].quantity} needed per product</small></span> : <span className="iv-not-used">Not currently used</span>}</td><td className="iv-stock-cell" onDragOver={(event) => { if (bulkEditing && selected.has(item.id)) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); const value = Number(event.dataTransfer.getData("application/x-satmi-stock")); if (Number.isInteger(value) && value >= 0) setDraftStock((current) => ({ ...current, [item.id]: value })); }}>{bulkEditing && selected.has(item.id) ? <div className="iv-stock-editor"><input type="number" min={0} step={1} value={draftStock[item.id] ?? 0} onChange={(event) => setDraftStock((current) => ({ ...current, [item.id]: Number(event.target.value) }))} onPaste={(event) => { const values = event.clipboardData.getData("text").trim().split(/[\s,]+/).map(Number).filter((value) => Number.isInteger(value) && value >= 0); if (values.length < 2) return; event.preventDefault(); const editable = rows.filter((row) => selected.has(row.id)); const start = editable.findIndex((row) => row.id === item.id); setDraftStock((current) => ({ ...current, ...Object.fromEntries(values.slice(0, editable.length - start).map((value, index) => [editable[start + index].id, value])) })); }}/><button type="button" draggable title="Drag to copy this stock value" aria-label={`Drag ${item.name} stock value`} onDragStart={(event) => event.dataTransfer.setData("application/x-satmi-stock", String(draftStock[item.id] ?? 0))}>⠿</button></div> : <b className={item.onHand <= 10 ? "iv-low" : "iv-good"}>{item.onHand.toLocaleString("en-IN")}</b>}</td><td>{item.componentType === "COURIER_BOX" ? <span className="iv-reuse no">No · consumed</span> : <button className={`iv-reuse ${item.rtoRecoverable ? "yes" : "no"}`} disabled={bulkEditing} onClick={() => onDialog({ type: "manage", component: item })}>{item.rtoRecoverable ? "Yes · reusable" : "No · not reusable"}</button>}</td><td><div className="iv-row-actions">{canAdjust && !bulkEditing && <button onClick={() => onDialog({ type: "adjust", component: item })}>Adjust</button>}{canAdd && !bulkEditing && <button onClick={() => onDialog({ type: "manage", component: item })}>Manage</button>}</div></td></tr>)}</tbody></table>{rows.length === 0 && <EmptyState title="No components found" detail="Try a different search or filter."/>}</div>
    </section>
  </>;
}

function InventoryOverview({ data, onNavigate }: { data: DashboardSnapshot; onNavigate: (screen: Screen) => void }) {
  const totals = data.inventory.reduce((summary, item) => ({ onHand: summary.onHand + item.onHand, allocated: summary.allocated + item.allocated, available: summary.available + Math.max(0, item.onHand - item.allocated) }), { onHand: 0, allocated: 0, available: 0 });
  const attention = [...data.inventory].filter((item) => item.onHand - item.allocated <= 10).sort((a, b) => (a.onHand - a.allocated) - (b.onHand - b.allocated));
  const stockRows = [...data.inventory].sort((a, b) => (a.onHand - a.allocated) - (b.onHand - b.allocated)).slice(0, 10);
  return <>
    <section className="iv-stats iv-overview-stats"><article><span>Tracked components</span><strong>{data.inventory.length}</strong><small>Physical inventory records</small></article><article><span>On hand</span><strong>{totals.onHand.toLocaleString("en-IN")}</strong><small>Units currently in warehouse</small></article><article><span>Reserved for orders</span><strong>{totals.allocated.toLocaleString("en-IN")}</strong><small>Units committed to open orders</small></article><article className={attention.length ? "alert" : ""}><span>Needs attention</span><strong>{attention.length}</strong><small>Low or fully reserved components</small></article></section>
    <section className="iv-overview-grid">
      <article className="iv-card iv-overview-card"><div className="iv-card-head"><div><p>STOCK HEALTH</p><h2>Current inventory status</h2><small className="iv-card-detail">Available stock equals on-hand stock less units reserved for active orders.</small></div><button className="iv-secondary" onClick={() => onNavigate("components")}>Manage inventory</button></div><div className="iv-table-wrap iv-overview-scroll"><table className="iv-table iv-overview-table"><thead><tr><th>Component</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Used by</th></tr></thead><tbody>{stockRows.map((item) => { const available = item.onHand - item.allocated; return <tr key={item.id}><td><span><strong>{item.name}</strong><small>{item.sku}</small></span></td><td>{item.onHand.toLocaleString("en-IN")}</td><td>{item.allocated.toLocaleString("en-IN")}</td><td><strong className={available <= 10 ? "iv-low" : "iv-good"}>{Math.max(0, available).toLocaleString("en-IN")}</strong></td><td><small>{item.requiredBy.length ? item.requiredBy.slice(0, 2).map((product) => product.productName).join(", ") : "Not in a recipe"}</small></td></tr>; })}</tbody></table>{stockRows.length === 0 && <EmptyState title="No inventory yet" detail="Add components to begin tracking stock."/>}</div></article>
      <article className="iv-card iv-overview-card"><div className="iv-card-head"><div><p>RECENT MOVEMENT</p><h2>What changed</h2><small className="iv-card-detail">Every stock addition, order allocation and adjustment is recorded here.</small></div><button className="iv-secondary" onClick={() => onNavigate("activity")}>View log</button></div><div className="iv-overview-movements">{data.inventoryLog.slice(0, 7).map((entry) => <div key={entry.id}><span><strong>{entry.componentName}</strong><small>{entry.reason}</small></span><b className={entry.quantity >= 0 ? "iv-good" : "iv-low"}>{entry.quantity > 0 ? "+" : ""}{entry.quantity.toLocaleString("en-IN")}</b><time>{formatDateTime(entry.createdAt)}</time></div>)}{data.inventoryLog.length === 0 && <EmptyState title="No inventory movements" detail="Changes to stock will appear here."/>}</div></article>
    </section>
  </>;
}

function InsightsScreen({ data, query }: { data: DashboardSnapshot; query: string }) {
  const [from, setFrom] = useState(() => dateInput(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(() => dateInput(new Date()));
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [productFilters, setProductFilters] = useState<string[]>([]);
  const [awbMissingOnly, setAwbMissingOnly] = useState(false);
  const [showAllProducts, setShowAllProducts] = useState(false);
  const dateOrders = data.orders.filter((order) => {
    const received = dateInput(new Date(order.createdAt));
    const matchesDate = received >= from && received <= to;
    const matchesQuery = `${order.orderNumber} ${order.customerName} ${order.awb ?? ""} ${order.courier ?? ""} ${order.trackingStatus ?? order.status} ${order.lines.map((line) => `${line.name} ${line.sku}`).join(" ")}`.toLowerCase().includes(query.toLowerCase());
    return matchesDate && matchesQuery;
  });
  const productMap = new Map<string, { key: string; name: string; sku: string; orderIds: Set<string>; awbOrderIds: Set<string>; shippedOrderIds: Set<string>; units: number }>();
  for (const order of dateOrders) {
    for (const line of order.lines) {
      const key = line.productId ?? `sku:${line.sku}`;
      const row = productMap.get(key) ?? { key, name: line.name, sku: line.sku, orderIds: new Set<string>(), awbOrderIds: new Set<string>(), shippedOrderIds: new Set<string>(), units: 0 };
      row.orderIds.add(order.id);
      if (order.awb || currentShipmentStatus(order) === "cancelled_after_awb") row.awbOrderIds.add(order.id);
      if (reachedShipmentStage(order)) row.shippedOrderIds.add(order.id);
      row.units += line.quantity;
      productMap.set(key, row);
    }
  }
  const productRows = [...productMap.values()].sort((a, b) => b.orderIds.size - a.orderIds.size || a.name.localeCompare(b.name));
  const selectedProducts = productRows.filter((product) => productFilters.includes(product.key));
  const filteredOrders = productFilters.length ? dateOrders.filter((order) => order.lines.some((line) => productFilters.includes(line.productId ?? `sku:${line.sku}`))) : dateOrders;
  const orderIds = new Set(filteredOrders.map((order) => order.id));
  const events = data.shipmentEvents.filter((event) => event.orderId && orderIds.has(event.orderId));
  const latestEventByOrder = new Map<string, (typeof data.shipmentEvents)[number]>();
  for (const event of events) {
    if (!event.orderId) continue;
    const current = latestEventByOrder.get(event.orderId);
    if (!current || event.occurredAt > current.occurredAt) latestEventByOrder.set(event.orderId, event);
  }
  const received = filteredOrders.length;
  const awbGenerated = filteredOrders.filter((order) => Boolean(order.awb) || currentShipmentStatus(order) === "cancelled_after_awb").length;
  const awbMissing = filteredOrders.filter(isAwbMissing).length;
  const shipped = filteredOrders.filter(reachedShipmentStage).length;
  const delivered = filteredOrders.filter((order) => currentShipmentStatus(order) === "delivered").length;
  const rto = filteredOrders.filter((order) => currentShipmentStatus(order).startsWith("rto_")).length;
  const exceptionOrderIds = new Set(events.filter((event) => exceptionStatus(event.status)).map((event) => event.orderId));
  for (const order of filteredOrders) if (exceptionStatus(currentShipmentStatus(order))) exceptionOrderIds.add(order.id);
  const exceptionCount = exceptionOrderIds.size;
  const funnel = [
    { label: "Orders received", value: received },
    { label: "AWB generated", value: awbGenerated },
    { label: "Picked up / shipped", value: shipped },
    { label: "Delivered", value: delivered },
  ];
  const statusCounts = new Map<string, number>();
  for (const order of filteredOrders) {
    const status = currentShipmentStatus(order);
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const cancellationStatuses = ["cancelled_after_awb", "cancelled_before_awb"];
  const statusRows: [string, number][] = [
    ...[...statusCounts].filter(([status]) => !cancellationStatuses.includes(status)).sort((a, b) => b[1] - a[1]),
    ...cancellationStatuses.map((status): [string, number] => [status, statusCounts.get(status) ?? 0]),
  ];
  const displayedOrders = filteredOrders.filter((order) => (!statusFilters.length || statusFilters.includes(currentShipmentStatus(order))) && (!awbMissingOnly || isAwbMissing(order)));
  const visibleProductRows = showAllProducts ? productRows : productRows.slice(0, 6);
  const setPreset = (days: number) => {
    setTo(dateInput(new Date()));
    setFrom(dateInput(new Date(Date.now() - (days - 1) * 86_400_000)));
    setStatusFilters([]);
    setProductFilters([]);
    setAwbMissingOnly(false);
    setShowAllProducts(false);
  };
  const toggleProduct = (key: string) => { setProductFilters((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]); setShowAllProducts(false); };
  const toggleStatus = (status: string) => setStatusFilters((current) => current.includes(status) ? current.filter((item) => item !== status) : [...current, status]);

  return <div className="iv-insights">
    <section className="iv-card iv-insights-toolbar">
      <div className="iv-insights-toolbar-title"><p>ANALYTICS PERIOD</p><h2>What do you want to review?</h2><small>All numbers and orders below follow this selection.</small></div>
      <div className="iv-insights-toolbar-actions"><div className="iv-range-presets"><button onClick={() => setPreset(1)}>Today</button><button onClick={() => setPreset(7)}>Last 7 days</button><button onClick={() => setPreset(30)}>Last 30 days</button></div><span className="iv-live"><i/>Live updates every 5 seconds</span></div>
      <div className="iv-insights-fields">
        <label>From<input type="date" value={from} max={to} onChange={(event) => { setFrom(event.target.value); setStatusFilters([]); setProductFilters([]); setAwbMissingOnly(false); setShowAllProducts(false); }}/></label>
        <label>To<input type="date" value={to} min={from} onChange={(event) => { setTo(event.target.value); setStatusFilters([]); setProductFilters([]); setAwbMissingOnly(false); setShowAllProducts(false); }}/></label>
        <div className="iv-multi-filter"><span>Products</span><details><summary>{productFilters.length ? `${productFilters.length} product${productFilters.length === 1 ? "" : "s"} selected` : "All products"}</summary><div className="iv-multi-options"><button type="button" onClick={() => setProductFilters([])}>All products</button>{productRows.map((product) => <label key={product.key}><input type="checkbox" checked={productFilters.includes(product.key)} onChange={() => toggleProduct(product.key)}/><span><strong>{product.name}</strong><small>{product.sku}</small></span></label>)}</div></details></div>
        <div className="iv-multi-filter"><span>Order status</span><details><summary>{statusFilters.length || awbMissingOnly ? `${statusFilters.length + Number(awbMissingOnly)} filter${statusFilters.length + Number(awbMissingOnly) === 1 ? "" : "s"} selected` : "All statuses"}</summary><div className="iv-multi-options iv-status-options"><label><input type="checkbox" checked={awbMissingOnly} onChange={() => setAwbMissingOnly((current) => !current)}/><span><strong>AWB not generated</strong><small>Orders waiting for an AWB</small></span></label>{statusRows.map(([status, count]) => <label key={status}><input type="checkbox" checked={statusFilters.includes(status)} onChange={() => toggleStatus(status)}/><span><strong>{shipmentStatusLabel(status)}</strong><small>{count} orders</small></span></label>)}</div></details></div>
      </div>
    </section>

    {(selectedProducts.length || statusFilters.length || awbMissingOnly) && <section className="iv-active-filters" aria-label="Active analytics filters">
      <span>Showing</span>
      {selectedProducts.map((product) => <button key={product.key} onClick={() => toggleProduct(product.key)}>{shortProductName(product.name)} <b>×</b></button>)}
      {statusFilters.map((status) => <button key={status} onClick={() => toggleStatus(status)}>{shipmentStatusLabel(status)} <b>×</b></button>)}
      {awbMissingOnly && <button onClick={() => setAwbMissingOnly(false)}>AWB not generated <b>×</b></button>}
      <button className="clear" onClick={() => { setProductFilters([]); setStatusFilters([]); setAwbMissingOnly(false); }}>Clear all</button>
    </section>}

    <section className="iv-card iv-journey-overview">
      <div className="iv-card-head"><div><p>ORDER JOURNEY</p><h2>{selectedProducts.length === 1 ? shortProductName(selectedProducts[0].name) : selectedProducts.length ? `${selectedProducts.length} selected products` : "From order to delivery"}</h2><small className="iv-card-detail">{received} orders received between {formatShortDate(from)} and {formatShortDate(to)}</small></div></div>
      <div className="iv-journey-steps">
        {funnel.map((stage, index) => <div className={index === 0 || stage.value > 0 ? "reached" : ""} key={stage.label}>
          <span>{index + 1}</span><strong>{stage.value}</strong><small>{stage.label}</small><em>{index ? rate(stage.value, received) : "Starting total"}</em>
        </div>)}
      </div>
      <div className="iv-attention-strip">
        <div><span>Needs attention</span><strong>{exceptionCount + rto}</strong><small>Orders that may need action</small></div>
        <div className={exceptionCount ? "warning" : ""}><span>Shipment exceptions</span><strong>{exceptionCount}</strong><small>Had a pickup or delivery problem</small></div>
        <div className={rto ? "danger" : ""}><span>Currently RTO</span><strong>{rto}</strong><small>In an active return stage</small></div>
      </div>
    </section>

    <section className="iv-insight-grid">
      <div className="iv-card iv-funnel-card">
        <div className="iv-card-head"><div><p>PROGRESS</p><h2>Where orders are dropping off</h2><small className="iv-card-detail">Compare each step with all received orders.</small></div></div>
        <div className="iv-funnel">{funnel.map((stage) => <div key={stage.label}><span><strong>{stage.label}</strong><small>{rate(stage.value, received)}</small></span><div><i style={{ width: `${received ? Math.max(3, stage.value / received * 100) : 0}%` }}/></div><b>{stage.value}</b></div>)}</div>
      </div>
      <div className="iv-card iv-status-card">
        <div className="iv-card-head"><div><p>CURRENT POSITION</p><h2>Orders by latest status</h2><small className="iv-card-detail">Click a status to filter the order list.</small></div></div>
        <div className="iv-status-breakdown"><button type="button" aria-pressed={awbMissingOnly} className={awbMissingOnly ? "active" : ""} onClick={() => setAwbMissingOnly((current) => !current)}><span className="iv-shipment-status warning">AWB not generated</span><strong>{awbMissing}</strong><i>›</i></button>{statusRows.map(([status, count]) => <button type="button" aria-pressed={statusFilters.includes(status)} className={statusFilters.includes(status) ? "active" : ""} onClick={() => toggleStatus(status)} key={status}><span className={`iv-shipment-status ${statusTone(status)}`}>{shipmentStatusLabel(status)}</span><strong>{count}</strong><i>›</i></button>)}{!filteredOrders.length && <EmptyState title="No orders in this period" detail="Choose another date range."/>}</div>
      </div>
    </section>

    <section className="iv-card iv-product-breakdown">
      <div className="iv-card-head"><div><p>PRODUCT PERFORMANCE</p><h2>{selectedProducts.length ? `${selectedProducts.length} product${selectedProducts.length === 1 ? "" : "s"} selected` : "Compare products"}</h2><small className="iv-card-detail">{selectedProducts.length ? "Selected products are filtering the whole page." : `Showing ${Math.min(visibleProductRows.length, productRows.length)} of ${productRows.length} products. Select one or more to compare.`}</small></div>{productFilters.length > 0 && <button className="iv-clear-status" onClick={() => setProductFilters([])}>× Remove product filters</button>}</div>
      <div className="iv-product-insight-grid">{visibleProductRows.map((product) => <button type="button" key={product.key} aria-pressed={productFilters.includes(product.key)} className={productFilters.includes(product.key) ? "active" : ""} onClick={() => toggleProduct(product.key)}>
        <div className="iv-product-insight-title"><i>{product.name.slice(0, 1)}</i><span><strong>{product.name}</strong><small>{product.sku}</small></span><b>›</b></div>
        <div className="iv-product-card-summary"><span><strong>{product.orderIds.size}</strong><small>orders</small></span><span><strong>{product.units}</strong><small>units</small></span></div>
        <div className="iv-product-progress"><span><small>AWB generated</small><b>{rate(product.awbOrderIds.size, product.orderIds.size)}</b></span><i><b style={{ width: rate(product.awbOrderIds.size, product.orderIds.size) }}/></i><span><small>Shipped</small><b>{rate(product.shippedOrderIds.size, product.orderIds.size)}</b></span><i><b style={{ width: rate(product.shippedOrderIds.size, product.orderIds.size) }}/></i></div>
      </button>)}</div>
      {productRows.length > 6 && !productFilters.length && <div className="iv-product-more"><button className="iv-secondary" onClick={() => setShowAllProducts((current) => !current)}>{showAllProducts ? "Show fewer products" : `Show all ${productRows.length} products`}</button></div>}
      {!productRows.length && <EmptyState title="No products found" detail="Orders with product lines will appear here."/>}
    </section>

    <section className="iv-card iv-orders-insight-card">
      <div className="iv-card-head"><div><p>ORDERS</p><h2>{displayedOrders.length} matching orders</h2><small className="iv-card-detail">Products, AWB, courier and latest Shiprocket status for every order.</small></div>{(statusFilters.length || awbMissingOnly) && <button className="iv-clear-status" onClick={() => { setStatusFilters([]); setAwbMissingOnly(false); }}>× Remove order filters</button>}</div>
      <div className="iv-table-wrap"><table className="iv-table iv-insight-table"><thead><tr><th>Received</th><th>Order</th><th>Product</th><th>Customer</th><th>AWB</th><th>Courier</th><th>Latest status</th><th>Cancellation details</th><th>Last update</th></tr></thead><tbody>{displayedOrders.map((order) => {
        const status = currentShipmentStatus(order);
        const event = latestEventByOrder.get(order.id);
        return <tr key={order.id}><td>{formatDateTime(order.createdAt)}</td><td><span><strong>{order.orderNumber}</strong><small>{formatMoney(order.amount)}</small></span></td><td><span className="iv-order-products"><strong>{order.lines.map((line) => line.name).join(", ")}</strong><small>{order.lines.map((line) => `${line.quantity} × ${line.sku}`).join(" · ")}</small></span></td><td>{order.customerName}</td><td>{order.awb ? <span><strong>{order.awb}</strong><small>Generated</small></span> : status === "cancelled_after_awb" ? <span><strong>Generated</strong><small>Later cancelled</small></span> : <span className={isAwbMissing(order) ? "iv-awaiting" : ""}>{isAwbMissing(order) ? "Not generated" : "Not applicable"}</span>}</td><td>{order.courier ?? "—"}</td><td><span className={`iv-shipment-status ${statusTone(status)}`}>{shipmentStatusLabel(status)}</span></td><td>{status.includes("cancelled") ? <span className="iv-cancellation-detail"><strong>{order.cancellationReason ?? "Reason not supplied"}</strong><small>{order.cancelledBy ? `By ${order.cancelledBy}` : "Who cancelled it was not captured"}{order.cancellationSource ? ` · ${order.cancellationSource}` : ""}{order.cancelledAt ? ` · ${formatDateTime(order.cancelledAt)}` : ""}</small></span> : "—"}</td><td><span><strong>{formatDateTime(event?.occurredAt ?? order.updatedAt)}</strong><small>{event ? "Shiprocket webhook" : "Order sync"}</small></span></td></tr>;
      })}</tbody></table>{!displayedOrders.length && <EmptyState title="No orders found" detail="No orders match the selected products, statuses, AWB filter and search."/>}</div>
    </section>
  </div>;
}

function ManualSalesScreen({ data, query, canEdit, onDialog, onRequest, onError }: { data: DashboardSnapshot; query: string; canEdit: boolean; onDialog: (dialog: Dialog) => void; onRequest: (path: string, options: RequestInit, success: string) => Promise<void>; onError: (message: string) => void }) {
  const sales = data.manualSales.filter((sale) => `${sale.reference} ${sale.productName} ${sale.productSku} ${sale.status}`.toLowerCase().includes(query.toLowerCase()));
  const updateStatus = async (saleId: string, status: "delivered" | "rto") => {
    const detail = status === "rto" ? "Reusable components will be returned to physical stock. Continue?" : "Mark this sale as delivered?";
    if (!window.confirm(detail)) return;
    try { await onRequest(`/api/manual-sales/${saleId}`, jsonBody({ status }), status === "rto" ? "Sale marked RTO and reusable stock returned" : "Sale marked delivered"); }
    catch (error) { onError(message(error)); }
  };
  return <section className="iv-card iv-sales-card"><div className="iv-card-head"><div><p>MANUAL SALES</p><h2>{sales.length} sales shown</h2><small className="iv-card-detail">Stock is subtracted when a manual sale is created.</small></div>{canEdit && <button className="iv-primary" onClick={() => onDialog({ type: "add-manual-sale" })}>+ Create sale</button>}</div><div className="iv-table-wrap"><table className="iv-table iv-sales-table"><thead><tr><th>Sale reference</th><th>Product</th><th>Quantity</th><th>Status</th><th>Created</th><th/></tr></thead><tbody>{sales.map((sale) => <tr key={sale.id}><td><span><strong>{sale.reference}</strong><small>{sale.createdByName ?? "System"}</small></span></td><td><span><strong>{sale.productName}</strong><small>{sale.productSku}</small></span></td><td><strong>{sale.quantity}</strong></td><td><span className={`iv-sale-status ${sale.status}`}>{sale.status === "dispatched" ? "Awaiting result" : sale.status === "rto" ? "RTO" : "Delivered"}</span></td><td>{formatDateTime(sale.createdAt)}</td><td><div className="iv-row-actions">{canEdit && sale.status === "dispatched" && <><button onClick={() => updateStatus(sale.id, "delivered")}>Mark delivered</button><button className="delete" onClick={() => updateStatus(sale.id, "rto")}>Mark RTO</button></>}</div></td></tr>)}</tbody></table>{sales.length === 0 && <EmptyState title="No manual sales" detail="Create a sale when stock needs to be deducted manually."/>}</div></section>;
}

function InventoryLogScreen({ data, query }: { data: DashboardSnapshot; query: string }) {
  const entries = data.inventoryLog.filter((entry) => `${entry.componentName} ${entry.componentSku} ${entry.reason} ${entry.movementType} ${entry.actorName ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="iv-card iv-log-card"><div className="iv-card-head"><div><p>IMMUTABLE INVENTORY LOG</p><h2>{entries.length} movements shown</h2><small className="iv-card-detail">Positive values add physical stock; negative values subtract it.</small></div></div><div className="iv-table-wrap"><table className="iv-table iv-log-table"><thead><tr><th>Date and time</th><th>Component</th><th>Change</th><th>Movement</th><th>Reason</th><th>Recorded by</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td>{formatDateTime(entry.createdAt)}</td><td><span><strong>{entry.componentName}</strong><small>{entry.componentSku}</small></span></td><td><strong className={entry.quantity >= 0 ? "iv-good" : "iv-low"}>{entry.quantity > 0 ? "+" : ""}{entry.quantity.toLocaleString("en-IN")}</strong></td><td><span className="iv-movement-type">{movementLabel(entry.movementType)}</span></td><td>{entry.reason}</td><td>{entry.actorName ?? "System"}</td></tr>)}</tbody></table>{entries.length === 0 && <EmptyState title="No inventory movements" detail="Stock additions and subtractions will appear here."/>}</div></section>;
}

function ProductsScreen({ data, query, canEdit, onDialog }: { data: DashboardSnapshot; query: string; canEdit: boolean; onDialog: (dialog: Dialog) => void }) {
  const products = data.products.filter((item) => `${item.name} ${item.sku} ${item.variant}`.toLowerCase().includes(query.toLowerCase()));
  const configured = data.products.filter((item) => item.recipeVersion).length;
  const buildable = data.products.filter((item) => item.recipeVersion && item.buildableUnits > 0).length;
  const missing = data.products.length - configured;

  return <>
    <section className="iv-stats iv-product-stats">
      <article><span>Sellable products</span><strong>{data.products.length}</strong><small>Imported product SKUs</small></article>
      <article><span>Recipes configured</span><strong>{configured}</strong><small>Products linked to components</small></article>
      <article><span>Can be made now</span><strong>{buildable}</strong><small>Products with component stock</small></article>
      <article className={missing ? "alert" : ""}><span>Missing recipes</span><strong>{missing}</strong><small>Need component setup</small></article>
    </section>
    <section className="iv-card iv-products-card">
      <div className="iv-card-head"><div><p>PRODUCT CATALOG</p><h2>{products.length} sellable products</h2><small className="iv-card-detail">Quantity is calculated from physical component stock.</small></div>{canEdit && <button className="iv-primary" onClick={() => onDialog({ type: "add-product" })}>+ Create product</button>}</div>
      <div className="iv-table-wrap">
        <table className="iv-table iv-products-table">
          <thead><tr><th>Product</th><th>Recipe</th><th>Components per unit</th><th>Limiting component</th><th>Can make now</th><th/></tr></thead>
          <tbody>{products.map((product) => {
            const capacity = getProductCapacity(product, data.inventory);
            const componentUnits = product.recipeItems.reduce((sum, item) => sum + item.quantity, 0);
            return <tr key={product.id}>
              <td><div className="iv-item-icon">{product.name.slice(0, 1)}</div><span><strong>{product.name}</strong><small>{product.sku}{product.variant ? ` · ${product.variant}` : ""}</small></span></td>
              <td>{product.recipeVersion ? <span className="iv-status ready">Ready · v{product.recipeVersion}</span> : <span className="iv-status missing">Recipe missing</span>}</td>
              <td>{product.recipeItems.length ? <span><strong>{product.recipeItems.length} components</strong><small>{componentUnits} physical unit{componentUnits === 1 ? "" : "s"} per product</small></span> : "—"}</td>
              <td>{capacity.limiter ? <span><strong>{capacity.limiter.name}</strong><small>{capacity.limiter.available} in stock · {capacity.limiter.quantity} needed</small></span> : "—"}</td>
              <td><span className={`iv-buildable ${product.recipeVersion && capacity.quantity > 0 ? "ready" : "empty"}`}><strong>{product.recipeVersion ? capacity.quantity.toLocaleString("en-IN") : "—"}</strong><small>{product.recipeVersion ? "products" : "configure recipe"}</small></span></td>
              <td><div className="iv-row-actions"><button onClick={() => onDialog({ type: "edit-recipe", product })}>{canEdit ? (product.recipeVersion ? "Edit recipe" : "Configure recipe") : "View recipe"}</button>{canEdit && <button className="delete" onClick={() => onDialog({ type: "delete-product", product })}>Delete</button>}</div></td>
            </tr>;
          })}</tbody>
        </table>
        {products.length === 0 && <EmptyState title="No products found" detail="Try a different product name or SKU."/>}
      </div>
    </section>
  </>;
}

function getProductCapacity(product: SellableProductView, inventory: InventoryView[]) {
  if (!product.recipeItems.length) return { quantity: 0, limiter: null as null | { name: string; available: number; quantity: number } };
  const limits = product.recipeItems.map((item) => {
    const component = inventory.find((candidate) => candidate.id === item.componentId);
    const available = Math.max(0, component?.onHand ?? 0);
    return { name: component?.name ?? "Missing component", available, quantity: item.quantity, products: Math.floor(available / item.quantity) };
  });
  const limiter = limits.reduce((lowest, item) => item.products < lowest.products ? item : lowest);
  return { quantity: limiter.products, limiter };
}

function RecipeForm({ product, data, canEdit, onRequest, onError }: { product: SellableProductView; data: DashboardSnapshot; canEdit: boolean; onRequest: (path: string, options: RequestInit, success: string) => Promise<void>; onError: (message: string) => void }) {
  const components = data.inventory;
  const profileId = product.packagingProfileId ?? data.packagingProfiles[0]?.id ?? "";
  const [items, setItems] = useState(() => {
    if (!product.recipeItems.length) return [{ componentId: "", quantity: 1 }];
    const unique = new Map<string, number>();
    for (const item of product.recipeItems) unique.set(item.componentId, (unique.get(item.componentId) ?? 0) + item.quantity);
    return [...unique].map(([componentId, quantity]) => ({ componentId, quantity }));
  });
  const selectedIds = new Set(items.map((item) => item.componentId).filter(Boolean));
  const hasUnusedComponent = components.some((component) => !selectedIds.has(component.id));
  async function save() {
    try {
      await onRequest(`/api/catalog/recipes/${product.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packagingProfileId: profileId, packingUnits: 1, items, applyTo: "new" }) }, "Product components saved");
    } catch (error) { onError(error instanceof Error ? error.message : "Recipe could not be saved"); }
  }
  return <div className="iv-recipe-form">
    <div className="iv-recipe-title"><div><p>{product.sku}</p><h2>{product.name}</h2><span>{product.variant}</span></div><b className={product.recipeVersion ? "ready" : "missing"}>{product.recipeVersion ? `Recipe v${product.recipeVersion}` : "Recipe missing"}</b></div>
    <div className="iv-bom">
      <div className="iv-section-label"><strong>Required components</strong><span>Each component can be added once. Increase its quantity when more units are needed.</span></div>
      <div className="iv-bom-head"><span>Physical component</span><span>Physical stock</span><span>Qty per product</span><span/></div>
      {items.map((item, index) => {
        const choices = components.filter((component) => component.id === item.componentId || !selectedIds.has(component.id));
        const selectedComponent = components.find((component) => component.id === item.componentId);
        return <div className="iv-bom-row" key={`${item.componentId || "new"}-${index}`}>
          <select disabled={!canEdit} value={item.componentId} onChange={(event) => {
            const componentId = event.target.value;
            if (componentId && items.some((row, rowIndex) => rowIndex !== index && row.componentId === componentId)) return onError("This component is already added. Increase its quantity instead");
            setItems(items.map((row, rowIndex) => rowIndex === index ? { ...row, componentId } : row));
          }}>
            <option value="">Choose component</option>
            {choices.map((component) => <option key={component.id} value={component.id}>{component.sku} · {component.name} · {component.onHand.toLocaleString("en-IN")} in stock</option>)}
          </select>
          <strong className={`iv-recipe-stock ${selectedComponent && selectedComponent.onHand <= 10 ? "iv-low" : "iv-good"}`}>{selectedComponent ? selectedComponent.onHand.toLocaleString("en-IN") : "—"}</strong>
          <input aria-label="Quantity per product" disabled={!canEdit} type="number" min={1} step={1} value={item.quantity} onChange={(event) => setItems(items.map((row, rowIndex) => rowIndex === index ? { ...row, quantity: Number(event.target.value) } : row))}/>
          {canEdit && <button type="button" onClick={() => setItems(items.filter((_, rowIndex) => rowIndex !== index))}>Remove</button>}
        </div>;
      })}
      {canEdit && (hasUnusedComponent ? <button type="button" className="iv-add-line" onClick={() => setItems([...items, { componentId: "", quantity: 1 }])}>+ Add component</button> : <small className="iv-all-components-added">All available components are already added. Increase a quantity above if needed.</small>)}
    </div>
    <div className="iv-recipe-summary"><span><strong>{product.buildableUnits}</strong><small>products possible from physical component stock</small></span>{canEdit && <div><button className="iv-primary" onClick={save}>Save components</button></div>}</div>
  </div>;
}

function DialogLayer({ dialog, data, onClose, onRequest, onError }: { dialog: Exclude<Dialog, null>; data: DashboardSnapshot; onClose: () => void; onRequest: (path: string, options: RequestInit, success: string) => Promise<void>; onError: (message: string) => void }) {
  return <div className="iv-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className={`iv-modal ${["edit-recipe", "add-product", "add-manual-sale"].includes(dialog.type) ? "wide" : ""}`} role="dialog" aria-modal="true"><button className="iv-modal-close" type="button" onClick={onClose} aria-label="Close">×</button>{dialog.type === "add-manual-sale" && <ManualSaleForm data={data} onRequest={onRequest} onError={onError}/>} {dialog.type === "add-product" && <AddProductForm data={data} onRequest={onRequest} onError={onError}/>} {dialog.type === "add-component" && <AddComponentForm componentTypes={data.componentTypes} onRequest={onRequest} onError={onError}/>} {dialog.type === "add-component-type" && <AddComponentTypeForm onRequest={onRequest} onError={onError}/>} {dialog.type === "adjust" && <AdjustStockForm components={data.inventory} selected={dialog.component} onRequest={onRequest} onError={onError}/>} {dialog.type === "manage" && <ManageComponentForm component={dialog.component} onRequest={onRequest} onError={onError}/>} {dialog.type === "edit-recipe" && <RecipeForm product={dialog.product} data={data} canEdit={["ADMIN", "MANAGER"].includes(data.currentUser.role)} onRequest={onRequest} onError={onError}/>} {dialog.type === "delete-product" && <DeleteProductForm product={dialog.product} onRequest={onRequest} onError={onError}/>}</div></div>;
}

function ManualSaleForm({ data, onRequest, onError }: FormRequestProps & { data: DashboardSnapshot }) {
  const [reference, setReference] = useState(() => manualSaleReference()); const [productId, setProductId] = useState(""); const [quantity, setQuantity] = useState(1);
  const product = data.products.find((item) => item.id === productId);
  const requirements = (product?.recipeItems ?? []).map((item) => { const component = data.inventory.find((candidate) => candidate.id === item.componentId); return { ...item, component, required: item.quantity * quantity }; });
  const enoughStock = Boolean(product?.recipeVersion) && requirements.length > 0 && requirements.every((item) => item.component && item.component.onHand >= item.required);
  return <form onSubmit={async (event) => { event.preventDefault(); try { await onRequest("/api/manual-sales", jsonBody({ reference, productId, quantity }), "Manual sale created and component stock subtracted"); } catch (error) { onError(message(error)); } }}><ModalTitle eyebrow="MANUAL INVENTORY SALE" title="Create manual sale" detail="The product recipe is subtracted from physical stock immediately."/><div className="iv-form-grid"><label>Sale reference<input autoFocus required value={reference} onChange={(event) => setReference(event.target.value.toUpperCase())}/></label><label>Product<select required value={productId} onChange={(event) => setProductId(event.target.value)}><option value="">Choose product</option>{data.products.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.sku}</option>)}</select></label><label>Sale quantity<input required type="number" min={1} step={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))}/></label></div>{product && <div className="iv-sale-preview"><div className="iv-section-label"><strong>Stock to subtract</strong><span>{product.recipeVersion ? `${product.buildableUnits} products possible now` : "Recipe missing"}</span></div>{requirements.map((item) => <div key={item.componentId}><span><strong>{item.component?.name ?? "Missing component"}</strong><small>{item.component?.sku ?? item.componentId}</small></span><span><b>{item.required}</b><small>required</small></span><span className={item.component && item.component.onHand >= item.required ? "iv-good" : "iv-low"}><b>{item.component?.onHand ?? 0}</b><small>in stock</small></span></div>)}</div>}<div className="iv-modal-footer"><button className="iv-primary" type="submit" disabled={!enoughStock}>Create sale & subtract stock</button></div></form>;
}

function AddProductForm({ data, onRequest, onError }: FormRequestProps & { data: DashboardSnapshot }) {
  const [name, setName] = useState(""); const [sku, setSku] = useState(""); const [skuEdited, setSkuEdited] = useState(false); const [variant, setVariant] = useState("Default");
  const [items, setItems] = useState([{ componentId: "", quantity: 1 }]);
  const selectedIds = new Set(items.map((item) => item.componentId).filter(Boolean));
  const hasUnusedComponent = data.inventory.some((component) => !selectedIds.has(component.id));
  const completeItems = items.filter((item) => item.componentId && Number.isInteger(item.quantity) && item.quantity > 0);
  const buildable = completeItems.length === items.length && completeItems.length ? Math.min(...completeItems.map((item) => Math.floor((data.inventory.find((component) => component.id === item.componentId)?.onHand ?? 0) / item.quantity))) : 0;
  return <form onSubmit={async (event) => { event.preventDefault(); try { await onRequest("/api/catalog/products", jsonBody({ name, sku, variant, packagingProfileId: data.packagingProfiles[0]?.id ?? "", items }), "Product and recipe created"); } catch (error) { onError(message(error)); } }}>
    <ModalTitle eyebrow="NEW SELLABLE PRODUCT" title="Create product and recipe" detail="Add the product and choose every physical component required to make one unit."/>
    <div className="iv-form-grid iv-product-fields"><label>Product name<input autoFocus required value={name} onChange={(event) => { const value = event.target.value; setName(value); if (!skuEdited) setSku(productSku(value)); }} placeholder="Example: Gulab Incense Gift Pack"/></label><label>Product SKU<input required value={sku} onChange={(event) => { setSku(event.target.value.toUpperCase()); setSkuEdited(Boolean(event.target.value)); }} placeholder="Generated from product name"/><small>Generated automatically; you can edit it before saving.</small></label><label>Variant<input value={variant} onChange={(event) => setVariant(event.target.value)} placeholder="Default"/></label></div>
    <div className="iv-bom iv-create-product-bom">
      <div className="iv-section-label"><strong>Required components</strong><span>Physical stock is shown beside every component.</span></div>
      <div className="iv-product-bom-head"><span>Component</span><span>Physical stock</span><span>Qty per product</span><span/></div>
      {items.map((item, index) => {
        const choices = data.inventory.filter((component) => component.id === item.componentId || !selectedIds.has(component.id));
        const component = data.inventory.find((candidate) => candidate.id === item.componentId);
        return <div className="iv-product-bom-row" key={`${item.componentId || "new"}-${index}`}><select required value={item.componentId} onChange={(event) => setItems(items.map((row, rowIndex) => rowIndex === index ? { ...row, componentId: event.target.value } : row))}><option value="">Choose component</option>{choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.name} · {choice.onHand.toLocaleString("en-IN")} in stock</option>)}</select><strong className={component && component.onHand <= 10 ? "iv-low" : "iv-good"}>{component ? component.onHand.toLocaleString("en-IN") : "—"}</strong><input aria-label="Quantity per product" required type="number" min={1} step={1} value={item.quantity} onChange={(event) => setItems(items.map((row, rowIndex) => rowIndex === index ? { ...row, quantity: Number(event.target.value) } : row))}/><button type="button" onClick={() => setItems(items.filter((_, rowIndex) => rowIndex !== index))}>Remove</button></div>;
      })}
      {hasUnusedComponent && <button type="button" className="iv-add-line" onClick={() => setItems([...items, { componentId: "", quantity: 1 }])}>+ Add component</button>}
    </div>
    <div className="iv-create-product-footer"><span><strong>{buildable.toLocaleString("en-IN")}</strong><small>products possible from current physical stock</small></span><button className="iv-primary" type="submit">Create product</button></div>
  </form>;
}

function AddComponentForm({ componentTypes: availableTypes, onRequest, onError }: FormRequestProps & { componentTypes: DashboardSnapshot["componentTypes"] }) {
  const [name, setName] = useState(""); const [sku, setSku] = useState(""); const [skuEdited, setSkuEdited] = useState(false); const [type, setType] = useState<ComponentType | "">(""); const [openingQuantity, setOpeningQuantity] = useState(0); const [recoverable, setRecoverable] = useState(true);
  return <form onSubmit={async (event) => { event.preventDefault(); try { await onRequest("/api/catalog/components", jsonBody({ name, sku, componentType: type, unit: "unit", openingQuantity, rtoRecoverable: type === "COURIER_BOX" ? false : recoverable }), "Component and opening stock created"); } catch (error) { onError(message(error)); } }}><ModalTitle eyebrow="NEW PHYSICAL COMPONENT" title="Add inventory component" detail="Products are managed separately. Add only a physical input used to make or pack a product."/><div className="iv-modal-fields"><label>Component name<input autoFocus required value={name} onChange={(event) => { const value = event.target.value; setName(value); if (!skuEdited) setSku(componentSku(value)); }} placeholder="Example: Incense inner box"/></label><label>Internal SKU<input required value={sku} onChange={(event) => { setSku(event.target.value.toUpperCase()); setSkuEdited(Boolean(event.target.value)); }} placeholder="Generated from component name"/><small>Generated automatically; you can edit it before saving.</small></label><label>Component type<select required value={type} onChange={(event) => setType(event.target.value as ComponentType)}><option value="" disabled>Choose component type</option>{availableTypes.map((item) => <option value={item.code} key={item.code}>{item.name}</option>)}</select></label><label>Opening physical stock<input required type="number" min={0} step={1} value={openingQuantity} onChange={(event) => setOpeningQuantity(Number(event.target.value))}/><small>How many units are physically available now.</small></label>{type && type !== "COURIER_BOX" && <label className="iv-check"><input type="checkbox" checked={recoverable} onChange={(event) => setRecoverable(event.target.checked)}/><span><strong>Reusable after RTO</strong><small>Enable this only when a good returned component can be used again after QC.</small></span></label>}</div><ModalActions submit="Create component"/></form>;
}

function AddComponentTypeForm({ onRequest, onError }: FormRequestProps) {
  const [name, setName] = useState("");
  return <form onSubmit={async (event) => { event.preventDefault(); try { await onRequest("/api/catalog/component-types", jsonBody({ name }), "Component type created"); } catch (error) { onError(message(error)); } }}><ModalTitle eyebrow="COMPONENT CLASSIFICATION" title="Create component type" detail="Create a reusable type that will appear whenever a component is added."/><div className="iv-modal-fields"><label>Type name<input autoFocus required maxLength={40} value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: Raw material"/></label>{name.trim() && <div className="iv-code-preview"><span>Internal code</span><strong>{typeCode(name)}</strong></div>}</div><ModalActions submit="Create type"/></form>;
}

function AdjustStockForm({ components, selected, onRequest, onError }: FormRequestProps & { components: InventoryView[]; selected?: InventoryView }) {
  const [componentId, setComponentId] = useState(selected?.id ?? components[0]?.id ?? ""); const [quantity, setQuantity] = useState(0); const [reason, setReason] = useState(""); const component = components.find((item) => item.id === componentId);
  return <form onSubmit={async (event) => { event.preventDefault(); try { await onRequest("/api/inventory", jsonBody({ componentId, quantity, reason }), "Stock adjustment recorded"); } catch (error) { onError(message(error)); } }}><ModalTitle eyebrow="AUDITED STOCK CHANGE" title="Adjust stock" detail="Use a positive number to add stock and a negative number to remove it."/><div className="iv-current-stock"><span>Current on hand</span><strong>{component?.onHand ?? 0}</strong></div><div className="iv-modal-fields"><label>Component<select value={componentId} onChange={(event) => setComponentId(event.target.value)}>{components.map((item) => <option value={item.id} key={item.id}>{item.sku} · {item.name}</option>)}</select></label><label>Quantity change<input autoFocus required type="number" value={quantity} onChange={(event) => setQuantity(Number(event.target.value))}/></label><label>Reason<input required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Example: Physical cycle count"/></label></div><ModalActions submit="Save adjustment"/></form>;
}

function ManageComponentForm({ component, onRequest, onError }: FormRequestProps & { component: InventoryView }) {
  const update = async (payload: { rtoRecoverable: boolean; active: boolean }, success: string) => { try { await onRequest("/api/catalog/components", jsonBody({ id: component.id, sku: component.sku, name: component.name, componentType: component.componentType, unit: component.unit, ...payload }), success); } catch (error) { onError(message(error)); } };
  return <div><ModalTitle eyebrow={component.sku} title={component.name} detail="Manage this physical component or remove it from the component list."/><div className="iv-current-stock"><span>Physical stock</span><strong>{component.onHand}</strong></div>{component.componentType === "COURIER_BOX" ? <div className="iv-info">Courier boxes are never reusable because they are considered consumed or damaged during delivery and RTO.</div> : <button className="iv-setting-row" onClick={() => update({ rtoRecoverable: !component.rtoRecoverable, active: true }, component.rtoRecoverable ? "Component marked not reusable" : "Component marked reusable")}><span><strong>Reusable after RTO</strong><small>Currently {component.rtoRecoverable ? "Yes — passed items return to stock" : "No — returned items are not restocked"}</small></span><i className={component.rtoRecoverable ? "on" : ""}/></button>}<div className="iv-modal-footer"><button className="iv-danger" onClick={() => { if (window.confirm(`Delete ${component.name} from the component list? Past stock and order history will be kept.`)) update({ rtoRecoverable: component.rtoRecoverable, active: false }, "Component deleted"); }}>Delete component</button></div></div>;
}

function DeleteProductForm({ product, onRequest, onError }: FormRequestProps & { product: SellableProductView }) {
  return <div><ModalTitle eyebrow="DELETE PRODUCT" title={product.name} detail="This removes the product from this local inventory panel. Existing order history and the Shopify product remain unchanged."/><div className="iv-delete-warning"><strong>{product.sku}</strong><span>Its active component recipe will also be archived.</span></div><div className="iv-modal-footer"><button className="iv-danger" onClick={async () => { try { await onRequest(`/api/catalog/products/${product.id}`, jsonBody({}), "Product deleted from the panel"); } catch (error) { onError(message(error)); } }}>Delete product</button></div></div>;
}

type FormRequestProps = { onRequest: (path: string, options: RequestInit, success: string) => Promise<void>; onError: (message: string) => void };
function ModalTitle({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) { return <div className="iv-modal-title"><p>{eyebrow}</p><h2>{title}</h2><span>{detail}</span></div>; }
function ModalActions({ submit }: { submit: string }) { return <div className="iv-modal-footer"><button className="iv-primary" type="submit">{submit}</button></div>; }
function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="iv-empty"><span>◇</span><h3>{title}</h3><p>{detail}</p></div>; }
function jsonBody(value: unknown): RequestInit { return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }; }
function message(error: unknown) { return error instanceof Error ? error.message : "That change could not be saved"; }
function typeLabel(type: ComponentType) { return componentTypes.find((item) => item.value === type)?.label ?? type.replaceAll("_", " "); }
function shortProductName(name: string) { return name.replace(/\s*[–-]\s*Bambooless Incense Sticks.*$/i, "").replace(/\s*Refill Pack.*$/i, ""); }
function componentSku(name: string) { const code = typeCode(name); return code ? `CMP-${code.replaceAll("_", "-")}` : ""; }
function productSku(name: string) { const code = typeCode(name); return code ? `PRD-${code.replaceAll("_", "-")}` : ""; }
function typeCode(name: string) { return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
function manualSaleReference() { const now = new Date(); const part = (value: number) => String(value).padStart(2, "0"); return `SALE-${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`; }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value)); }
function dateInput(value: Date) { return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Kolkata" }).format(value); }
function formatShortDate(value: string) { return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${value}T00:00:00+05:30`)); }
function rate(value: number, total: number) { return `${total ? Math.round(value / total * 100) : 0}%`; }
function currentShipmentStatus(order: OrderView) {
  const normalized = normalizeShiprocketTracking(order.trackingStatus || order.status || "");
  if (normalized === "cancelled_after_awb" || normalized === "cancelled_before_awb") return normalized;
  if (normalized.includes("cancel")) return order.awb ? "cancelled_after_awb" : "cancelled_before_awb";
  if (!normalized || ["open", "new", "pending"].includes(normalized)) return order.awb ? "awb_generated" : "order_received";
  return normalized;
}
function isAwbMissing(order: OrderView) { return !order.awb && currentShipmentStatus(order) === "order_received"; }
function reachedShipmentStage(order: OrderView) {
  const status = currentShipmentStatus(order);
  return ["picked_up", "shipped", "in_transit", "out_for_delivery", "delivered", "undelivered", "delayed", "partial_delivered", "lost", "damaged", "destroyed", "fulfilled", "reached_destination", "misrouted", "rto_initiated", "rto_acknowledged", "rto_ndr", "rto_out_for_delivery", "rto_in_transit", "rto_delivered", "reached_warehouse", "reached_back_at_seller_city"].includes(status);
}
function exceptionStatus(status: string) { return ["pickup_error", "pickup_exception", "handover_exception", "packed_exception", "undelivered", "delayed", "lost", "damaged", "destroyed", "misrouted", "qc_failed", "untraceable", "recipient_issue"].includes(status); }
function statusTone(status: string) {
  if (status === "delivered") return "success";
  if (status.startsWith("rto_")) return "purple";
  if (exceptionStatus(status) || status.includes("cancel")) return "danger";
  if (["picked_up", "shipped", "in_transit", "out_for_delivery", "reached_destination"].includes(status)) return "progress";
  if (["awb_generated", "awb_assigned", "label_generated", "pickup_scheduled", "pickup_queued", "out_for_pickup", "pickup_booked", "manifest_generated"].includes(status)) return "warning";
  return "neutral";
}
function shipmentStatusLabel(status: string) {
  const labels: Record<string, string> = {
    order_received: "Order received", awb_generated: "AWB generated", awb_assigned: "AWB assigned", label_generated: "Label generated",
    pickup_scheduled: "Pickup scheduled", pickup_queued: "Pickup queued", pickup_booked: "Pickup booked", out_for_pickup: "Out for pickup",
    picked_up: "Picked up", shipped: "Shipped", in_transit: "In transit", reached_destination: "Reached destination",
    out_for_delivery: "Out for delivery", delivered: "Delivered", pickup_error: "Pickup error", pickup_exception: "Pickup exception",
    pickup_rescheduled: "Pickup rescheduled", undelivered: "Undelivered", delayed: "Delayed", partial_delivered: "Partially delivered",
    lost: "Lost", damaged: "Damaged", destroyed: "Destroyed", misrouted: "Misrouted", cancelled: "Cancelled",
    cancelled_after_awb: "Cancelled after AWB", cancelled_before_awb: "Cancelled before AWB",
    cancelled_before_dispatch: "Cancelled before dispatch", rto_initiated: "RTO initiated", rto_acknowledged: "RTO acknowledged",
    rto_ndr: "RTO NDR", rto_out_for_delivery: "RTO out for delivery", rto_in_transit: "RTO in transit", rto_delivered: "RTO delivered",
    reached_warehouse: "Reached warehouse", reached_back_at_seller_city: "Reached seller city", handover_exception: "Handover exception",
    packed_exception: "Packed exception", untraceable: "Untraceable", recipient_issue: "Recipient issue",
  };
  return labels[status] ?? status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function formatMoney(value: number) { return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value / 100); }
function movementLabel(value: string) { return ({ opening: "Opening stock", adjustment: "Stock adjustment", "manual-sale": "Manual sale", "manual-rto": "Manual RTO", shipment: "Shipment", "RTO-QC-pass": "RTO QC pass", damage: "Damage" } as Record<string, string>)[value] ?? value.replaceAll("-", " "); }
