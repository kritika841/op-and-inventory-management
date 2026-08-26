"use client";

import { useEffect, useEffectEvent, useRef } from "react";

export function useOrderEvents(onOrderUpdate: () => void | Promise<void>) {
  const timerRef = useRef<number | null>(null);
  const handleUpdate = useEffectEvent(async () => {
    await onOrderUpdate();
  });

  useEffect(() => {
    const events = new EventSource("/api/events");

    const queueReload = () => {
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(async () => {
        timerRef.current = null;
        await handleUpdate();
      }, 250);
    };

    events.addEventListener("order.updated", queueReload);
    // EventSource reconnects automatically. Refresh once on a broken stream
    // so a brief Durable Object restart never leaves a dashboard stale.
    events.onerror = queueReload;

    return () => {
      events.removeEventListener("order.updated", queueReload);
      events.onerror = null;
      events.close();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);
}
