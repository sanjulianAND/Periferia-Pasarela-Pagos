import assert from "node:assert/strict";

import { createApp } from "../src/api/app.js";

const app = createApp();
const request = {
  items: [
    { productId: "software-construction", plan: "week", quantity: 2 },
    { productId: "quality", plan: "month", quantity: 1 },
  ],
};

const orderResponse = await app.request("/api/orders", {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": "demo-order-20261028" },
  body: JSON.stringify(request),
});
assert.equal(orderResponse.status, 201);
const order = await orderResponse.json() as { id: string; status: string; quote: { totalAmount: number } };
assert.equal(order.quote.totalAmount, 369_200);

const paymentResponse = await app.request(`/api/test-only/sandbox/orders/${order.id}/complete`, { method: "POST" });
assert.equal(paymentResponse.status, 200);
const payment = await paymentResponse.json() as { order: { status: string }; session: { provider: string } };
assert.equal(payment.order.status, "active");

const summary = await (await app.request("/api/account/summary")).json() as { subscriptions: { weekly: number; monthly: number } };
assert.deepEqual(summary.subscriptions, { weekly: 2, monthly: 1, total: 3 });

const reconciliation = await (await app.request("/api/operations/reconciliation", {
  headers: { "x-demo-operator-key": "demo-operator-local-only" },
})).json() as { balanced: boolean };
assert.equal(reconciliation.balanced, true);

console.log(`Orden ${order.id}: ${order.quote.totalAmount} centavos`);
console.log(`Proveedor: ${payment.session.provider}; estado: ${payment.order.status}`);
console.log(`Suscripciones: ${summary.subscriptions.weekly} semanales, ${summary.subscriptions.monthly} mensual`);
console.log("Conciliacion: balanceada");
