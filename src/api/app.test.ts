import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApp } from "./app.js";

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
