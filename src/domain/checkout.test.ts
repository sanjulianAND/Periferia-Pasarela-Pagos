import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { catalog } from "./catalog.js";
import { calculateQuote, CheckoutError } from "./checkout.js";

describe("calculateQuote", () => {
  it("calcula pedidos mixtos en centavos con precios del catalogo", () => {
    const quote = calculateQuote({ items: [
      { productId: "software-design", plan: "week", quantity: 2 },
      { productId: "quality", plan: "month", quantity: 1 },
    ] }, catalog);

    assert.equal(quote.totalAmount, 334_600);
    assert.equal(quote.currency, "USD");
    assert.equal(quote.catalogVersion, "2026-10-14");
  });

  it("rechaza productos inexistentes y lineas repetidas", () => {
    assert.throws(() => calculateQuote({ items: [{ productId: "missing", plan: "month", quantity: 1 }] }, catalog), CheckoutError);
    assert.throws(() => calculateQuote({ items: [
      { productId: "quality", plan: "month", quantity: 1 },
      { productId: "quality", plan: "month", quantity: 2 },
    ] }, catalog), /linea repetida/);
  });
});
