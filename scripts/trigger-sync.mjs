const baseUrl = process.env.SATMI_SYNC_BASE_URL || "http://127.0.0.1:8000";
const session = process.env.SATMI_SYNC_SESSION;

if (!session) {
  console.error("Missing SATMI_SYNC_SESSION. Provide an authenticated satmi_session value; no sync was started.");
  process.exit(2);
}

const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/admin/sync`, {
  method: "POST",
  headers: {
    Cookie: `satmi_session=${encodeURIComponent(session)}`,
    "Content-Type": "application/json",
    Origin: baseUrl,
  },
  body: "{}",
});

const body = await response.text();
console.log(`Sync request returned HTTP ${response.status}.`);
console.log(body);

if (!response.ok) process.exit(1);
