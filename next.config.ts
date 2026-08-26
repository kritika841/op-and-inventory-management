import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the ngrok tunnel origin in dev mode.
  // Without this, vinext's dev server blocks all cross-origin POST requests
  // (including login) with a 403 "Blocked dev request" CSRF guard.
  allowedDevOrigins: [
    "unrelated-snagged-unframed.ngrok-free.dev",
    "localhost:8000",
    "127.0.0.1:8000",
  ],
  experimental: {
    serverActions: {
      allowedOrigins: [
        "unrelated-snagged-unframed.ngrok-free.dev",
        "localhost:8000",
        "127.0.0.1:8000",
      ],
    },
  },
};

export default nextConfig;
