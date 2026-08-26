import { expect, test } from "@playwright/test";

const email = process.env.TEST_ADMIN_EMAIL;
const password = process.env.TEST_ADMIN_PASSWORD;

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/" || url.pathname === "/change-password");
  expect(new URL(page.url()).pathname).toBe("/");
}

test("login never pre-populates credentials", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email address")).toHaveValue("");
  await expect(page.getByLabel("Password")).toHaveValue("");
});

test.describe("authenticated administrator workflows", () => {
  test.skip(!email || !password, "Set TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD for authenticated browser tests");

  test.beforeEach(async ({ page }) => login(page));

  test("audits load only when their submenu opens", async ({ page }) => {
    let auditRequests = 0;
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/audits") auditRequests += 1; });
    await page.getByRole("button", { name: "People and roles" }).first().click();
    expect(auditRequests).toBe(0);
    await page.getByRole("tab", { name: "Audits" }).click();
    await expect.poll(() => auditRequests).toBe(1);
    await expect(page.getByRole("heading", { name: "Recent changes" })).toBeVisible();
  });

  test("campaign modal opens and closes without trapping the page", async ({ page }) => {
    await page.getByRole("button", { name: "Confirmation" }).click();
    await page.getByRole("button", { name: "Campaign Assignment" }).click();
    await page.getByRole("button", { name: /Create new campaign/i }).click();
    await expect(page.getByRole("dialog", { name: "Create confirmation campaign" })).toBeVisible();
    await page.getByRole("button", { name: "Close create campaign" }).click();
    await expect(page.getByRole("dialog", { name: "Create confirmation campaign" })).toBeHidden();
  });

  test("paginated orders accept exact comma-separated IDs", async ({ page }) => {
    const response = await page.request.get("/api/orders?query=SI0715998,SI0715997,SI0715996&limit=2&offset=0");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.orders.length).toBeLessThanOrEqual(2);
    expect(body.pagination.limit).toBe(2);
    expect(body.pagination.total).toBeGreaterThanOrEqual(body.orders.length);
    for (const order of body.orders) expect(["SI0715998", "SI0715997", "SI0715996"]).toContain(order.orderNumber.replace(/^#/, ""));
  });
});
