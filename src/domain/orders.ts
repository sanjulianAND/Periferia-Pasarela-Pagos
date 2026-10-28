import type { Quote, QuoteRequest } from "./checkout.js";
import { CheckoutError } from "./checkout.js";

export interface Order {
  readonly id: string;
  readonly accountId: string;
  readonly status: "pending_payment";
  readonly quote: Quote;
  readonly request: QuoteRequest;
  readonly createdAt: string;
}

export class InMemoryOrderStore {
  readonly #orders = new Map<string, Order>();
  readonly #idempotency = new Map<string, { request: string; order: Order }>();

  create(accountId: string, idempotencyKey: string, request: QuoteRequest, quote: Quote): Order {
    const key = `${accountId}:${idempotencyKey}`;
    const serializedRequest = JSON.stringify(request);
    const existing = this.#idempotency.get(key);
    if (existing?.request === serializedRequest) return existing.order;
    if (existing) throw new CheckoutError("IDEMPOTENCY_CONFLICT", "La clave ya fue usada para otra solicitud");

    const order: Order = {
      id: crypto.randomUUID(),
      accountId,
      status: "pending_payment",
      quote,
      request,
      createdAt: new Date().toISOString(),
    };
    this.#orders.set(order.id, order);
    this.#idempotency.set(key, { request: serializedRequest, order });
    return order;
  }

  findForAccount(id: string, accountId: string): Order | undefined {
    const order = this.#orders.get(id);
    return order?.accountId === accountId ? order : undefined;
  }
}
