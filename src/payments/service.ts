import { CheckoutError } from "../domain/checkout.js";
import type { Order } from "../domain/orders.js";
import { InMemoryOrderStore } from "../domain/orders.js";
import type { CheckoutSession, PaymentProvider } from "./provider.js";

interface ActivationInput { readonly activationKey: string; readonly accountId: string; readonly productId: string; readonly plan: "week" | "month" }
export interface WorkerActivator {
  activate(input: ActivationInput): Promise<void>;
  deactivate(input: ActivationInput): Promise<void>;
}

export class InMemoryWorkerActivator implements WorkerActivator {
  readonly #activated = new Set<string>();
  readonly #failures = new Map<string, number>();
  readonly #deactivationFailures = new Map<string, number>();

  failNext(activationKeyOrOrderId: string, count = 1): void { this.#failures.set(activationKeyOrOrderId, count); }
  failNextDeactivation(activationKey: string, count = 1): void { this.#deactivationFailures.set(activationKey, count); }

  async activate(input: { readonly activationKey: string; readonly accountId: string; readonly productId: string; readonly plan: "week" | "month" }): Promise<void> {
    if (this.#activated.has(input.activationKey)) return;
    const orderId = input.activationKey.split(":", 1)[0] ?? "";
    const failureKey = this.#failures.has(input.activationKey) ? input.activationKey : orderId;
    const remaining = this.#failures.get(failureKey) ?? 0;
    if (remaining > 0) {
      this.#failures.set(failureKey, remaining - 1);
      throw new Error(`Deterministic activation failure for ${failureKey}`);
    }
    this.#activated.add(input.activationKey);
  }

  async deactivate(input: ActivationInput): Promise<void> {
    const remaining = this.#deactivationFailures.get(input.activationKey) ?? 0;
    if (remaining > 0) {
      this.#deactivationFailures.set(input.activationKey, remaining - 1);
      throw new CheckoutError("DEACTIVATION_FAILED", "No fue posible desactivar el worker");
    }
    this.#activated.delete(input.activationKey);
  }
}

export class PaymentService {
  readonly #orderOperations = new Map<string, Promise<unknown>>();

  constructor(readonly store: InMemoryOrderStore, readonly provider: PaymentProvider, readonly activator: WorkerActivator) {}

  async createCheckout(accountId: string, orderId: string): Promise<CheckoutSession> {
    const order = this.orderForAccount(orderId, accountId);
    if (order.status !== "pending_payment" && order.status !== "payment_processing") throw new CheckoutError("ORDER_NOT_PAYABLE", "La orden no admite un nuevo checkout");
    const payment = this.store.createPayment(order, this.provider.name);
    const session = await this.provider.createCheckoutSession({ orderId, accountId, paymentId: payment.id, amount: payment.amount, currency: payment.currency });
    this.store.attachSession(payment, session.id);
    return session;
  }

  async handleWebhook(rawBody: string, signature: string): Promise<{ duplicate: boolean }> {
    const event = this.provider.verifyWebhook(rawBody, signature);
    const payment = this.store.paymentForSession(event.sessionId);
    const order = payment && this.store.find(payment.orderId);
    if (!payment || !order || payment.id !== event.paymentId || order.id !== event.orderId || order.accountId !== event.accountId || payment.amount !== event.amount || payment.currency !== event.currency) {
      throw new CheckoutError("WEBHOOK_MISMATCH", "El evento no coincide con el pago registrado");
    }
    const claim = this.store.claimEvent(event.id);
    if (claim === "processed") return { duplicate: true };
    if (claim === "processing") throw new CheckoutError("EVENT_IN_PROGRESS", "El evento ya se esta procesando");
    try {
      if (event.type === "payment.processing") this.store.markProcessing(order, payment, event.occurredAt);
      if (event.type === "payment.succeeded" && this.store.markPaid(order, payment, event.occurredAt)) {
        await this.withOrderLock(order.id, () => this.activate(order));
      }
      if (event.type === "payment.refunded") {
        await this.withOrderLock(order.id, async () => {
          this.store.markCompensating(order, payment);
          await this.deactivate(order);
          this.store.markRefunded(order, payment, event.occurredAt);
        });
      }
      this.store.completeEvent(event.id);
    } catch (error) {
      this.store.releaseEvent(event.id);
      throw error;
    }
    return { duplicate: false };
  }

  async retryActivation(accountId: string, orderId: string): Promise<Order> {
    const order = this.orderForAccount(orderId, accountId);
    return this.withOrderLock(order.id, async () => {
      if (order.status === "active") return order;
      if (order.status !== "activation_pending") throw new CheckoutError("ACTIVATION_NOT_RETRYABLE", "La activacion no se puede reintentar");
      await this.activate(order);
      return order;
    });
  }

  async compensate(accountId: string, orderId: string): Promise<Order> {
    const order = this.orderForAccount(orderId, accountId);
    return this.withOrderLock(order.id, async () => {
      if (order.status === "refunded") return order;
      if (order.status !== "active" && order.status !== "activation_pending" && order.status !== "compensating") throw new CheckoutError("PAYMENT_NOT_REFUNDABLE", "La orden no se puede reembolsar");
      const payment = this.store.paymentForOrder(order.id);
      if (!payment || (payment.status !== "paid" && payment.status !== "refunding")) throw new CheckoutError("PAYMENT_NOT_REFUNDABLE", "El pago no se puede reembolsar");
      this.store.markCompensating(order, payment);
      const result = await this.provider.refund(payment.providerSessionId, `refund:${payment.id}`);
      await this.deactivate(order);
      this.store.markRefunded(order, payment, result.occurredAt);
      return order;
    });
  }

  async reconciliation(): Promise<object> {
    const providerTransactions = await this.provider.listTransactions();
    const localBySession = new Map(this.store.payments().map((payment) => [payment.providerSessionId, payment]));
    const issues: object[] = [];
    for (const remote of providerTransactions) {
      const local = localBySession.get(remote.sessionId);
      if (!local) issues.push({ type: "provider_only", sessionId: remote.sessionId });
      else if (remote.status !== localStatus(local.status) || remote.amount !== local.amount || remote.currency !== local.currency) issues.push({ type: "status_or_amount_mismatch", sessionId: remote.sessionId, providerStatus: remote.status, localStatus: local.status });
    }
    for (const payment of this.store.payments()) if (!providerTransactions.some((item) => item.sessionId === payment.providerSessionId)) issues.push({ type: "local_only", paymentId: payment.id });
    return { generatedAt: new Date().toISOString(), provider: this.provider.name, checked: providerTransactions.length, issues, balanced: issues.length === 0 };
  }

  private async activate(order: Order): Promise<void> {
    if (order.status !== "activation_pending") return;
    try {
      for (const line of order.quote.lines) {
        for (let unit = 1; unit <= line.quantity; unit += 1) {
          if (order.status !== "activation_pending") return;
          const activationKey = `${order.id}:${line.productId}:${line.plan}:${unit}`;
          if (this.store.subscription(activationKey)) continue;
          const activation = { activationKey, accountId: order.accountId, productId: line.productId, plan: line.plan } as const;
          await this.activator.activate(activation);
          if (order.status !== "activation_pending") {
            await this.activator.deactivate(activation);
            return;
          }
          this.store.addSubscription(order, line.productId, line.plan, unit, activationKey);
        }
      }
      if (order.status === "activation_pending") this.store.markActive(order);
    } catch (error) {
      if (order.status === "activation_pending") this.store.markActivationFailed(order, error instanceof Error ? error.message : "Activation failed");
    }
  }

  private async deactivate(order: Order): Promise<void> {
    for (const subscription of this.store.subscriptionsForOrder(order.id)) {
      await this.activator.deactivate({ activationKey: subscription.activationKey, accountId: order.accountId, productId: subscription.productId, plan: subscription.plan });
    }
  }

  private async withOrderLock<T>(orderId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#orderOperations.get(orderId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#orderOperations.set(orderId, current);
    try {
      return await current;
    } finally {
      if (this.#orderOperations.get(orderId) === current) this.#orderOperations.delete(orderId);
    }
  }

  private orderForAccount(orderId: string, accountId: string): Order {
    const order = this.store.findForAccount(orderId, accountId);
    if (!order) throw new CheckoutError("ORDER_NOT_FOUND", "Orden no encontrada");
    return order;
  }
}

function localStatus(status: string): "pending" | "paid" | "refunded" {
  if (status === "paid" || status === "refunding") return "paid";
  if (status === "refunded") return "refunded";
  return "pending";
}
