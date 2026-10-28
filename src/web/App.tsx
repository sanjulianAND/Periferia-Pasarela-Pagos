import { useEffect, useRef, useState } from "react";

import type { Catalog, Plan } from "../domain/catalog.js";
import type { Quote } from "../domain/checkout.js";

type Language = "es" | "en" | "pt-BR";
type Selection = Record<string, { quantity: number; plan: Plan }>;

const copy = {
  es: { eyebrow: "Equipos aumentados por IA", title: "Arma tu capacidad de trabajo", intro: "Selecciona los workers que tu equipo necesita. El servidor valida cada precio antes de crear la orden.", week: "Semana", month: "Mes", credits: "M creditos al mes", summary: "Resumen", empty: "Selecciona al menos un worker", today: "Total de hoy", create: "Crear orden", pending: "Calculando...", created: "Orden creada", safe: "Esta demostracion no solicita datos de tarjeta.", catalogError: "No fue posible cargar el catalogo.", quoteError: "No fue posible calcular el pedido.", orderError: "No fue posible crear la orden.", decrease: "Disminuir cantidad", increase: "Aumentar cantidad", language: "Idioma" },
  en: { eyebrow: "AI-augmented teams", title: "Build your working capacity", intro: "Choose the workers your team needs. The server validates every price before creating the order.", week: "Week", month: "Month", credits: "M credits per month", summary: "Summary", empty: "Select at least one worker", today: "Due today", create: "Create order", pending: "Calculating...", created: "Order created", safe: "This demo never asks for card details.", catalogError: "The catalog could not be loaded.", quoteError: "The order could not be calculated.", orderError: "The order could not be created.", decrease: "Decrease quantity", increase: "Increase quantity", language: "Language" },
  "pt-BR": { eyebrow: "Equipes ampliadas por IA", title: "Monte sua capacidade de trabalho", intro: "Escolha os workers que sua equipe precisa. O servidor valida cada preco antes de criar o pedido.", week: "Semana", month: "Mes", credits: "M creditos por mes", summary: "Resumo", empty: "Selecione pelo menos um worker", today: "Total de hoje", create: "Criar pedido", pending: "Calculando...", created: "Pedido criado", safe: "Esta demonstracao nao solicita dados do cartao.", catalogError: "Nao foi possivel carregar o catalogo.", quoteError: "Nao foi possivel calcular o pedido.", orderError: "Nao foi possivel criar o pedido.", decrease: "Diminuir quantidade", increase: "Aumentar quantidade", language: "Idioma" },
} as const;

const productCopy: Record<Language, Record<string, { name: string; skills: string }>> = {
  es: {
    "software-design": { name: "Diseno de software", skills: "Discovery / HU / Estimacion / Design System" },
    "software-construction": { name: "Construccion de software", skills: "Arquitectura / Onboarding / Planificacion / Implementacion" },
    quality: { name: "Calidad", skills: "Validacion / QE" }, infrastructure: { name: "Infraestructura", skills: "IaC" }, cybersecurity: { name: "Ciberseguridad", skills: "Ciberseguridad" },
  },
  en: {
    "software-design": { name: "Software design", skills: "Discovery / User stories / Estimation / Design system" },
    "software-construction": { name: "Software construction", skills: "Architecture / Onboarding / Planning / Implementation" },
    quality: { name: "Quality", skills: "Validation / Quality engineering" }, infrastructure: { name: "Infrastructure", skills: "Infrastructure as code" }, cybersecurity: { name: "Cybersecurity", skills: "Cybersecurity" },
  },
  "pt-BR": {
    "software-design": { name: "Design de software", skills: "Discovery / Historias / Estimativa / Design system" },
    "software-construction": { name: "Construcao de software", skills: "Arquitetura / Onboarding / Planejamento / Implementacao" },
    quality: { name: "Qualidade", skills: "Validacao / Engenharia de qualidade" }, infrastructure: { name: "Infraestrutura", skills: "Infraestrutura como codigo" }, cybersecurity: { name: "Ciberseguranca", skills: "Ciberseguranca" },
  },
};

export function App() {
  const [language, setLanguage] = useState<Language>("es");
  const [catalog, setCatalog] = useState<Catalog>();
  const [selection, setSelection] = useState<Selection>({});
  const [quoted, setQuoted] = useState<{ key: string; quote: Quote }>();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const idempotencyKey = useRef(crypto.randomUUID());
  const text = copy[language];
  const items = selectedItems(selection);
  const itemsKey = JSON.stringify(items);
  const quote = quoted?.key === itemsKey ? quoted.quote : undefined;

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    fetch("/api/catalog").then(async (response) => {
      if (!response.ok) throw new Error("catalog");
      setCatalog(await response.json() as Catalog);
    }).catch(() => setMessage(text.catalogError));
  }, [text.catalogError]);

  useEffect(() => {
    const requestedItems = selectedItems(selection);
    const requestKey = JSON.stringify(requestedItems);
    if (requestedItems.length === 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      fetch("/api/quotes", {
        method: "POST",
        headers: { "content-type": "application/json", "x-account-id": "account-demo" },
        body: JSON.stringify({ items: requestedItems }),
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) throw new Error("quote");
        const result = await response.json() as { quote: Quote };
        setQuoted({ key: requestKey, quote: result.quote });
        setMessage("");
      }).catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setMessage(text.quoteError);
      }).finally(() => setLoading(false));
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [selection, text.quoteError]);

  function update(id: string, patch: Partial<{ quantity: number; plan: Plan }>) {
    setSelection((current) => ({ ...current, [id]: { quantity: current[id]?.quantity ?? 0, plan: current[id]?.plan ?? "month", ...patch } }));
    idempotencyKey.current = crypto.randomUUID();
    setMessage("");
  }

  async function createOrder() {
    if (!quote) return;
    setLoading(true);
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey.current },
        body: JSON.stringify({ items }),
      });
      const result = await response.json() as { id?: string };
      setMessage(response.ok && result.id ? `${text.created}: ${result.id.slice(0, 8)}` : text.orderError);
    } catch {
      setMessage(text.orderError);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <nav><div className="brand"><span className="mark">P</span> PERXIA</div><label><span className="sr-only">{text.language}</span><select value={language} onChange={(event) => setLanguage(event.target.value as Language)}><option value="es">ES</option><option value="en">EN</option><option value="pt-BR">PT</option></select></label></nav>
      <header><p className="eyebrow">{text.eyebrow}</p><h1>{text.title}</h1><p className="lede">{text.intro}</p></header>
      <section className="layout">
        <div className="catalog" aria-label="Worker catalog">
          {!catalog && !message && <p>{text.pending}</p>}
          {catalog?.products.map((product, index) => {
            const selected = selection[product.id] ?? { quantity: 0, plan: "month" as Plan };
            const price = product.prices.find((candidate) => candidate.plan === selected.plan)!;
            const localized = productCopy[language][product.id] ?? { name: product.name, skills: product.skills.join(" / ") };
            return <article className={`card ${selected.quantity ? "active" : ""}`} key={product.id}>
              <div className="card-top"><span className="number">0{index + 1}</span><span className="credits">{product.monthlyCredits / 1_000_000} {text.credits}</span></div>
              <h2>{localized.name}</h2><p className="skills">{localized.skills}</p>
              <div className="controls"><div className="plans"><button className={selected.plan === "week" ? "selected" : ""} onClick={() => update(product.id, { plan: "week" })}>{text.week}</button><button className={selected.plan === "month" ? "selected" : ""} onClick={() => update(product.id, { plan: "month" })}>{text.month}</button></div>
                <label className="quantity"><span className="sr-only">{text.credits}</span><button aria-label={text.decrease} onClick={() => update(product.id, { quantity: Math.max(0, selected.quantity - 1) })}>-</button><output>{selected.quantity}</output><button aria-label={text.increase} onClick={() => update(product.id, { quantity: Math.min(50, selected.quantity + 1) })}>+</button></label></div>
              <p className="price">{money(price.unitAmount, language)} <small>/ {selected.plan === "week" ? text.week.toLowerCase() : text.month.toLowerCase()}</small></p>
            </article>;
          })}
        </div>
        <aside><p className="eyebrow">{text.summary}</p>{quote && items.length > 0 ? <>{quote.lines.map((line) => <div className="line" key={`${line.productId}:${line.plan}`}><span>{line.quantity} x {(productCopy[language][line.productId]?.name ?? line.productName)}</span><strong>{money(line.lineAmount, language)}</strong></div>)}<div className="total"><span>{text.today}</span><strong>{money(quote.totalAmount, language)}</strong></div><button className="primary" disabled={loading} onClick={createOrder}>{loading ? text.pending : text.create}</button></> : <p className="empty">{loading ? text.pending : text.empty}</p>}<p className="safe">{text.safe}</p>{message && <p className="notice" role="status">{message}</p>}</aside>
      </section>
      <footer>Catalog v{catalog?.version ?? "-"} <span>USD</span></footer>
    </main>
  );
}

function money(cents: number, language: Language): string {
  return new Intl.NumberFormat(language, { style: "currency", currency: "USD" }).format(cents / 100);
}

function selectedItems(selection: Selection) {
  return Object.entries(selection)
    .filter(([, value]) => value.quantity > 0)
    .map(([productId, value]) => ({ productId, ...value }));
}
