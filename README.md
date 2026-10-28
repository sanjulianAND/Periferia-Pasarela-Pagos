# PERXIA Checkout

Primera entrega funcional del checkout de workers de IA. Incluye catalogo versionado, cotizacion calculada en servidor, creacion de una orden pendiente de pago e interfaz en espanol, ingles y portugues.

Esta entrega no captura tarjetas ni afirma una integracion real con Stripe. La propuesta completa y las decisiones de arquitectura estan en [`docs/propuesta.md`](docs/propuesta.md).

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
npm run build
npm start
```

El servidor de produccion queda disponible en `http://localhost:8787` y sirve tanto la API como el frontend compilado.

## API inicial

| Metodo | Ruta | Uso |
|---|---|---|
| GET | `/api/health` | Salud del servicio |
| GET | `/api/catalog` | Catalogo y precios vigentes |
| POST | `/api/quotes` | Cotizacion validada por el servidor |
| POST | `/api/orders` | Crea una orden `pending_payment` |
| GET | `/api/orders/:id` | Consulta una orden de la cuenta |

Esta demostracion usa una unica cuenta fija configurada por el servidor mediante `DEMO_ACCOUNT_ID`. El navegador no puede escogerla. En produccion, el backend existente debe reemplazar ese adaptador y derivar la cuenta del token de Microsoft Entra ID.

Ejemplo de cotizacion:

```bash
curl -X POST http://localhost:8787/api/quotes \
  -H "content-type: application/json" \
  -d '{"items":[{"productId":"software-design","plan":"month","quantity":1}]}'
```

Los montos usan centavos enteros. La API ignora cualquier total calculado por el cliente y vuelve a leer el precio del catalogo.

## Alcance de esta entrega

- Cinco workers y precios de la tabla del PRD en `data/catalog.json`, modificables sin cambiar ni recompilar codigo.
- Plan semanal y mensual como datos independientes.
- Cantidad entre 1 y 50 por linea.
- Cotizacion y orden aisladas por cuenta, con clave idempotente obligatoria al crear la orden.
- Sin datos de tarjeta ni secretos.
- Almacenamiento temporal en memoria para demostrar el limite de dominio.

## Siguiente entrega

La segunda parte reemplaza el almacenamiento temporal por el modulo del backend de cuentas y agrega el adaptador del proveedor, webhook firmado, inbox/outbox, activacion idempotente, reintentos y compensacion. Requiere confirmar proveedor, credenciales sandbox y contrato de activacion existente.
