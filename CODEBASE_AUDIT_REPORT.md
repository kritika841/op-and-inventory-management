# Satmi Operations Dashboard Audit

Audit date: 2026-08-14

## Scope and validation

- Reviewed the application shell, role routing, People and roles, confirmation, fulfillment, inventory, integration sync, authentication, API authorization, webhooks, database snapshot construction, migrations, and automated tests.
- Verified the People and roles and Audits views in the running local dashboard in dark mode.
- Verified that the login email and password fields load empty.
- Ran TypeScript, ESLint, production build, and the full test suite successfully.
- Inspected the current local D1 data without changing records or passwords.

## Corrected in this pass

- Split People and roles into two top-level submenus: **People and roles** and **Audits**.
- Moved current Shopify and Shiprocket connection health into Audits above the chronological recent-change stream.
- Increased recent audit visibility from 8 to 500 events and made the stream internally scrollable.
- Rebuilt People and roles rows as full-width aligned cards with stable columns, responsive behavior, and dark-mode contrast.
- Removed hardcoded credentials from the login form. Email and password now start empty.
- Replaced user-facing temporary-password labels with **Password** and **New password**. No stored password was changed.
- Corrected the stale Shiprocket upsert test assertion.

## Findings

### P0: Webhook verification can fail open

**Evidence:** `app/api/webhooks/shopify/route.ts` verifies HMAC only when `SHOPIFY_CLIENT_SECRET` exists. `app/api/webhooks/shiprocket/route.ts` checks the key only when `SHIPROCKET_WEBHOOK_SECRET` exists and uses substring matching.

**Impact:** A missing production secret makes either endpoint accept unauthenticated order or shipment updates. Substring matching is weaker than exact constant-time comparison.

**Correction:** In live mode, reject every webhook when its secret is absent. Compare the complete Shiprocket credential exactly and add deployment health checks that prevent startup/release with missing secrets.

### P0: Known cryptographic and initial-password fallbacks remain in live code

**Evidence:** `lib/auth.ts`, `lib/integrations.ts`, and `lib/database.ts` fall back to known session, pepper, encryption-key, and initial-password strings.

**Impact:** A misconfigured live deployment silently uses predictable secrets. Existing environment values are configured locally, but the code does not fail closed when they are absent elsewhere.

**Correction:** Require `SESSION_SECRET`, `PASSWORD_PEPPER`, and `TOKEN_ENCRYPTION_KEY` in live mode. Require an explicit initial admin email/password only for first bootstrap, then remove or disable bootstrap credentials. This change should be deployed with a secret-rotation plan; it must not be applied by mutating user passwords without authorization.

### P1: Unknown Shiprocket status codes are recorded as IN_TRANSIT

**Evidence:** `app/api/webhooks/shiprocket/route.ts` maps every unrecognized status code to `IN_TRANSIT`.

**Impact:** A new, malformed, or unsupported provider status can incorrectly advance an order and affect fulfillment reporting.

**Correction:** Preserve the prior status, record the unknown provider event, flag the order for integration review, and add an explicit mapping test for every supported Shiprocket code.

### P1: Shiprocket webhook delivery is not idempotent

**Evidence:** Shiprocket event IDs include `Date.now()` and there is no receipt/deduplication lookup equivalent to Shopify's `webhook_receipts` flow.

**Impact:** Provider retries create duplicate tracking events and may repeat downstream work.

**Correction:** Build a deterministic receipt key from Shiprocket's event identifier, or from AWB + status + provider timestamp, and process each receipt once in a transaction.

### P1: Manual refresh is not a complete historical reconciliation

**Evidence:** `lib/integrations.ts` limits both Shopify and Shiprocket imports to the last 60 days.

**Impact:** Older still-open orders can be absent if they were not already stored locally. The dashboard cannot currently guarantee that no order is missed solely from manual refresh.

**Correction:** Add an initial full backfill and a recurring incremental cursor. Reconcile open orders regardless of age, retain webhook ingestion for new updates, and expose last successful cursor and discrepancy counts in Audits.

### P1: Local order data contains legacy duplicate rows

**Evidence:** The current local D1 has 4,416 order rows but 3,200 unique normalized order numbers, leaving 1,216 duplicate provider rows.

**Impact:** UI reconciliation hides most duplicates, but aggregates, allocations, and direct queries can still double-count physical rows.

**Correction:** Run a reviewed migration that merges Shopify/Shiprocket duplicates by normalized order number, reparents lines/events/assignments, and adds a uniqueness constraint or canonical external-identity table. Back up D1 first.

### P1: The dashboard snapshot is monolithic and repeatedly reloaded

**Evidence:** `lib/state.ts` loads all orders, lines, tags, requirements, campaigns, users, and up to 5,000 shipment events in one `/api/state` response. `app/OperationsApp.tsx` reloads it on SSE, focus, visibility changes, actions, and every 20 seconds.

**Impact:** Payload and render cost scale with the whole database. At the current 4,416 rows and 11,129 order lines this is a mounting responsiveness risk.

**Correction:** Split state by screen, paginate or virtualize order tables, fetch audit history separately, and use SSE event payloads for targeted cache updates instead of full reloads.

### P2: Product matching without SKU needs an explicit review queue

**Evidence:** `lib/integrations.ts` automatically maps a missing-SKU line when exactly one active product has the same case-insensitive name.

**Impact:** Product renames or reused names can assign an incorrect BOM and therefore incorrect component shortage/allocation data.

**Correction:** Keep exact SKU/variant ID as authoritative. Put name-only matches into a proposed mapping queue that an administrator confirms before requirements are recalculated.

### P2: First-load failure falls back to a VIEWER workspace

**Evidence:** `app/page.tsx` sets role to `VIEWER` when the first `/api/state` request fails.

**Impact:** A transient server failure can render the wrong application shell before the second load reports an error, making configuration failures look like role changes.

**Correction:** Keep a dedicated load-error state and retry action; never infer a user role from a network failure.

### P2: Automated coverage is too shallow for workflow-critical behavior

**Evidence:** The suite has 13 passing tests. Several tests assert source strings rather than exercising API requests, webhook security, sync reconciliation, role access, campaign ordering, or browser behavior.

**Impact:** Refactors can keep expected text while breaking runtime behavior, and provider edge cases are not protected.

**Correction:** Add D1-backed route tests, signed/unsigned webhook tests, duplicate reconciliation tests, role-permission matrices, campaign reorder tests, and browser smoke tests for each role and primary modal.

## Current integration and data verdict

- Shopify is connected locally and its last recorded sync imported 100 orders with no line backfill.
- Shiprocket is currently unhealthy: the recorded connection state is `error` with a 12-second timeout, and the last successful timestamp is stale.
- There are no currently unmatched local tracking events, but that does not prove historical completeness because imports are bounded to 60 days.
- Component-shortage accuracy is conditional on correct product/SKU mapping, current recipes, and complete inventory ledger entries. It should not be presented as 100% validated until duplicate cleanup and mapping review are complete.

## Recommended correction order

1. Fail closed on missing webhook and cryptographic secrets; add provider webhook idempotency.
2. Repair Shiprocket connectivity and expose a deterministic integration health check.
3. Back up and reconcile the 1,216 duplicate order rows, then enforce canonical order identity.
4. Replace the 60-day-only import with full backfill plus incremental reconciliation.
5. Split `/api/state`, add table virtualization/pagination, and reduce full snapshot reloads.
6. Add integration, authorization, and browser workflow tests before further UI expansion.
