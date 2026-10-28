export type ProviderEventType = "payment.processing" | "payment.succeeded" | "payment.refunded";

export interface CheckoutSessionRequest {
  readonly orderId: string;
  readonly accountId: string;
  readonly paymentId: string;
  readonly amount: number;
  readonly currency: "USD";
}

export interface CheckoutSession {
  readonly id: string;
  readonly provider: string;
  readonly checkoutUrl: string;
  readonly expiresAt: string;
}

export interface ProviderEvent {
  readonly id: string;
  readonly type: ProviderEventType;
  readonly occurredAt: string;
  readonly sessionId: string;
  readonly orderId: string;
  readonly accountId: string;
  readonly paymentId: string;
  readonly amount: number;
  readonly currency: "USD";
}

export interface ProviderTransaction {
  readonly sessionId: string;
  readonly status: "pending" | "paid" | "refunded";
  readonly amount: number;
  readonly currency: "USD";
}

export interface PaymentProvider {
  readonly name: string;
  createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession>;
  verifyWebhook(rawBody: string, signature: string, now?: Date): ProviderEvent;
  refund(sessionId: string, idempotencyKey: string): Promise<{ readonly occurredAt: string }>;
  listTransactions(): Promise<readonly ProviderTransaction[]>;
}
