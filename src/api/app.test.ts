import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApp } from "./app.js";
import { InMemoryOrderStore } from "../domain/orders.js";
import { SandboxPaymentProvider } from "../payments/sandbox-provider.js";
import { InMemoryWorkerActivator, type WorkerActivator } from "../payments/service.js";

const headers = { "content-type": "application/json", "x-account-id": "account-one", "idempotency-key": "order-key-0001" };
const testOptions = { resolveAccount: (requested: string | undefined) => requested };

describe("checkout API", () => {
  it("publica salud y catalogo versionado", async () => {
    const app = createApp(testOptions);
    assert.deepEqual(await (await app.request("/api/health")).json(), { ok: true, service: "perxia-checkout" });
    const catalog = await (await app.request("/api/catalog")).json() as { version: string; products: unknown[] };
    assert.equal(catalog.version, "2026-10-14");
    assert.equal(catalog.products.length, 5);
  });

  it("recalcula el total y crea la orden en la cuenta autenticada", async () => {
    const app = createApp(testOptions);
    const body = JSON.stringify({ items: [{ productId: "cybersecurity", plan: "month", quantity: 2 }] });
    const response = await app.request("/api/orders", { method: "POST", headers, body });
    assert.equal(response.status, 201);
    const order = await response.json() as { id: string; accountId: string; status: string; quote: { totalAmount: number } };
    assert.equal(order.accountId, "account-one");
    assert.equal(order.status, "pending_payment");
    assert.equal(order.quote.totalAmount, 360_000);

    const repeated = await app.request("/api/orders", { method: "POST", headers, body });
    assert.equal(repeated.status, 201);
    assert.equal((await repeated.json() as { id: string }).id, order.id);

    assert.equal((await app.request(`/api/orders/${order.id}`, { headers: { "x-account-id": "account-two" } })).status, 404);
    assert.equal((await app.request(`/api/orders/${order.id}`, { headers: { "x-account-id": "account-one" } })).status, 200);
  });

  it("exige cuenta y valida cantidades", async () => {
    const app = createApp(testOptions);
    const body = JSON.stringify({ items: [{ productId: "quality", plan: "month", quantity: 0 }] });
    assert.equal((await app.request("/api/quotes", { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401);
    assert.equal((await app.request("/api/quotes", { method: "POST", headers, body })).status, 400);
  });

  it("no permite reutilizar una clave con otro pedido y responde 404 en rutas API desconocidas", async () => {
    const app = createApp(testOptions);
    const first = JSON.stringify({ items: [{ productId: "quality", plan: "month", quantity: 1 }] });
    const second = JSON.stringify({ items: [{ productId: "quality", plan: "month", quantity: 2 }] });
    assert.equal((await app.request("/api/orders", { method: "POST", headers, body: first })).status, 201);
    assert.equal((await app.request("/api/orders", { method: "POST", headers, body: second })).status, 422);
    assert.equal((await app.request("/api/unknown")).status, 404);
  });
});

const operatorHeaders = { "x-account-id": "account-one", "x-demo-operator-key": "operator-test" };

async function createPaidFixture(app: ReturnType<typeof createApp>, suffix: string, items: readonly { productId: string; plan: "week" | "month"; quantity: number }[] = [{ productId: "quality", plan: "month", quantity: 1 }]) {
  const orderResponse = await app.request("/api/orders", {
    method: "POST",
    headers: { ...headers, "idempotency-key": `payment-${suffix}` },
    body: JSON.stringify({ items }),
  });
  const order = await orderResponse.json() as { id: string };
  const sessionResponse = await app.request(`/api/orders/${order.id}/checkout-session`, { method: "POST", headers });
  const session = await sessionResponse.json() as { id: string };
  const fixtureResponse = await app.request(`/api/test-only/sandbox/checkout-sessions/${session.id}/confirm`, {
    method: "POST", headers: { ...operatorHeaders, "content-type": "application/json" }, body: JSON.stringify({ eventId: `event-${suffix}` }),
  });
  const fixture = await fixtureResponse.json() as { rawBody: string; signature: string };
  return { order, session, fixture };
}

async function sendWebhook(app: ReturnType<typeof createApp>, fixture: { rawBody: string; signature: string }) {
  return app.request("/api/payments/webhooks/sandbox", { method: "POST", headers: { "sandbox-signature": fixture.signature, "content-type": "application/json" }, body: fixture.rawBody });
}

describe("payment lifecycle API", () => {
  it("rechaza firmas invalidas y deduplica el mismo evento con un solo efecto", async () => {
    const store = new InMemoryOrderStore();
    const app = createApp({ ...testOptions, store, operatorKey: "operator-test" });
    const { order, fixture } = await createPaidFixture(app, "dedupe01");

    assert.equal((await app.request("/api/payments/webhooks/sandbox", { method: "POST", headers: { "sandbox-signature": "t=1,v1=bad" }, body: fixture.rawBody })).status, 422);
    const first = await sendWebhook(app, fixture);
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { duplicate: boolean }).duplicate, false);
    const duplicate = await sendWebhook(app, fixture);
    assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);
    assert.equal(store.subscriptionsForOrder(order.id).length, 1);
    assert.equal(store.auditRecords("account-one").filter((record) => record.action === "payment.succeeded").length, 1);
  });

  it("ignora eventos fuera de orden y representa suscripciones semanales y mensuales por separado", async () => {
    const app = createApp({ ...testOptions, operatorKey: "operator-test" });
    const { order, session, fixture } = await createPaidFixture(app, "ordering1", [
      { productId: "quality", plan: "week", quantity: 1 },
      { productId: "quality", plan: "month", quantity: 2 },
    ]);
    await sendWebhook(app, fixture);
    const late = await app.request(`/api/test-only/sandbox/checkout-sessions/${session.id}/confirm`, {
      method: "POST", headers: { ...operatorHeaders, "content-type": "application/json" }, body: JSON.stringify({ type: "payment.processing", eventId: "event-late-processing" }),
    });
    await sendWebhook(app, await late.json() as { rawBody: string; signature: string });
    const fetched = await app.request(`/api/orders/${order.id}`, { headers });
    assert.equal((await fetched.json() as { status: string }).status, "active");
    const summary = await (await app.request("/api/account/summary", { headers })).json() as { subscriptions: { weekly: number; monthly: number; total: number } };
    assert.deepEqual(summary.subscriptions, { weekly: 1, monthly: 2, total: 3 });
  });

  it("conserva activaciones idempotentes tras fallo determinista y permite reintento", async () => {
    const store = new InMemoryOrderStore();
    const activator = new InMemoryWorkerActivator();
    const app = createApp({ ...testOptions, store, activator, operatorKey: "operator-test" });
    const { order, fixture } = await createPaidFixture(app, "retry001", [{ productId: "quality", plan: "month", quantity: 2 }]);
    activator.failNext(`${order.id}:quality:month:2`);
    await sendWebhook(app, fixture);
    assert.equal(store.find(order.id)?.status, "activation_pending");
    assert.equal(store.subscriptionsForOrder(order.id).length, 1);

    const retry = await app.request(`/api/operations/orders/${order.id}/retry-activation`, { method: "POST", headers: operatorHeaders });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as { status: string }).status, "active");
    assert.equal(store.subscriptionsForOrder(order.id).length, 2);
    await app.request(`/api/operations/orders/${order.id}/retry-activation`, { method: "POST", headers: operatorHeaders });
    assert.equal(store.subscriptionsForOrder(order.id).length, 2);
  });

  it("compensa con reembolso idempotente y exige el guard de operador", async () => {
    const store = new InMemoryOrderStore();
    const app = createApp({ ...testOptions, store, operatorKey: "operator-test" });
    const { order, fixture } = await createPaidFixture(app, "refund01");
    await sendWebhook(app, fixture);
    assert.equal((await app.request(`/api/operations/orders/${order.id}/refund`, { method: "POST", headers })).status, 403);
    const refunded = await app.request(`/api/operations/orders/${order.id}/refund`, { method: "POST", headers: operatorHeaders });
    assert.equal((await refunded.json() as { status: string }).status, "refunded");
    const repeated = await app.request(`/api/operations/orders/${order.id}/refund`, { method: "POST", headers: operatorHeaders });
    assert.equal((await repeated.json() as { status: string }).status, "refunded");
    assert.equal(store.auditRecords("account-one").filter((record) => record.action === "refund.requested").length, 1);
  });

  it("aisla cuentas y detecta y resuelve diferencias de conciliacion", async () => {
    const app = createApp({ ...testOptions, operatorKey: "operator-test" });
    const { order, fixture } = await createPaidFixture(app, "reconcile");
    assert.equal((await app.request(`/api/orders/${order.id}`, { headers: { "x-account-id": "account-two" } })).status, 404);
    assert.equal((await app.request(`/api/operations/orders/${order.id}/retry-activation`, { method: "POST", headers: { "x-account-id": "account-two", "x-demo-operator-key": "operator-test" } })).status, 422);
    const before = await (await app.request("/api/operations/reconciliation", { headers: operatorHeaders })).json() as { balanced: boolean; issues: unknown[] };
    assert.equal(before.balanced, false);
    assert.equal(before.issues.length, 1);
    await sendWebhook(app, fixture);
    const after = await (await app.request("/api/operations/reconciliation", { headers: operatorHeaders })).json() as { balanced: boolean };
    assert.equal(after.balanced, true);
    const otherSummary = await (await app.request("/api/account/summary", { headers: { "x-account-id": "account-two" } })).json() as { orders: { total: number } };
    assert.equal(otherSummary.orders.total, 0);
  });

  it("mantiene refunded si el reembolso cruza una activacion en curso", async () => {
    let releaseActivation!: () => void;
    let activationStarted!: () => void;
    const started = new Promise<void>((resolve) => { activationStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseActivation = resolve; });
    let externalActive = false;
    const activator: WorkerActivator = {
      async activate() { activationStarted(); await release; externalActive = true; },
      async deactivate() { externalActive = false; },
    };
    const store = new InMemoryOrderStore();
    const app = createApp({ ...testOptions, store, activator, operatorKey: "operator-test" });
    const { order, fixture } = await createPaidFixture(app, "refund-race");
    const webhook = sendWebhook(app, fixture);
    await started;
    const refundRequest = app.request(`/api/operations/orders/${order.id}/refund`, { method: "POST", headers: operatorHeaders });
    releaseActivation();
    const refunded = await refundRequest;
    assert.equal((await refunded.json() as { status: string }).status, "refunded");
    await webhook;
    assert.equal(store.find(order.id)?.status, "refunded");
    assert.ok(store.subscriptionsForOrder(order.id).every((subscription) => subscription.status === "refunded"));
    assert.equal(externalActive, false);
  });

  it("permite reintentar una compensacion tras fallo transitorio del proveedor", async () => {
    const provider = new SandboxPaymentProvider("test-secret-at-least-16");
    const store = new InMemoryOrderStore();
    const app = createApp({ ...testOptions, store, provider, operatorKey: "operator-test" });
    const { order, fixture } = await createPaidFixture(app, "refund-retry");
    await sendWebhook(app, fixture);
    provider.failNextRefund();
    assert.equal((await app.request(`/api/operations/orders/${order.id}/refund`, { method: "POST", headers: operatorHeaders })).status, 422);
    assert.equal(store.find(order.id)?.status, "compensating");
    const retried = await app.request(`/api/operations/orders/${order.id}/refund`, { method: "POST", headers: operatorHeaders });
    assert.equal((await retried.json() as { status: string }).status, "refunded");
    assert.equal(store.auditRecords("account-one").filter((record) => record.action === "refund.requested").length, 1);
  });

  it("reintenta un webhook de reembolso cuando falla la desactivacion", async () => {
    const store = new InMemoryOrderStore();
    const activator = new InMemoryWorkerActivator();
    const app = createApp({ ...testOptions, store, activator, operatorKey: "operator-test" });
    const { order, session, fixture } = await createPaidFixture(app, "refund-webhook");
    await sendWebhook(app, fixture);
    const activationKey = `${order.id}:quality:month:1`;
    activator.failNextDeactivation(activationKey);
    const refundFixtureResponse = await app.request(`/api/test-only/sandbox/checkout-sessions/${session.id}/confirm`, {
      method: "POST", headers: { ...operatorHeaders, "content-type": "application/json" }, body: JSON.stringify({ type: "payment.refunded", eventId: "event-refund-retry" }),
    });
    const refundFixture = await refundFixtureResponse.json() as { rawBody: string; signature: string };
    assert.equal((await sendWebhook(app, refundFixture)).status, 422);
    assert.equal(store.find(order.id)?.status, "compensating");
    assert.equal((await sendWebhook(app, refundFixture)).status, 200);
    assert.equal(store.find(order.id)?.status, "refunded");
    assert.ok(store.subscriptionsForOrder(order.id).every((subscription) => subscription.status === "refunded"));
  });

  it("cierra el atajo sandbox cuando la demostracion esta deshabilitada", async () => {
    const app = createApp({ ...testOptions, operatorKey: "operator-test", enableSandboxDemo: false });
    const orderResponse = await app.request("/api/orders", {
      method: "POST", headers, body: JSON.stringify({ items: [{ productId: "quality", plan: "month", quantity: 1 }] }),
    });
    const order = await orderResponse.json() as { id: string };
    assert.equal((await app.request(`/api/test-only/sandbox/orders/${order.id}/complete`, { method: "POST", headers })).status, 422);
    const session = await (await app.request(`/api/orders/${order.id}/checkout-session`, { method: "POST", headers })).json() as { id: string };
    assert.equal((await app.request(`/api/test-only/sandbox/checkout-sessions/${session.id}/confirm`, { method: "POST", headers: operatorHeaders })).status, 422);
  });
});
