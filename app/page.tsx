"use client";

import { useCallback, useEffect, useState } from "react";
import type { DashboardSnapshot } from "@/lib/types";
import InventoryApp from "./InventoryApp";
import OperationsApp from "./OperationsApp";

// Roles that should see the operations-first workspace.
// WAREHOUSE and VIEWER stay on the inventory-first workspace.
const OPS_ROLES: DashboardSnapshot["currentUser"]["role"][] = [
  "ADMIN",
  "MANAGER",
  "OPERATIONS",
  "CONFIRMATION_AGENT",
];

export default function Home() {
  const [role, setRole] = useState<DashboardSnapshot["currentUser"]["role"] | null>(null);
  const [workspace, setWorkspace] = useState<"operations" | "inventory">("operations");
  const [loadError, setLoadError] = useState("");

  const loadWorkspace = useCallback(async () => {
    setLoadError("");
    const requestedWorkspace = new URLSearchParams(window.location.search).get("workspace");
    if (requestedWorkspace === "inventory" || requestedWorkspace === "operations") {
      setWorkspace(requestedWorkspace);
    }
    try {
      // A brief pooler wake-up immediately after sign-in is recoverable. Retry
      // once before showing an error instead of stranding the user on a blank
      // dashboard shell.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 20_000);
        try {
          const res = await fetch("/api/session", { cache: "no-store", credentials: "same-origin", signal: controller.signal });
          if (res.status === 401) return void (window.location.href = "/login");
          if (res.status === 428) return void (window.location.href = "/change-password");
          if (!res.ok) throw new Error("Dashboard state could not be loaded");
          const data = await res.json() as { currentUser: DashboardSnapshot["currentUser"] };
          setRole(data.currentUser.role);
          return;
        } catch (error) {
          if (attempt === 1) throw error;
        } finally {
          window.clearTimeout(timeout);
        }
      }
    } catch {
      setLoadError("The dashboard could not reach the database. Please try again.");
    }
  }, []);

  useEffect(() => {
    // Queue the initial load outside React's effect phase. It keeps the effect
    // purely for lifecycle wiring while the async loader owns its UI state.
    const start = window.setTimeout(() => { void loadWorkspace(); }, 0);
    return () => window.clearTimeout(start);
  }, [loadWorkspace]);

  if (loadError) {
    return <main className="iv-loading"><div className="iv-logo">S</div><h1>Dashboard unavailable</h1><p>{loadError}</p><button onClick={() => void loadWorkspace()}>Try again</button><button onClick={() => { window.location.href = "/login"; }}>Return to sign in</button></main>;
  }

  if (!role) {
    // Show a neutral loading state while we resolve the role
    return (
      <main className="iv-loading">
        <div className="iv-logo">S</div>
        <span className="iv-loader" />
        <p>Signing you in…</p>
      </main>
    );
  }

  // Only Admins and Managers may choose either workspace. Other roles retain
  // their purpose-built default so a crafted query cannot widen access.
  if (["ADMIN", "MANAGER"].includes(role) && workspace === "inventory") {
    return <InventoryApp />;
  }

  if (OPS_ROLES.includes(role)) {
    return <OperationsApp />;
  }

  return <InventoryApp />;
}
