import { useEffect, useRef, useState } from "react";

import type { Catalog, Plan } from "../domain/catalog.js";
import type { Quote } from "../domain/checkout.js";

type Language = "es" | "en" | "pt-BR";
type Selection = Record<string, { quantity: number; plan: Plan }>;
type OrderState = "pending_payment" | "payment_processing" | "activation_pending" | "active" | "compensating" | "refunded";
interface CreatedOrder { id: string; status: OrderState; quote: Quote }
interface AccountSummary { orders: { total: number; active: number; pending: number; refunded: number }; subscriptions: { weekly: number; monthly: number; total: number } }

const copy = {
  es: { eyebrow: "Equipos aumentados por IA", title: "Arma tu capacidad de trabajo", intro: "Selecciona los workers que tu equipo necesita. El servidor valida cada precio antes de crear la orden.", week: "Semana", month: "Mes", credits: "M creditos al mes", summary: "Resumen", empty: "Selecciona al menos un worker", today: "Total de hoy", create: "Crear orden", pay: "Completar pago sandbox", pending: "Procesando...", created: "Orden creada", activated: "Workers activos", account: "Estado de cuenta", safe: "Sandbox local: no solicita datos de tarjeta ni mueve dinero.", catalogError: "No fue posible cargar el catalogo.", quoteError: "No fue posible calcular el pedido.", orderError: "No fue posible procesar la orden.", decrease: "Disminuir cantidad", increase: "Aumentar cantidad", language: "Idioma" },
  en: { eyebrow: "AI-augmented teams", title: "Build your working capacity", intro: "Choose the workers your team needs. The server validates every price before creating the order.", week: "Week", month: "Month", credits: "M credits per month", summary: "Summary", empty: "Select at least one worker", today: "Due today", create: "Create order", pay: "Complete sandbox payment", pending: "Processing...", created: "Order created", activated: "Workers active", account: "Account status", safe: "Local sandbox: no card details or real money are used.", catalogError: "The catalog could not be loaded.", quoteError: "The order could not be calculated.", orderError: "The order could not be processed.", decrease: "Decrease quantity", increase: "Increase quantity", language: "Language" },
  "pt-BR": { eyebrow: "Equipes ampliadas por IA", title: "Monte sua capacidade de trabalho", intro: "Escolha os workers que sua equipe precisa. O servidor valida cada preco antes de criar o pedido.", week: "Semana", month: "Mes", credits: "M creditos por mes", summary: "Resumo", empty: "Selecione pelo menos um worker", today: "Total de hoje", create: "Criar pedido", pay: "Concluir pagamento sandbox", pending: "Processando...", created: "Pedido criado", activated: "Workers ativos", account: "Status da conta", safe: "Sandbox local: nao solicita cartao nem movimenta dinheiro real.", catalogError: "Nao foi possivel carregar o catalogo.", quoteError: "Nao foi possivel calcular o pedido.", orderError: "Nao foi possivel processar o pedido.", decrease: "Diminuir quantidade", increase: "Aumentar quantidade", language: "Idioma" },
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
  const [order, setOrder] = useState<CreatedOrder>();
  const [accountSummary, setAccountSummary] = useState<AccountSummary>();
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
    setOrder(undefined);
    setAccountSummary(undefined);
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
      if (response.ok && result.id) {
        const created = result as CreatedOrder;
        setOrder(created);
        setMessage(`${text.created}: ${created.id.slice(0, 8)}`);
      } else setMessage(text.orderError);
    } catch {
      setMessage(text.orderError);
    } finally {
      setLoading(false);
    }
  }

  async function completeSandboxPayment() {
    if (!order) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/test-only/sandbox/orders/${order.id}/complete`, { method: "POST" });
      const result = await response.json() as { order?: CreatedOrder };
      if (!response.ok || !result.order) throw new Error("sandbox payment");
      setOrder(result.order);
      const summaryResponse = await fetch("/api/account/summary");
      if (summaryResponse.ok) setAccountSummary(await summaryResponse.json() as AccountSummary);
      setMessage(result.order.status === "active" ? text.activated : `${text.created}: ${result.order.status}`);
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
        <aside><p className="eyebrow">{text.summary}</p>{quote && items.length > 0 ? <>{quote.lines.map((line) => <div className="line" key={`${line.productId}:${line.plan}`}><span>{line.quantity} x {(productCopy[language][line.productId]?.name ?? line.productName)}</span><strong>{money(line.lineAmount, language)}</strong></div>)}<div className="total"><span>{text.today}</span><strong>{money(quote.totalAmount, language)}</strong></div>{!order && <button className="primary" disabled={loading} onClick={createOrder}>{loading ? text.pending : text.create}</button>}{order?.status === "pending_payment" && <button className="primary" disabled={loading} onClick={completeSandboxPayment}>{loading ? text.pending : text.pay}</button>}</> : <p className="empty">{loading ? text.pending : text.empty}</p>}
          {order && <section className={`order-state ${order.status}`}><span>{order.id.slice(0, 8)}</span><strong>{statusText(order.status, language)}</strong></section>}
          {accountSummary && <section className="account-state"><p className="eyebrow">{text.account}</p><div><span>{text.week}</span><strong>{accountSummary.subscriptions.weekly}</strong></div><div><span>{text.month}</span><strong>{accountSummary.subscriptions.monthly}</strong></div></section>}
          <p className="safe">{text.safe}</p>{message && <p className="notice" role="status">{message}</p>}</aside>
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

function statusText(status: OrderState, language: Language): string {
  const labels: Record<Language, Record<OrderState, string>> = {
    es: { pending_payment: "Pendiente de pago", payment_processing: "Procesando pago", activation_pending: "Activacion pendiente", active: "Activo", compensating: "Compensando", refunded: "Reembolsado" },
    en: { pending_payment: "Payment pending", payment_processing: "Processing payment", activation_pending: "Activation pending", active: "Active", compensating: "Compensating", refunded: "Refunded" },
    "pt-BR": { pending_payment: "Pagamento pendente", payment_processing: "Processando pagamento", activation_pending: "Ativacao pendente", active: "Ativo", compensating: "Compensando", refunded: "Reembolsado" },
  };
  return labels[language][status];
}
