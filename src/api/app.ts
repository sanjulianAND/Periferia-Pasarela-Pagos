import { cors } from "hono/cors";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";

import { catalog } from "../domain/catalog.js";
import { calculateQuote, CheckoutError, quoteRequestSchema } from "../domain/checkout.js";
import { InMemoryOrderStore } from "../domain/orders.js";

interface AppOptions {
  store?: InMemoryOrderStore;
  resolveAccount?: (requestedAccount: string | undefined) => string | undefined;
}

export function createApp(options: AppOptions = {}): Hono {
  const store = options.store ?? new InMemoryOrderStore();
  const resolveAccount = options.resolveAccount ?? (() => process.env.DEMO_ACCOUNT_ID ?? "account-demo");
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
