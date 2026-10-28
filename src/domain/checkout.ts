import { z } from "zod";

import type { Catalog, Plan } from "./catalog.js";

export const quoteRequestSchema = z.object({
  items: z.array(z.object({
    productId: z.string().min(1),
    plan: z.enum(["week", "month"]),
    quantity: z.number().int().min(1).max(50),
  })).min(1).max(25),
});

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export interface QuoteLine {
  readonly productId: string;
  readonly productName: string;
  readonly plan: Plan;
  readonly quantity: number;
  readonly unitAmount: number;
  readonly lineAmount: number;
}

export interface Quote {
  readonly catalogVersion: string;
  readonly currency: "USD";
  readonly totalAmount: number;
  readonly lines: readonly QuoteLine[];
}

export function calculateQuote(input: QuoteRequest, catalog: Catalog): Quote {
  const seen = new Set<string>();
  const lines = input.items.map((item) => {
    const key = `${item.productId}:${item.plan}`;
    if (seen.has(key)) throw new CheckoutError("DUPLICATE_ITEM", "El pedido contiene una linea repetida");
    seen.add(key);

    const product = catalog.products.find((candidate) => candidate.id === item.productId);
    if (!product) throw new CheckoutError("PRODUCT_NOT_FOUND", "El producto no existe en el catalogo vigente");
    const price = product.prices.find((candidate) => candidate.plan === item.plan);
    if (!price) throw new CheckoutError("PRICE_NOT_FOUND", "El plan no tiene un precio vigente");

    return {
      productId: product.id,
      productName: product.name,
      plan: item.plan,
      quantity: item.quantity,
      unitAmount: price.unitAmount,
      lineAmount: price.unitAmount * item.quantity,
    } satisfies QuoteLine;
  });

  return {
    catalogVersion: catalog.version,
    currency: "USD",
    totalAmount: lines.reduce((total, line) => total + line.lineAmount, 0),
    lines,
  };
}

export class CheckoutError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CheckoutError";
  }
}
