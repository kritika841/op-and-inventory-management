import type { OrderRealtimeEvent } from "../lib/realtime";

type ClientRole =
  | "ADMIN"
  | "MANAGER"
  | "CONFIRMATION_AGENT"
  | "OPERATIONS"
  | "WAREHOUSE"
  | "VIEWER";

type ClientSession = {
  id: string;
  userId: string;
  role: ClientRole;
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
};

const encoder = new TextEncoder();

function encodeEvent(event: string, payload: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function encodeComment(message: string) {
  return encoder.encode(`: ${message}\n\n`);
}

function asRole(value: string | null): ClientRole | null {
  if (
    value === "ADMIN"
    || value === "MANAGER"
    || value === "CONFIRMATION_AGENT"
    || value === "OPERATIONS"
    || value === "WAREHOUSE"
    || value === "VIEWER"
  ) {
    return value;
  }
  return null;
}

function canReceiveEvent(client: ClientSession, payload: OrderRealtimeEvent) {
  if (client.role === "CONFIRMATION_AGENT") {
    return payload.order.assignedUserId === client.userId;
  }
  if (client.role === "WAREHOUSE") {
    return payload.order.warehouseVisible;
  }
  return true;
}

export class OrderEventsHub {
  private readonly clients = new Map<string, ClientSession>();

  constructor(readonly state: DurableObjectState) {}

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/connect") {
      return this.connect(url);
    }
    if (request.method === "POST" && url.pathname === "/broadcast") {
      return this.broadcast(request);
    }
    return new Response("Not found", { status: 404 });
  }

  private connect(url: URL) {
    const userId = url.searchParams.get("userId");
    const role = asRole(url.searchParams.get("role"));
    if (!userId || !role) {
      return new Response("Missing client identity", { status: 400 });
    }

    const clientId = crypto.randomUUID();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const heartbeat = setInterval(() => {
          this.write(clientId, encodeComment(`keep-alive ${Date.now()}`));
        }, 20_000);

        this.clients.set(clientId, {
          id: clientId,
          userId,
          role,
          controller,
          heartbeat,
        });
        this.write(clientId, encodeComment("connected"));
        this.write(clientId, encodeEvent("connected", { ok: true }));
      },
      cancel: () => {
        this.disconnect(clientId);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-store, must-revalidate",
        connection: "keep-alive",
      },
    });
  }

  private async broadcast(request: Request) {
    const payload = await request.json() as OrderRealtimeEvent;
    let delivered = 0;

    for (const [clientId, client] of this.clients) {
      if (!canReceiveEvent(client, payload)) continue;
      if (this.write(clientId, encodeEvent(payload.type, payload))) delivered += 1;
    }

    return Response.json({ ok: true, delivered });
  }

  private write(clientId: string, chunk: Uint8Array) {
    const client = this.clients.get(clientId);
    if (!client) return false;
    try {
      client.controller.enqueue(chunk);
      return true;
    } catch {
      this.disconnect(clientId);
      return false;
    }
  }

  private disconnect(clientId: string) {
    const client = this.clients.get(clientId);
    if (!client) return;
    clearInterval(client.heartbeat);
    this.clients.delete(clientId);
    try {
      client.controller.close();
    } catch {
      // Closing an already-closed stream is harmless here.
    }
  }
}
