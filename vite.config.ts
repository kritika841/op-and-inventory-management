import vinext from "vinext";
import path from "node:path";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json" with { type: "json" };
import { sites } from "./build/sites-vite-plugin.ts";

const { r2 } = hostingConfig;
const ORDER_EVENTS = "ORDER_EVENTS";
const localNodeRuntime = process.env.SATMI_NODE_DEV === "1";

function r2Bindings(bucketName: string) {
  return r2
    ? [
        {
          binding: r2,
          bucket_name: bucketName,
        },
      ]
    : [];
}

function durableObjectBindings() {
  return {
    bindings: [
      {
        name: ORDER_EVENTS,
        class_name: "OrderEventsHub",
      },
    ],
  };
}

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async () => {
  const localBindingConfig = {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    hyperdrive: process.env.SUPABASE_DATABASE_URL
      ? [{ binding: "HYPERDRIVE", id: "local-supabase", localConnectionString: process.env.SUPABASE_DATABASE_URL }]
      : [],
    triggers: {
      crons: ["0 * * * *"], // Hourly: AUTO_CANCEL_RISK check
    },
    r2_buckets: r2Bindings("site-creator-r2"),
    durable_objects: durableObjectBindings(),
    env: {
      staging: {
        r2_buckets: r2Bindings("site-creator-staging-r2"),
        durable_objects: durableObjectBindings(),
      },
      production: {
        r2_buckets: r2Bindings("site-creator-production-r2"),
        durable_objects: durableObjectBindings(),
      },
    },
  };

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      // Bind explicitly to loopback so localhost:8000 works consistently on
      // macOS and does not fall back to the blocked IPv6 ::1 listener.
      host: "127.0.0.1",
      port: 8000,
      strictPort: true,
      allowedHosts: [".trycloudflare.com", ".ngrok-free.dev", ".loca.lt", ".ngrok.app", ".ngrok.io"],
      ...(isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : {}),
    },
    resolve: localNodeRuntime
      ? { alias: { "cloudflare:workers": path.resolve("lib/local-cloudflare-workers.ts") } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      ...(!localNodeRuntime ? [cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
        // The Worker inspector is optional. In the Codex macOS sandbox it
        // cannot bind its default 0.0.0.0:9229 socket, which otherwise aborts
        // dev startup before Vite starts listening on port 8000.
        inspectorPort: false,
      })] : []),
    ],
  };
});
