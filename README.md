# PERXIA Checkout

Implementacion de referencia del checkout de workers de IA. Incluye catalogo versionado, cotizacion calculada en servidor, ordenes idempotentes, proveedor sandbox, webhooks firmados, activacion, reintento, compensacion, suscripciones por cadencia, conciliacion e interfaz en espanol, ingles y portugues.

La demostracion no captura tarjetas, no mueve dinero y no se presenta como una integracion real con Stripe. El proveedor sandbox implementa el mismo puerto que debe implementar el proveedor contratado. La propuesta completa esta en [`docs/propuesta.md`](docs/propuesta.md) y el runbook en [`docs/runbook.md`](docs/runbook.md).

## Requisitos

- Node.js 20 o superior
- npm 10 o superior

## Ejecucion local

```bash
npm install
```

En una terminal:

```bash
npm run dev:api
```

En otra terminal:

```bash
npm run dev:web
```

Abrir `http://localhost:5173`.

## Validacion

```bash
npm run lint
npm run typecheck
npm test
npm run demo
npm run build
npm start
```

El servidor de produccion queda disponible en `http://localhost:8787` y sirve tanto la API como el frontend compilado.

## API

| Metodo | Ruta | Uso |
|---|---|---|
| GET | `/api/health` | Salud del servicio |
| GET | `/api/catalog` | Catalogo y precios vigentes |
| POST | `/api/quotes` | Cotizacion validada por el servidor |
| POST | `/api/orders` | Crea una orden `pending_payment` |
| GET | `/api/orders/:id` | Consulta una orden de la cuenta |
| POST | `/api/orders/:id/checkout-session` | Crea o reutiliza sesion del proveedor |
| POST | `/api/payments/webhooks/sandbox` | Recibe evento firmado y deduplicado |
| GET | `/api/account/summary` | Resume ordenes y suscripciones por cadencia |
| POST | `/api/operations/orders/:id/retry-activation` | Reintenta activacion idempotente |
| POST | `/api/operations/orders/:id/refund` | Ejecuta compensacion idempotente |
| GET | `/api/operations/reconciliation` | Compara movimientos locales y proveedor |
| POST | `/api/test-only/sandbox/orders/:id/complete` | Completa el flujo local sin tarjeta ni dinero |

Esta demostracion usa una unica cuenta fija configurada por el servidor mediante `DEMO_ACCOUNT_ID`. El navegador no puede escogerla. En produccion, el backend existente debe reemplazar ese adaptador y derivar la cuenta del token de Microsoft Entra ID.

Ejemplo de cotizacion:

```bash
curl -X POST http://localhost:8787/api/quotes \
  -H "content-type: application/json" \
  -d '{"items":[{"productId":"software-design","plan":"month","quantity":1}]}'
```

Los montos usan centavos enteros. La API ignora cualquier total calculado por el cliente y vuelve a leer el precio del catalogo.

## Flujo demostrado

- Cinco workers y precios de la tabla del PRD en `data/catalog.json`, modificables sin cambiar ni recompilar codigo.
- Plan semanal y mensual como datos independientes.
- Cantidad entre 1 y 50 por linea.
- Cotizacion y orden aisladas por cuenta, con clave idempotente obligatoria al crear la orden.
- Firma HMAC con tolerancia temporal, cuerpo crudo, deduplicacion y transiciones monotonas.
- Activacion idempotente por unidad, fallo determinista, reintento y reembolso compensatorio.
- Suscripciones semanales y mensuales separadas, auditoria append-only y conciliacion.
- Sin datos de tarjeta, credenciales reales ni dinero.

## Persistencia y produccion

La aplicacion ejecutable conserva datos en memoria porque el repositorio no contiene el backend de cuentas corporativo. `migrations/001_payments_baseline.sql` entrega el modelo MySQL 8 de produccion con inbox/outbox, jobs, ledger, auditoria y conciliacion. `compose.yaml` levanta esa base para validar el DDL, pero no se presenta como conectada al demo.

La salida productiva requiere reemplazar tres puertos: repositorio en memoria por el modulo MySQL del backend existente, cuenta demo por claims verificados de Entra ID y `SandboxPaymentProvider` por el proveedor aprobado en DP-1. Las politicas DP-2 a DP-7 permanecen configurables o deshabilitadas hasta aprobacion.

## Seguridad de la demo

- El atajo usado por la interfaz queda deshabilitado por defecto con `NODE_ENV=production`; solo se habilita explicitamente con `ENABLE_SANDBOX_DEMO=true`.
- `SANDBOX_WEBHOOK_SECRET` y `DEMO_OPERATOR_KEY` deben configurarse fuera del repositorio.
- Los valores predeterminados son exclusivamente locales y nunca deben usarse como credenciales productivas.
- Las operaciones administrativas requieren el header demo de operador; la integracion real usa roles Entra.
