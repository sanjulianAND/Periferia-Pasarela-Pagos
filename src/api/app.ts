import { cors } from "hono/cors";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";

import { catalog } from "../domain/catalog.js";
import { calculateQuote, CheckoutError, quoteRequestSchema } from "../domain/checkout.js";
import { InMemoryOrderStore } from "../domain/orders.js";
import type { PaymentProvider, ProviderEventType } from "../payments/provider.js";
import { SandboxPaymentProvider } from "../payments/sandbox-provider.js";
import { InMemoryWorkerActivator, PaymentService, type WorkerActivator } from "../payments/service.js";

export interface AppOptions {
  store?: InMemoryOrderStore;
  resolveAccount?: (requestedAccount: string | undefined) => string | undefined;
  provider?: PaymentProvider;
  activator?: WorkerActivator;
  operatorKey?: string;
  enableSandboxDemo?: boolean;
}

export function createApp(options: AppOptions = {}): Hono {
  const store = options.store ?? new InMemoryOrderStore();
  const resolveAccount = options.resolveAccount ?? (() => process.env.DEMO_ACCOUNT_ID ?? "account-demo");
  const production = process.env.NODE_ENV === "production";
  const provider = options.provider ?? new SandboxPaymentProvider(process.env.SANDBOX_WEBHOOK_SECRET ?? (production ? `disabled-${crypto.randomUUID()}` : "demo-only-not-a-real-secret"));
  const activator = options.activator ?? new InMemoryWorkerActivator();
  const payments = new PaymentService(store, provider, activator);
  const operatorKey = options.operatorKey ?? process.env.DEMO_OPERATOR_KEY ?? (production ? `disabled-${crypto.randomUUID()}` : "demo-operator-local-only");
  const sandboxDemoEnabled = options.enableSandboxDemo ?? (process.env.ENABLE_SANDBOX_DEMO === "true" || !production);
  const app = new Hono();
  app.use("*", secureHeaders());
  app.use("/api/*", cors({ origin: ["http://localhost:5173"] }));

  app.get("/api/health", (context) => context.json({ ok: true, service: "perxia-checkout" }));
  app.get("/api/catalog", (context) => context.json(catalog));

  app.post("/api/quotes", async (context) => {
    const accountId = accountFrom(resolveAccount(context.req.header("x-account-id")));
    const request = quoteRequestSchema.parse(await context.req.json());
    return context.json({ accountId, quote: calculateQuote(request, catalog) });
  });

  app.post("/api/orders", async (context) => {
    const accountId = accountFrom(resolveAccount(context.req.header("x-account-id")));
    const idempotencyKey = idempotencyKeyFrom(context.req.header("idempotency-key"));
    const request = quoteRequestSchema.parse(await context.req.json());
    const quote = calculateQuote(request, catalog);
    return context.json(store.create(accountId, idempotencyKey, request, quote), 201);
  });

  app.get("/api/orders/:id", (context) => {
    const accountId = accountFrom(resolveAccount(context.req.header("x-account-id")));
    const order = store.findForAccount(context.req.param("id"), accountId);
    return order ? context.json(order) : context.json({ error: { code: "NOT_FOUND", message: "Orden no encontrada" } }, 404);
  });

  app.post("/api/orders/:id/checkout-session", async (context) => {
    const accountId = accountFrom(resolveAccount(context.req.header("x-account-id")));
    return context.json(await payments.createCheckout(accountId, context.req.param("id")), 201);
  });

  app.post("/api/test-only/sandbox/checkout-sessions/:id/confirm", async (context) => {
    if (!sandboxDemoEnabled) throw new CheckoutError("SANDBOX_DEMO_DISABLED", "La demostracion sandbox esta deshabilitada");
    requireOperator(context.req.header("x-demo-operator-key"), operatorKey);
    if (!(provider instanceof SandboxPaymentProvider)) throw new CheckoutError("NOT_SANDBOX", "El proveedor configurado no es sandbox");
    const request = await optionalJson(context.req.raw);
    const type = typeof request.type === "string" ? request.type : "payment.succeeded";
    if (!["payment.processing", "payment.succeeded", "payment.refunded"].includes(type)) throw new CheckoutError("INVALID_EVENT_TYPE", "Tipo de evento sandbox invalido");
    const fixture = provider.createSignedEvent(context.req.param("id"), type as ProviderEventType, new Date(), typeof request.eventId === "string" ? request.eventId : undefined);
    return context.json({ testOnly: true, webhookPath: "/api/payments/webhooks/sandbox", ...fixture });
  });

  app.post("/api/test-only/sandbox/orders/:id/complete", async (context) => {
    if (!sandboxDemoEnabled) throw new CheckoutError("SANDBOX_DEMO_DISABLED", "La demostracion sandbox esta deshabilitada");
    if (!(provider instanceof SandboxPaymentProvider)) throw new CheckoutError("NOT_SANDBOX", "El proveedor configurado no es sandbox");
    const accountId = accountFrom(resolveAccount(context.req.header("x-account-id")));
    const session = await payments.createCheckout(accountId, context.req.param("id"));
    const fixture = provider.createSignedEvent(session.id, "payment.succeeded");
    await payments.handleWebhook(fixture.rawBody, fixture.signature);
    const order = store.findForAccount(context.req.param("id"), accountId);
    if (!order) throw new CheckoutError("ORDER_NOT_FOUND", "Orden no encontrada");
    return context.json({ testOnly: true, order, session });
  });

  app.post("/api/payments/webhooks/sandbox", async (context) => {
    const rawBody = await context.req.text();
    const signature = context.req.header("sandbox-signature") ?? "";
    return context.json({ received: true, ...await payments.handleWebhook(rawBody, signature) });
  });

  app.get("/api/account/summary", (context) => {
    const accountId = accountFrom(resolveAccount(context.req.header("x-account-id")));
    return context.json(store.summary(accountId));
  });

  app.post("/api/operations/orders/:id/retry-activation", async (context) => {
    requireOperator(context.req.header("x-demo-operator-key"), operatorKey);
    const accountId = accountFrom(resolveAccount(context.req.header("x-account-id")));
    return context.json(await payments.retryActivation(accountId, context.req.param("id")));
  });

  app.post("/api/operations/orders/:id/refund", async (context) => {
    requireOperator(context.req.header("x-demo-operator-key"), operatorKey);
    const accountId = accountFrom(resolveAccount(context.req.header("x-account-id")));
    return context.json(await payments.compensate(accountId, context.req.param("id")));
  });

  app.get("/api/operations/reconciliation", async (context) => {
    requireOperator(context.req.header("x-demo-operator-key"), operatorKey);
    return context.json(await payments.reconciliation());
  });

  app.all("/api/*", (context) => context.json({ error: { code: "NOT_FOUND", message: "Ruta no encontrada" } }, 404));

  app.onError((error, context) => {
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return context.json({ error: { code: "INVALID_REQUEST", message: "La solicitud no es valida" } }, 400);
    }
    if (error instanceof CheckoutError) {
      return context.json({ error: { code: error.code, message: error.message } }, 422);
    }
    if (error instanceof UnauthorizedError) {
      return context.json({ error: { code: "UNAUTHORIZED", message: "No fue posible resolver la cuenta" } }, 401);
    }
    if (error instanceof OperatorUnauthorizedError) {
      return context.json({ error: { code: "OPERATOR_UNAUTHORIZED", message: "Operacion no autorizada" } }, 403);
    }
    console.error("Unhandled checkout error", error);
    return context.json({ error: { code: "INTERNAL_ERROR", message: "No fue posible procesar la solicitud" } }, 500);
  });

  return app;
}

function accountFrom(value: string | undefined): string {
  if (!value || !/^[a-zA-Z0-9_-]{3,80}$/.test(value)) throw new UnauthorizedError();
  return value;
}

function idempotencyKeyFrom(value: string | undefined): string {
  if (!value || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) {
    throw new CheckoutError("INVALID_IDEMPOTENCY_KEY", "La clave de idempotencia no es valida");
  }
  return value;
}

class UnauthorizedError extends Error {}
class OperatorUnauthorizedError extends Error {}

function requireOperator(value: string | undefined, expected: string): void {
  if (!value || value !== expected) throw new OperatorUnauthorizedError();
}

async function optionalJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.text();
  if (!body) return {};
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Expected object");
  return value as Record<string, unknown>;
}
