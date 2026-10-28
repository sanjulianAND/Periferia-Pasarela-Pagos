import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

export type Plan = "week" | "month";

export interface CatalogPrice {
  readonly plan: Plan;
  readonly unitAmount: number;
  readonly currency: "USD";
}

export interface WorkerProduct {
  readonly id: string;
  readonly name: string;
  readonly skills: readonly string[];
  readonly monthlyCredits: number;
  readonly prices: readonly CatalogPrice[];
}

export interface Catalog {
  readonly version: string;
  readonly effectiveFrom: string;
  readonly products: readonly WorkerProduct[];
}

const catalogSchema = z.object({
  version: z.string().min(1),
  effectiveFrom: z.iso.datetime(),
  products: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    skills: z.array(z.string().min(1)),
    monthlyCredits: z.number().int().positive(),
    prices: z.array(z.object({
      plan: z.enum(["week", "month"]),
      unitAmount: z.number().int().positive(),
      currency: z.literal("USD"),
    })).length(2),
  })).min(1),
});

export function loadCatalog(path = process.env.CATALOG_PATH ?? resolve("data/catalog.json")): Catalog {
  return catalogSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export const catalog = loadCatalog();
