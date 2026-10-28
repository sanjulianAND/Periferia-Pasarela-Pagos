import type { Quote, QuoteRequest } from "./checkout.js";
import { CheckoutError } from "./checkout.js";

export type OrderStatus =
  | "pending_payment"
  | "payment_processing"
  | "activation_pending"
  | "active"
  | "compensating"
  | "refunded";

export type PaymentStatus = "pending" | "processing" | "paid" | "refunding" | "refunded";

export interface Order {
  readonly id: string;
  readonly accountId: string;
  status: OrderStatus;
  readonly quote: Quote;
  readonly request: QuoteRequest;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Payment {
  readonly id: string;
  readonly orderId: string;
  readonly accountId: string;
  readonly provider: string;
  providerSessionId: string;
  status: PaymentStatus;
  readonly amount: number;
  readonly currency: "USD";
  lastEventAt?: string;
}

export interface Subscription {
  readonly id: string;
  readonly activationKey: string;
  readonly accountId: string;
  readonly orderId: string;
  readonly productId: string;
  readonly plan: "week" | "month";
  readonly interval: "weekly" | "monthly";
  readonly unit: number;
  readonly status: "active" | "refunded";
  readonly activatedAt: string;
}

export interface AuditRecord {
  readonly id: string;
  readonly accountId: string;
  readonly orderId: string;
  readonly action: string;
  readonly at: string;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export class InMemoryOrderStore {
  readonly #orders = new Map<string, Order>();
  readonly #idempotency = new Map<string, { request: string; order: Order }>();
  readonly #payments = new Map<string, Payment>();
  readonly #paymentBySession = new Map<string, string>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #events = new Map<string, "processing" | "processed">();
  readonly #audit: AuditRecord[] = [];

  create(accountId: string, idempotencyKey: string, request: QuoteRequest, quote: Quote): Order {
    const key = `${accountId}:${idempotencyKey}`;
    const serializedRequest = JSON.stringify(request);
    const existing = this.#idempotency.get(key);
    if (existing?.request === serializedRequest) return existing.order;
    if (existing) throw new CheckoutError("IDEMPOTENCY_CONFLICT", "La clave ya fue usada para otra solicitud");

    const now = new Date().toISOString();
    const order: Order = {
      id: crypto.randomUUID(), accountId, status: "pending_payment", quote, request, createdAt: now, updatedAt: now,
    };
    this.#orders.set(order.id, order);
    this.#idempotency.set(key, { request: serializedRequest, order });
    this.audit(order, "order.created", {});
    return order;
  }

  findForAccount(id: string, accountId: string): Order | undefined {
    const order = this.#orders.get(id);
    return order?.accountId === accountId ? order : undefined;
  }

  find(id: string): Order | undefined { return this.#orders.get(id); }

  createPayment(order: Order, provider: string): Payment {
    const existing = [...this.#payments.values()].find((payment) => payment.orderId === order.id);
    if (existing) return existing;
    const payment: Payment = {
      id: crypto.randomUUID(), orderId: order.id, accountId: order.accountId, provider,
      providerSessionId: "", status: "pending", amount: order.quote.totalAmount, currency: order.quote.currency,
    };
    this.#payments.set(payment.id, payment);
    this.audit(order, "payment.created", { paymentId: payment.id, provider });
    return payment;
  }

  attachSession(payment: Payment, sessionId: string): void {
    if (payment.providerSessionId && payment.providerSessionId !== sessionId) {
      throw new CheckoutError("PAYMENT_SESSION_CONFLICT", "El pago ya tiene una sesion distinta");
    }
    payment.providerSessionId = sessionId;
    this.#paymentBySession.set(sessionId, payment.id);
  }

  paymentForSession(sessionId: string): Payment | undefined {
    const id = this.#paymentBySession.get(sessionId);
    return id ? this.#payments.get(id) : undefined;
  }

  paymentForOrder(orderId: string): Payment | undefined {
    return [...this.#payments.values()].find((payment) => payment.orderId === orderId);
  }

  claimEvent(eventId: string): "claimed" | "processing" | "processed" {
    const state = this.#events.get(eventId);
    if (state) return state;
    this.#events.set(eventId, "processing");
    return "claimed";
  }

  completeEvent(eventId: string): void { this.#events.set(eventId, "processed"); }
  releaseEvent(eventId: string): void { if (this.#events.get(eventId) === "processing") this.#events.delete(eventId); }

  markProcessing(order: Order, payment: Payment, occurredAt: string): void {
    if (payment.status !== "pending" || order.status !== "pending_payment") return;
    payment.status = "processing";
    payment.lastEventAt = occurredAt;
    this.setStatus(order, "payment_processing", "payment.processing", {});
  }

  markPaid(order: Order, payment: Payment, occurredAt: string): boolean {
    if (payment.status === "refunded" || payment.status === "refunding") return false;
    if (payment.status === "paid" || order.status === "active" || order.status === "activation_pending") return false;
    payment.status = "paid";
    payment.lastEventAt = occurredAt;
    this.setStatus(order, "activation_pending", "payment.succeeded", {});
    return true;
  }

  markCompensating(order: Order, payment: Payment): void {
    if (order.status === "refunded" || order.status === "compensating") return;
    payment.status = "refunding";
    this.setStatus(order, "compensating", "refund.requested", {});
  }

  markRefunded(order: Order, payment: Payment, occurredAt: string): void {
    if (order.status === "refunded") return;
    payment.status = "refunded";
    payment.lastEventAt = occurredAt;
    for (const [key, subscription] of this.#subscriptions) {
      if (subscription.orderId === order.id && subscription.status === "active") {
        this.#subscriptions.set(key, { ...subscription, status: "refunded" });
      }
    }
    this.setStatus(order, "refunded", "payment.refunded", {});
  }

  subscription(activationKey: string): Subscription | undefined { return this.#subscriptions.get(activationKey); }

  addSubscription(order: Order, productId: string, plan: "week" | "month", unit: number, activationKey: string): void {
    if (order.status !== "activation_pending" || this.#subscriptions.has(activationKey)) return;
    this.#subscriptions.set(activationKey, {
      id: crypto.randomUUID(), activationKey, accountId: order.accountId, orderId: order.id,
      productId, plan, interval: plan === "week" ? "weekly" : "monthly", unit,
      status: "active", activatedAt: new Date().toISOString(),
    });
    this.audit(order, "subscription.activated", { activationKey, plan, productId });
  }

  markActivationFailed(order: Order, message: string): void {
    if (order.status === "activation_pending") this.setStatus(order, "activation_pending", "activation.failed", { message });
  }

  markActive(order: Order): void {
    if (order.status === "activation_pending") this.setStatus(order, "active", "activation.completed", {});
  }

  summary(accountId: string): object {
    const orders = [...this.#orders.values()].filter((order) => order.accountId === accountId);
    const subscriptions = [...this.#subscriptions.values()].filter((item) => item.accountId === accountId && item.status === "active");
    return {
      accountId,
      orders: { total: orders.length, active: orders.filter((item) => item.status === "active").length, pending: orders.filter((item) => item.status !== "active" && item.status !== "refunded").length, refunded: orders.filter((item) => item.status === "refunded").length },
      subscriptions: { weekly: subscriptions.filter((item) => item.interval === "weekly").length, monthly: subscriptions.filter((item) => item.interval === "monthly").length, total: subscriptions.length },
    };
  }

  orders(): readonly Order[] { return [...this.#orders.values()]; }
  payments(): readonly Payment[] { return [...this.#payments.values()]; }
  subscriptionsForOrder(orderId: string): readonly Subscription[] { return [...this.#subscriptions.values()].filter((item) => item.orderId === orderId); }
  auditRecords(accountId: string): readonly AuditRecord[] { return this.#audit.filter((record) => record.accountId === accountId).map((record) => ({ ...record, details: { ...record.details } })); }

  private setStatus(order: Order, status: OrderStatus, action: string, details: AuditRecord["details"]): void {
    order.status = status;
    order.updatedAt = new Date().toISOString();
    this.audit(order, action, details);
  }

  private audit(order: Order, action: string, details: AuditRecord["details"]): void {
    this.#audit.push(Object.freeze({ id: crypto.randomUUID(), accountId: order.accountId, orderId: order.id, action, at: new Date().toISOString(), details: Object.freeze({ ...details }) }));
  }
}
