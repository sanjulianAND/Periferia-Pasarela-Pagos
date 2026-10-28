# Runbook de pagos PERXIA

## Alcance y realidad actual

Este runbook operacionaliza la propuesta de `docs/propuesta.md` para el destino productivo MySQL. El repositorio actual es un demo: carga `data/catalog.json`, mantiene pedidos en `InMemoryOrderStore`, resuelve una cuenta demo e incluye un adaptador sandbox, webhook HMAC, activacion, compensacion y conciliacion en memoria. No contiene cliente MySQL ni jobs durables. `migrations/001_payments_baseline.sql` define el esquema objetivo; aplicarlo no conecta automaticamente el demo a MySQL ni convierte el sandbox en un sistema de cobro real.

No habilitar cobros reales hasta cerrar las decisiones DP-1 a DP-7 aplicables, contratar un proveedor elegible para la entidad colombiana, implementar el modulo productivo y superar las pruebas de integracion, seguridad, restauracion y conciliacion. Sandbox no demuestra settlement, FX, reservas ni SLA.

## Controles permanentes

- Usar UTC en aplicacion, base y reportes. Guardar importes en unidades menores enteras y moneda ISO 4217.
- Obtener `account_id` de identidad confiable; nunca del body. Toda consulta de negocio se filtra por cuenta y un recurso de otra cuenta responde 404.
- No registrar PAN, CVV, expiracion, secretos, bearer tokens, payload crudo, URL de checkout ni PII completa.
- Mantener captura de tarjeta alojada por el proveedor para conservar el objetivo SAQ A.
- Usar Key Vault y Managed Identity en Azure. Produccion, staging y sandbox tienen cuentas, endpoints y secretos diferentes.
- Restringir `UPDATE` y `DELETE` sobre `audit_events` y `credit_ledger_entries` al rol runtime. Corregir mediante eventos o asientos compensatorios.
- Deshabilitar nuevas compras con una bandera independiente. Webhooks, resolucion de estados `UNKNOWN`, activaciones, compensaciones y conciliacion deben continuar.

## Despliegue

### Preparacion

1. Confirmar backup PITR y ejecutar periodicamente una restauracion en un servidor aislado. Objetivos propuestos: RPO menor o igual a 5 minutos y RTO menor o igual a 60 minutos.
2. Generar artefacto inmutable y registrar digest, commit, checksum SHA-256 de cada migracion y actor del despliegue.
3. Ejecutar lint, typecheck, pruebas, escaneo de dependencias/secretos y build. Probar la migracion dos veces en MySQL real, no SQLite.
4. Verificar que la revision anterior tolera el esquema expandido. El DDL se aplica antes del codigo.
5. Confirmar alertas de backlog inbox/outbox, `UNKNOWN`, activacion, refunds y conciliacion, ademas del contacto de proveedor, Operacion, Seguridad y Finanzas.

### Aplicar esquema

El archivo es expand-only y admite reintentos exactos cuando el checksum y el esquema coinciden. `CREATE TABLE IF NOT EXISTS` no corrige drift ni completa una tabla parcial. La herramienta de despliegue debe tomar un advisory lock, rechazar una version existente con checksum distinto, validar el esquema resultante y registrar `schema_migrations` en la misma ejecucion controlada. No ejecutar migraciones concurrentes.

Ejemplo local, sin incluir contrasena en historial:

```sh
docker compose up -d mysql
docker compose exec -T mysql mysql -uperxia -p"$MYSQL_PASSWORD" perxia < migrations/001_payments_baseline.sql
docker compose exec -T mysql mysql -uperxia -p"$MYSQL_PASSWORD" perxia < migrations/001_payments_baseline.sql
```

En Azure se exige TLS y una identidad/credencial de migracion separada del runtime. Verificar tablas, constraints, version MySQL 8.0.16 o superior y `SHOW WARNINGS`. Crear grants de minimo privilegio fuera del DDL versionado.

### Liberar codigo

1. Desplegar primero staging y ejecutar el smoke sandbox completo.
2. Crear revision canary con compras deshabilitadas; comprobar health, lectura de catalogo y procesamiento de backlog.
3. Habilitar por cuentas internas y luego por cohortes. Observar al menos una ventana de webhook/reintento acordada.
4. Registrar hora, revision, migraciones, flags, metricas base y aprobadores.

## Rollback

1. Detener nuevas sesiones de checkout, no la recepcion de webhooks ni los workers de recuperacion.
2. Volver a la revision anterior solo si es compatible con el esquema expandido.
3. No bajar tablas, borrar eventos ni revertir pagos. Este baseline no tiene down migration deliberadamente.
4. Si hubo una operacion financiera incorrecta, confirmar primero el estado autoritativo del proveedor y corregir con transicion, refund o asiento compensatorio idempotente.
5. Si la revision anterior no entiende el esquema/estado nuevo, mantener la revision y apagar la capacidad afectada; preparar un fix forward.
6. Conciliar desde el ultimo cierre bueno hasta el final del incidente y documentar cuentas afectadas.

## Replay de webhooks

### Diagnostico

1. Verificar status del proveedor, endpoint, reloj, certificado, version de firma y errores de DB.
2. Medir `provider_events` por `status`, evento mas antiguo y reintentos. Un duplicado por `(provider, provider_event_id)` es exito idempotente, no incidente.
3. Comparar hash y referencia con el proveedor. Nunca sustituir ni editar el payload persistido.

### Reproceso

1. Preferir replay oficial del proveedor al mismo endpoint firmado. La recepcion vuelve a deduplicar en el inbox.
2. Para un evento ya persistido, usar la operacion autorizada de replay. Debe limpiar el lease vencido, incrementar intento y ejecutar la misma maquina de estados, no una ruta que escriba estado final directamente.
3. Si los eventos llegaron fuera de orden o falta uno, consultar el recurso autoritativo por referencia estable antes de aplicar una transicion.
4. Confirmar un solo pago, activacion, credito, correo y auditoria. Revisar outbox y jobs asociados.
5. Conciliar toda la ventana desde el ultimo evento confirmado. Enviar a `DEAD_LETTER` solo con error sanitizado, alerta y dueno.

Una firma invalida nunca se fuerza ni se replaya como valida. Investigar secreto, reloj, endpoint y posible abuso con Seguridad.

## Activacion, reintento y compensacion

1. Localizar pedido `ACTIVATION_PENDING`, pago `SUCCEEDED` y `activation_jobs` por cuenta. Confirmar monto, moneda, item y que no existe ya el recurso activado.
2. Clasificar el fallo como transitorio o permanente. No cambiar `activation_key` ni crear otro cobro.
3. Para transitorios, liberar solo leases vencidos y reintentar con la misma clave. Cadencia propuesta: inmediato, 1, 5, 15 y 60 minutos; alerta a los 15 minutos.
4. La activacion debe crear/enlazar workers o creditos, marcar job/pedido y emitir audit/outbox en una transaccion MySQL idempotente.
5. Si el error es permanente o se alcanza el limite aprobado, cambiar a `COMPENSATING` y solicitar refund con una clave compensatoria estable. Un timeout queda `UNKNOWN`; consultar antes de repetir.
6. Cerrar como `REFUNDED`/`COMPENSATED` solo al confirmar el proveedor. Una compensacion fallida conserva alerta y caso operativo.
7. Informar al cliente sin detalles internos y conciliar pago y refund. Nunca dejar workers activos tras refund sin aplicar la politica de derechos aprobada.

La compensacion automatica a las dos horas es una propuesta, no una regla aprobada. Requiere politica y limites de Operacion.

## Caida del proveedor

1. Abrir incidente, consultar pagina de estado y determinar si afecta API, checkout, webhooks, recurrencia o reportes.
2. Abrir circuit breaker para crear nuevas sesiones/cobros. Mantener catalogo, estado de cuenta y uso de workers disponibles.
3. No marcar como fallidos timeouts ambiguos y no reintentar con una clave nueva. Persistir `UNKNOWN` y consultar por la misma clave/referencia cuando vuelva el servicio.
4. Mantener endpoint de webhook e inbox activos. Pausar jobs que inician operaciones externas si el proveedor no garantiza idempotencia; mantener procesado local seguro.
5. Separar declines de cliente de errores tecnicos. En fallo masivo de renovaciones, suspender consecuencias de dunning y no cortar workers.
6. Al recuperar, drenar con limite de tasa, resolver primero pagos/refunds `UNKNOWN`, procesar inbox por transiciones monotonas y revisar outbox.
7. Conciliar toda la ventana, buscar posibles dobles cobros y comunicar cierre. No reembolsar un supuesto duplicado hasta confirmar ambos movimientos.

## Conciliacion semanal y mensual

1. Usar periodos UTC semiabiertos `[start, end)` y una ejecucion separada por proveedor, moneda y cadencia `WEEK` o `MONTH`.
2. Importar por API/export firmado los movimientos de proveedor: cobros, fallidos, refunds, fees, chargebacks y payouts. Conservar referencia y hash; no importar PAN/PII innecesaria.
3. Crear el run con clave idempotente estable. Repetir el mismo periodo reutiliza el run, no duplica items.
4. Comparar por referencia, cuenta, moneda e importe. Explicar bruto, refunds, fees, neto y payout; no asumir que payout equivale a ventas del periodo.
5. Cualquier faltante o diferencia deja `EXCEPTION`, codigo, dueno y evidencia. Revisar zona horaria, settlement, FX y eventos tardios.
6. Resolver con evento/asiento compensatorio aprobado; no editar ledgers historicos. Cerrar `MATCHED` solo con cero diferencias no explicadas.
7. Finanzas aprueba cierre y conserva export, checksum, run y evidencia segun retencion aprobada. La retencion de 10 anos y payload de webhook por 30 dias siguen pendientes de validacion legal.

## Rotacion de secretos

### Clave API

1. Crear una clave nueva de minimo privilegio y una nueva version en Key Vault. No revocar la anterior.
2. Actualizar la referencia de staging, validar una operacion no financiera o sandbox y revisar que ningun valor aparezca en logs.
3. Desplegar produccion gradualmente y observar autenticacion, rate limits y webhooks durante una ventana acordada.
4. Revocar la clave anterior, confirmar que no hay consumidores y registrar actor, fecha, version y ticket, nunca el valor.

### Secreto webhook

1. Configurar segundo secreto o endpoint segun capacidad del proveedor.
2. Durante la ventana aceptar firma con version nueva o anterior y registrar solo la version que valido.
3. Enviar evento de prueba, confirmar inbox y efecto idempotente, cambiar trafico y esperar la ventana maxima de reintento.
4. Retirar el secreto anterior. Si falla, volver a la version anterior aun valida; nunca desactivar verificacion de firma.

Ante sospecha de exposicion: rotacion urgente, revocacion coordinada, revision de audit/logs, replay de eventos confiables y conciliacion del periodo. Rotacion ordinaria propuesta: 90 dias.

## Demo sandbox

### Preparacion

1. Usar cuenta, credenciales, endpoint y webhook exclusivos de sandbox desde el gestor de secretos. No usar datos personales ni tarjetas reales.
2. Cargar un catalogo versionado equivalente a `data/catalog.json`; marcar que los precios semanales, bolsas y paquetes sujetos a DP no estan aprobados para produccion.
3. Confirmar que el checkout usa pagina/componente alojado y que red, DB y logs PERXIA no reciben PAN, CVV ni expiracion.

### Guion de aceptacion

1. Comprar un worker con tarjeta de prueba; recibir webhook firmado y mostrar pago, auditoria y activacion en menos de cinco minutos.
2. Repetir request, webhook y activation job; demostrar un solo pedido, pago, worker/credito y efecto outbox.
3. Simular timeout y mostrar `UNKNOWN` sin segundo cobro; recuperar por consulta con la misma referencia.
4. Simular activacion fallida, observar `ACTIVATION_PENDING`, reintentar con la misma clave y converger. En otro caso demostrar refund compensatorio.
5. Comprar workers `WEEK` y `MONTH`; demostrar dos suscripciones/calendarios y una vista agregada, nunca una suscripcion mixta.
6. Simular renovacion fallida y recuperada sin corte automatico de workers.
7. Ejecutar refund parcial/total y conciliacion sin diferencias; introducir una diferencia controlada y demostrar `EXCEPTION` con dueno.

Guardar IDs internos, tiempos y capturas redactadas como evidencia. La demo no autoriza produccion. El pase exige smoke de importe minimo aprobado por Finanzas, refund, settlement/payout real y conciliacion.

## Consultas operativas seguras

Ejecutar con un rol de solo lectura y siempre limitar por periodo/cuenta cuando aplique:

```sql
SELECT status, COUNT(*) AS total, MIN(received_at) AS oldest
FROM provider_events
WHERE status IN ('RECEIVED', 'PROCESSING', 'RETRY', 'DEAD_LETTER')
GROUP BY status;

SELECT status, COUNT(*) AS total, MIN(next_attempt_at) AS oldest_retry
FROM activation_jobs
WHERE status NOT IN ('SUCCEEDED', 'COMPENSATED')
GROUP BY status;

SELECT provider, status, COUNT(*) AS total
FROM payments
WHERE status = 'UNKNOWN'
GROUP BY provider, status;

SELECT id, provider, cadence, period_start, period_end, status, exception_count
FROM reconciliation_runs
WHERE status IN ('EXCEPTION', 'FAILED')
ORDER BY created_at DESC;
```

No ejecutar `UPDATE` manual para "arreglar" resultados. Toda accion operativa usa el contrato autenticado, idempotente y auditado del modulo productivo.
