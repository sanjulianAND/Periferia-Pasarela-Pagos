import { createHmac, timingSafeEqual } from "node:crypto";

import { CheckoutError } from "../domain/checkout.js";
import type { CheckoutSession, CheckoutSessionRequest, PaymentProvider, ProviderEvent, ProviderEventType, ProviderTransaction } from "./provider.js";

interface SandboxSession extends CheckoutSessionRequest { status: "pending" | "paid" | "refunded"; }

export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = "sandbox";
  readonly #sessions = new Map<string, SandboxSession>();
  readonly #refunds = new Map<string, string>();
  #refundFailures = 0;

  constructor(private readonly webhookSecret: string, private readonly toleranceSeconds = 300) {
    if (webhookSecret.length < 16) throw new Error("Sandbox webhook secret must contain at least 16 characters");
  }

  async createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession> {
    const existing = [...this.#sessions.entries()].find(([, value]) => value.paymentId === request.paymentId);
    const id = existing?.[0] ?? `sbx_${crypto.randomUUID()}`;
    if (!existing) this.#sessions.set(id, { ...request, status: "pending" });
    return { id, provider: this.name, checkoutUrl: `/api/test-only/sandbox/checkout-sessions/${id}`, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
  }

  failNextRefund(count = 1): void { this.#refundFailures = count; }

  verifyWebhook(rawBody: string, signature: string, now = new Date()): ProviderEvent {
    const fields = Object.fromEntries(signature.split(",").map((part) => part.split("=", 2)));
    const timestamp = Number(fields.t);
    if (!Number.isInteger(timestamp) || !fields.v1 || Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > this.toleranceSeconds) {
      throw new CheckoutError("INVALID_WEBHOOK_SIGNATURE", "Firma de webhook invalida o vencida");
    }
    const expected = createHmac("sha256", this.webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
    const actualBuffer = Buffer.from(fields.v1, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
      throw new CheckoutError("INVALID_WEBHOOK_SIGNATURE", "Firma de webhook invalida o vencida");
    }
    let event: unknown;
    try { event = JSON.parse(rawBody); } catch { throw new CheckoutError("INVALID_WEBHOOK", "Evento de webhook invalido"); }
    if (!isProviderEvent(event)) throw new CheckoutError("INVALID_WEBHOOK", "Evento de webhook invalido");
    return event;
  }

  createSignedEvent(sessionId: string, type: ProviderEventType, now = new Date(), eventId = `evt_${crypto.randomUUID()}`): { rawBody: string; signature: string } {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new CheckoutError("SESSION_NOT_FOUND", "Sesion sandbox no encontrada");
    if (type === "payment.succeeded") session.status = "paid";
    if (type === "payment.refunded") session.status = "refunded";
    const event: ProviderEvent = { id: eventId, type, occurredAt: now.toISOString(), sessionId, orderId: session.orderId, accountId: session.accountId, paymentId: session.paymentId, amount: session.amount, currency: session.currency };
    const rawBody = JSON.stringify(event);
    const timestamp = Math.floor(now.getTime() / 1000);
    return { rawBody, signature: `t=${timestamp},v1=${createHmac("sha256", this.webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex")}` };
  }

  async refund(sessionId: string, idempotencyKey: string): Promise<{ readonly occurredAt: string }> {
    const previousSession = this.#refunds.get(idempotencyKey);
    if (previousSession && previousSession !== sessionId) throw new CheckoutError("REFUND_IDEMPOTENCY_CONFLICT", "La clave de reembolso ya fue utilizada");
    const session = this.#sessions.get(sessionId);
    if (!session || session.status === "pending") throw new CheckoutError("PAYMENT_NOT_REFUNDABLE", "El pago no se puede reembolsar");
    if (this.#refundFailures > 0) {
      this.#refundFailures -= 1;
      throw new CheckoutError("PROVIDER_UNAVAILABLE", "El proveedor sandbox no esta disponible");
    }
    session.status = "refunded";
    this.#refunds.set(idempotencyKey, sessionId);
    return { occurredAt: new Date().toISOString() };
  }

  async listTransactions(): Promise<readonly ProviderTransaction[]> {
    return [...this.#sessions.entries()].map(([sessionId, session]) => ({ sessionId, status: session.status, amount: session.amount, currency: session.currency }));
  }
}

function isProviderEvent(value: unknown): value is ProviderEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === "string" && ["payment.processing", "payment.succeeded", "payment.refunded"].includes(String(event.type))
    && typeof event.occurredAt === "string" && !Number.isNaN(Date.parse(event.occurredAt))
    && ["sessionId", "orderId", "accountId", "paymentId"].every((key) => typeof event[key] === "string")
    && Number.isInteger(event.amount) && event.amount as number > 0 && event.currency === "USD";
}
