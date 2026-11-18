# Referencia de API y operación local

Esta guía amplía el [README](../README.md) con detalles de consulta, configuración
y diagnóstico. Para arrancar y probar la demo basta con el recorrido del README.
Todos los comandos se ejecutan desde la raíz del repositorio con datos sintéticos.

- [Comprobaciones iniciales](#comprobaciones-iniciales)
- [Documentación interactiva y OpenAPI](#documentación-interactiva-y-openapi)
- [Contrato HTTP](#contrato-http)
- [Persistencia, concurrencia y mensajería](#persistencia-concurrencia-y-mensajería)
- [Recuperación manual](#recuperación-manual)
- [Configuración y desarrollo](#configuración-y-desarrollo)
- [Reinicio, retención y recreación](#reinicio-retención-y-recreación)

## Comprobaciones iniciales

Tras el [arranque con Docker](../README.md#arranque-y-comandos-docker), comprueba la salud y
las conexiones. Las imágenes y dependencias están fijadas; Compose publica solo
en loopback. Sus credenciales son ficticias y exclusivas del entorno sintético.
La primera construcción necesita descargar imágenes y paquetes.

```bash
# Comprueba que la API está preparada para atender peticiones; esperado: HTTP 200.
curl --fail --include http://127.0.0.1:3000/health/ready

# Comprueba las conexiones del worker con PostgreSQL y RabbitMQ.
docker compose exec -T worker node dist/bootstrap/check-connections.js

# Verifica la topología de RabbitMQ; requiere Node en el host.
node scripts/verify-rabbitmq.mjs
```

El último comando requiere Node en el host; verifica mediante Docker la topología
efectiva, políticas y flags. La comprobación dentro del worker verifica esquema y
un roundtrip AMQP confirmado en una cola exclusiva efímera, sin negocio sintético.
La API necesita PostgreSQL y agenda válida; su disponibilidad no depende del
broker. El worker informa PostgreSQL y RabbitMQ y responde `503` si falta alguno,
aunque siga barriendo caducidades con PostgreSQL disponible. Ambos exponen
`/health/live` y `/health/ready`; el puerto de salud del worker no se publica.

El seed crea tres pacientes (`patient-ana`, `patient-bruno`, `patient-carlos`),
dos hospitales, dos tipos de prueba, cuatro recursos y cinco huecos en tres
ámbitos. El primer arranque fija las fechas al día siguiente a las 09:00 UTC.
Repetir el arranque conserva el ancla y las identidades, sin duplicar ni mover
huecos. Si sus fechas ya pasaron, usa la [recreación explícita](#reinicio-retención-y-recreación).
El esquema inicializa la demo desde vacío; no ofrece migraciones de bases de
entregas anteriores. Una configuración incompatible debe diagnosticarse.

## Documentación interactiva y OpenAPI

El mismo arranque sirve [Swagger UI](http://127.0.0.1:3000/docs) y el
[contrato JSON OpenAPI 3.2.1](http://127.0.0.1:3000/openapi.json). No hay
servicio documental ni paso de generación separado: se genera desde los esquemas
registrados en Fastify. La interfaz descarga ese mismo JSON y sirve sus recursos
con la aplicación, sin CDN ni envío a un validador externo.

```bash
# Descarga el contrato OpenAPI en un archivo local; esperado: descarga sin error.
curl --fail http://127.0.0.1:3000/openapi.json -o /tmp/diagnostic-openapi.json
```

El contrato cubre las once operaciones públicas: dos de salud y las nueve de
negocio de la tabla de [contrato HTTP](#contrato-http), incluidas lista de espera
y decisiones sobre ofertas. La prueba de cobertura captura la aplicación completa
mediante `onRoute` y contrasta métodos y rutas normalizadas con un inventario
independiente, sin exclusiones pendientes. Los HEAD que
Fastify deriva copiando el manejador y esquema GET se registran por separado;
un HEAD con manejador propio sigue siendo una operación pública. Las rutas de
artefactos documentales se comprueban aparte; la salud interna del worker queda
fuera de este contrato público.

En Swagger UI, despliega una consulta de salud y pulsa **Execute**. Para agenda,
usa `hospitalId=hospital-north`, `testTypeId=mri`,
`from=2020-01-01T00:00:00Z` y `to=2100-01-01T00:00:00Z`; los ejemplos ya están
cargados. La respuesta conserva los IDs del seed y sus fechas persistidas. Si
los huecos ya empezaron, la lista puede estar vacía. `directlyBookable` expresa
una fotografía; consultar no reserva capacidad. Borra un parámetro obligatorio
para observar `400 INVALID_REQUEST`; un instante sin zona devuelve
`400 INVALID_INTERVAL` con su mensaje.

El [recorrido de prueba](../README.md#recorrido-de-prueba)
también se ejecuta desde Swagger UI: despliega cada operación y copia los IDs de
sus respuestas. Introduce `X-Patient-Id` en las operaciones propias y guarda una
`Idempotency-Key` para cada creación. Solo el alta de espera lleva cuerpo JSON
con `hospitalId` y `testTypeId`; bloqueos, confirmación, cancelación, rechazo y
retirada no admiten cuerpo. No hay autenticación real: las identidades sintéticas
son falsificables. Los esquemas y ejemplos muestran plazos, acciones y conflictos;
las reglas de [reservas y lista de espera](#reservas-y-lista-de-espera) y los
[reintentos HTTP](#reintentos-http) precisan su significado.

Versiones exactas: `@fastify/swagger` 9.9.3 y `@fastify/swagger-ui` 6.1.4
(incorpora Swagger UI 5.34.0). El generador
[incorporó OpenAPI 3.2 en 9.9.0](https://github.com/fastify/fastify-swagger/releases/tag/v9.9.0)
y la [tabla oficial de Swagger UI](https://github.com/swagger-api/swagger-ui#compatibility)
recoge soporte desde 5.32.0. El parche 3.2.1 del documento se comprueba con
[`@seriousme/openapi-schema-validator` 2.11.0](https://github.com/seriousme/openapi-schema-validator)
para estructura y referencias, más Ajv 8.20.0 y `ajv-formats` 3.0.1 para compilar
los esquemas JSON Schema 2020-12 y contrastar las respuestas HTTP. Se comprueba
además que el verificador rechaza referencias rotas, esquemas inválidos y
respuestas incompatibles y operaciones públicas ausentes. Fastify y el resto del
stack conservan sus versiones.

`pnpm test` ejecuta documento, interfaz, inventario y salud/errores controlados;
`pnpm test:integration` contrasta las respuestas de negocio con PostgreSQL real:
agenda, reservas, inscripción nueva/activa, replay `200`/`201`, conflictos, consultas
con/sin oferta, cierre pendiente, rechazo, retirada y sus tres causas de cierre.
El recorrido de aceptación usa HTTP real y RabbitMQ, incluida la oferta tras
cancelación y la confirmación con la misma identidad de reserva. Se conservan
las comprobaciones de estado, plazos, persistencia y rollback existentes, además
de validar código, tipo de contenido y cuerpo contra el contrato. Ambos forman
parte de la CI existente, junto con `pnpm typecheck`
y `pnpm build`. Los errores provocados en la frontera de dependencias comprueban
la representación HTTP, sin acreditar disponibilidad real de PostgreSQL.


## Contrato HTTP

Estas son las nueve rutas de negocio. `ID` siempre identifica una reserva o
inscripción concreta; una asignación posterior del mismo hueco tiene otro ID.

| Método y ruta | Entrada | Resultado |
| --- | --- | --- |
| `GET /slots` | `hospitalId`, `testTypeId`, `from`, `to` | `200`, agenda pública futura y `directlyBookable` |
| `POST /slots/:slotId/holds` | Cabeceras paciente y clave; sin cuerpo | `201`, reserva `HELD` |
| `GET /reservations/:id` | Cabecera paciente | `200`, reserva propia, tiempo y acciones |
| `POST /reservations/:id/confirm` | Cabecera paciente; sin cuerpo | `200`, misma reserva `CONFIRMED`; también acepta ofertas |
| `POST /reservations/:id/cancel` | Cabecera paciente; sin cuerpo | `200`, bloqueo o cita cancelada |
| `POST /reservations/:id/reject` | Cabecera paciente; sin cuerpo | `200`, rechazo de oferta vigente |
| `POST /waiting-list-entries` | Paciente, clave, JSON hospital/tipo | `201` nueva inscripción; `200` activa existente |
| `GET /waiting-list-entries/:id` | Cabecera paciente | `200`, inscripción propia y oferta si existe |
| `POST /waiting-list-entries/:id/withdraw` | Cabecera paciente; sin cuerpo | `200`, retirada o causa real de cierre anterior |

`X-Patient-Id` presenta una de las tres identidades sintéticas. **Es falsificable**:
las comprobaciones de titularidad usan la identidad presentada; no autentican ni
impiden suplantación. Una reserva/inscripción ajena o inexistente da el mismo
`404 NOT_FOUND`. Campos, cabeceras o pacientes inválidos dan `400`; fallos
transitorios identificables de PostgreSQL dan `503 DEPENDENCY_UNAVAILABLE` y
otros errores internos `500 INTERNAL_ERROR`.

La consulta de agenda selecciona inicios en `[from,to)` estrictamente futuros,
ordenados por inicio/ID; un ámbito desconocido devuelve lista vacía. Exige zona
u offset y como máximo tres decimales, y devuelve UTC con milisegundos. Los GET
son de solo lectura: distinguen estado guardado, `evaluatedAt`, `temporal.expired`,
`closurePending` y `actions`. Un temporal vencido pendiente de cierre sigue
ocupando conservadoramente; no aparece confirmable. Una cita confirmada no
caduca por su antiguo plazo. La información de disponibilidad no reserva capacidad.

### Reservas y lista de espera

- Un bloqueo vence al menor de creación + diez minutos e inicio del hueco; el
  TTL se puede acortar. Una oferta vence al menor de creación + máximo configurado
  (dos horas por defecto) e inicio. En igualdad ya ha vencido. Ningún temporal
  se crea con ventana vacía; las escrituras revalidan tiempo después de esperar.
- Confirmar conserva el ID. Una confirmación repetida da `200` mientras siga
  confirmada; después de cancelarla da `409` con ese ID/estado actual. Una
  petición sobre R1 no altera la R2 que ocupe después el mismo hueco.
- Cancelar una cita nueva exige tiempo anterior al inicio; en igualdad devuelve
  `409 APPOINTMENT_STARTED`. Cancelar un hold vencido materializa `EXPIRED` y
  devuelve `409 RESERVATION_EXPIRED`. Una cancelación completada se puede repetir
  sin nuevos efectos, incluso pasado el inicio.
- El alta recupera primero un éxito de la clave. Para una intención nueva
  normaliza vencimientos y devuelve una inscripción realmente activa si existe.
  Solo al admitir una nueva aplica Q24: un `HELD` propio vigente del mismo ámbito
  da `409 ACTIVE_HOLD_IN_SCOPE`. Después Q2 informa capacidad directa mediante
  `409 DIRECT_CAPACITY_AVAILABLE` y referencias públicas de huecos. No crea
  inscripción ni éxito de alta, y conserva los cierres/liberaciones ya decididos.
- Un hold en otro ámbito no activa Q24. Tampoco una cita confirmada. Se permite
  coexistencia entre hold e inscripción: una inscripción existente se recupera
  antes de Q24 y un replay histórico no evalúa una admisión nueva. Ana puede
  confirmar un hold, inscribirse, cancelar y recibir otra reserva del mismo hueco.
- La espera es por hospital/tipo, compartida entre recursos equivalentes. FIFO
  usa un entero persistido creciente, incluso con timestamps empatados. Cada
  inscripción recibe como máximo una oferta pendiente. Los huecos se recorren
  por inicio/ID; para cada uno se elige la primera inscripción elegible. Se acepta
  que las exclusiones dejen capacidad libre frente a un matching global óptimo.
- Rechazar a tiempo cancela esa oferta, excluye ese hueco y conserva inscripción y
  antigüedad. Un único `SlotReleased` reactiva todo el ámbito, incluido otro hueco
  ya libre. Repetir el rechazo no altera una oferta posterior. Rechazar al vencer
  cierra por caducidad con conflicto, sin devolver la inscripción a espera.
- Retirarse cancela una oferta vigente y cierra su inscripción atómicamente.
  Una retirada tardía devuelve la causa real de cierre, sin afectar una cita ni
  una reinscripción posterior. Una oferta no aceptada cierra su inscripción por
  `EXPIRED`; reincorporarse necesita otra clave/ID y va al final si procede.
- El worker barre temporales, incluidos atrasados durante una parada. La prioridad
  de espera se deriva de estado/exclusiones en PostgreSQL: ni un consumidor parado
  permite adelantar a un paciente elegible mediante hold directo.

### Reintentos HTTP

Las dos creaciones exigen `Idempotency-Key`. Guarda la clave antes del primer
intento. Mismo paciente, operación, clave y destino recuperan cuerpo y código
originales (`201` o `200`), aunque el recurso haya cambiado, sin nuevo recurso,
evento ni plazo. GET permite conocer el estado actual tras ese replay histórico.
Reutilizar una clave exitosa con otro destino da `409 IDEMPOTENCY_KEY_REUSED`.
Pacientes y operaciones separan claves. Un conflicto sin éxito se reevalúa y un
fallo técnico revierte las escrituras; no se cachean indiscriminadamente errores.
Las transiciones sin clave son idempotentes respecto a sus efectos y estado actual.

## Persistencia, concurrencia y mensajería

PostgreSQL usa transacciones `READ COMMITTED`, coordinación técnica de clave o
evento/consumidor y, como primer bloqueo de negocio, la fila estable del ámbito.
Después de esperar hace lecturas nuevas y toma
`date_trunc('milliseconds', clock_timestamp())`. Índices parciales aseguran un
ocupante `HELD/OFFERED/CONFIRMED` por hueco, una inscripción activa por paciente y
ámbito y una oferta por inscripción. No se usa un mutex de proceso. Ámbitos
distintos pueden avanzar independientemente; dentro del ámbito se serializan
escrituras cortas, sin esperar al paciente ni al broker. Lock timeout: 2 s;
statement timeout: 2,5 s. No son un SLO de respuesta.

El barrido procesa hasta 100 reservas por ciclo, con una transacción por reserva.
Un fallo local revierte esa transacción, se registra como `reservation_expiry_failed`
con el ID de reserva y permite continuar con las demás y publicar la outbox.
La indisponibilidad global identificada de PostgreSQL detiene el procesamiento;
un error local del barrido no cambia por sí solo la salud de la base de datos.
El recorrido avanza por vencimiento/ID y fija su fecha de corte al empezar, para
que un lote defectuoso no oculte los siguientes ni las nuevas caducidades impidan
volver a los fallidos. Estos se reintentan en el siguiente recorrido, respetando
el intervalo configurado entre ciclos. La posición se guarda solo en memoria:
reiniciar empieza desde el principio. Se conserva el límite de lote, sin prometer
una duración máxima del ciclo ante esperas de bloqueo.

Negocio y eventos/outbox se comprometen juntos. `SlotReleased` y
`AllocationReviewRequested` revisan el ámbito vigente; `OfferCreated` avisa de
una oferta concreta ya creada. Los mensajes tienen versión e identidades
separadas de evento, consumidor lógico, ciclo, intento y publicación.

| Situación | Comportamiento y límite |
| --- | --- |
| Broker inaccesible | Negocio y outbox permanecen en PostgreSQL; barrido sigue; el relay recupera pendientes al volver. |
| Publicación sin ruta | `mandatory` + confirm detectan fallo; se retiene error y próxima fecha positiva. Otra ruta operativa puede avanzar. |
| Confirmación incierta | Se retira la conexión y se reintenta; broker pudo aceptar antes de perder la respuesta. `published_at` no acredita consumo. |
| Duplicado o caída tras commit/preack | Resultado terminal por evento/consumidor evita una segunda adjudicación; puede repetirse transporte o log. |
| Mensaje antiguo/desordenado | Relee estado y plazo bajo coordinación; no libera ni cambia la reserva sustituta. FIFO no depende del orden AMQP. |
| Fallo lógico transitorio | Rollback y programación SQL durable de reintentos a 5 s, 30 s y 120 s desde el fallo anterior; cuatro intentos por ciclo. |
| Fallo permanente o cuarto fallo | Aparcado SQL y outbox hacia DLQ antes del ack; no se registra éxito del negocio. |
| Caída general de BD o salida de logs rota | Pausa limitada con espera y `prefetch=1`, sin gastar presupuestos lógicos en masa. |
| Pérdida física comprobada | Recuperación explícita de una publicación retenida; nunca reproducción indiscriminada de toda la outbox publicada. |

El relay único está habilitado **por configuración**, sin elección de líder ni
relevo automático. Cada envío conserva contador, error y próxima fecha durable;
la selección respeta tanto esa fecha como la del intento lógico. No purga por
número de envíos. Espera de conexión: un segundo; timeout de confirmación y
contrapresión configurable. El cierre retira conexiones inciertas de forma acotada.

RabbitMQ conserva dos colas de trabajo quorum y sus dos DLQ, exchanges/bindings
versionados y mensajes persistentes. Las principales usan `delivery-limit=20`,
DLX `at-least-once` y `overflow=reject-publish`. El límite físico protege caídas
anteriores a evidencia SQL; **no equivale al presupuesto lógico**. Las DLQ no
tienen TTL, DLX, retorno automático ni límite de entregas fallidas. Si falta su
ruta, el broker conserva el traslado; su temporizador interno puede demorar la
reparación (180 s por defecto en la versión fijada). Ninguna espera garantiza un
plazo máximo de entrega. Un miembro quorum y un relay configurado **no son HA**.

El aviso comprueba inmediatamente antes de escribir que la reserva concreta sigue
`OFFERED` y vigente. Espera la escritura/callback antes de guardar resultado y ack,
sin bloquear el ámbito. Incluye evento, reserva, hueco, referencia sintética de
paciente y vencimiento persistido. Puede repetirse tras escribir y caer, o llegar
tarde si vence/se rechaza entre comprobación y emisión. No acredita captura durable
del log ni recepción humana. Aceptar vuelve a validar estado y plazo. **Una oferta
puede vencer sin que haya existido un aviso utilizable**; el plazo nace al crearla.
No se interpreta como recepción ni desinterés del paciente.

## Recuperación manual

Diagnostica y corrige la causa antes de seleccionar una publicación exacta.
Para localizar candidatos sin consultar payloads de pacientes:

```bash
docker compose exec -T postgres psql -U diagnostic -d diagnostic_appointments -c "
SELECT p.id AS publication_id, p.event_id, p.consumer, p.cycle, p.attempt,
       p.destination, p.published_at, p.send_count, p.last_error,
       r.current_cycle, r.outcome, c.state, c.park_reason
FROM scheduling.outbox_publications p
LEFT JOIN scheduling.consumer_results r USING (event_id, consumer)
LEFT JOIN scheduling.consumer_cycles c USING (event_id, consumer, cycle)
WHERE p.destination='dead' OR c.state='parked'
   OR ((p.published_at IS NOT NULL OR p.send_count>0) AND r.outcome IS NULL)
ORDER BY p.created_at, p.id;"
```

Son candidatos técnicos; la consulta no demuestra por sí sola pérdida física.
Sustituye el UUID ficticio por el `publication_id` exacto y el consumidor:

```bash
docker compose exec -T worker node dist/bootstrap/recover-message.js \
  --mode dlq --consumer allocation \
  --publication-id 00000000-0000-4000-8000-000000000001 \
  --operator demo-operator --reason 'Causa sintética corregida y verificada'
```

Busca hasta 100 entregas listas (`--scan-limit` permite 1..1000). Verifica envelope,
ruta, publicación retenida y origen físico `delivery_limit` o aparcado de aplicación.
No reconoce otras entregas; se reencolan al cerrar el canal. Puede no encontrar
una entrega ocupada, no lista o fuera del límite, y la búsqueda puede alterar el
orden físico de DLQ. No cambia FIFO de pacientes. Desconocidos permanecen para
diagnóstico. Fallar produce `manual_recovery_failed` y salida distinta de cero,
conservando el original. Usa conexión dedicada; cierra canal hasta 500 ms y, si
es incierto, retira la conexión con otro límite de 500 ms.

Si se ha comprobado ausencia del mensaje físico, el modo persistido usa evidencia
retenida de aparcado o envío confirmado/intentado y no conecta con RabbitMQ:

```bash
docker compose exec -T worker node dist/bootstrap/recover-message.js \
  --mode persisted --publication-id 00000000-0000-4000-8000-000000000001 \
  --operator demo-operator --reason 'Ausencia física comprobada; causa corregida'
```

Trabajo nunca enviado corresponde al relay y se rechaza. La recuperación coordina
evento/consumidor, conserva historial, contenido y deadlines, y guarda auditoría,
nuevo ciclo, intento cero y outbox antes del ack. Dos operadores, copias o caída
tras commit reconocen la misma recuperación. No invalida un intento posterior.
La salida `manual_recovery` puede indicar `recovered`, `already_completed` o
`superseded`; estos dos últimos no crean trabajo. Si una entrega DLQ ya se retiró,
el modo persistido permite consultar la recuperación del mismo ID. Un nuevo ciclo
aparcado requiere otra selección explícita. La herramienta local no autentica al
operador: usa motivos/referencias sintéticas, sin secretos ni información clínica.

## Configuración y desarrollo

Versiones reproducibles: Node 26.13.1, pnpm 12.21.0, TypeScript 6.0.3,
Fastify 5.12.8, PostgreSQL 18.7 y RabbitMQ 4.4.0. Dockerfile e imágenes de
Compose, `package.json` y lockfile fijan las versiones utilizadas.
Para desarrollar en el host, instala Node/pnpm indicados y copia
`.env.example` a `.env`; son valores ficticios locales. Arranca dependencias:

```bash
docker compose up -d --wait postgres rabbitmq
pnpm install --frozen-lockfile
pnpm dev:api
# En otra terminal:
pnpm dev:worker
```

| Variable | Valor predeterminado / uso |
| --- | --- |
| `DATABASE_URL`, `RABBITMQ_URL` | URLs locales de `.env.example`; Compose usa nombres internos de servicios |
| `HOST` | `127.0.0.1` local; `0.0.0.0` en contenedor |
| `API_PORT`, `WORKER_HEALTH_PORT` | 3000 y 3001; salud worker solo interna en Compose |
| `POSTGRES_PORT`, `RABBITMQ_PORT` | Puertos de host Compose: 5432 y 5672 |
| `DIRECT_HOLD_TTL_MS` | 600000; entero entre 1 y 600000 |
| `OFFER_MAXIMUM_MS` | 7200000; entero positivo |
| `EXPIRY_SWEEP_INTERVAL_MS` | 3000; entero positivo |
| `RELAY_ENABLED` | `false` en Node, `true` en worker de Compose; habilitar exactamente uno |
| `OUTBOX_RETRY_DELAY_MS` | 5000; entero positivo, transporte independiente de intentos SQL |
| `PUBLISHER_CONFIRM_TIMEOUT_MS` | 5000; entero positivo |
| `APPLICATION_IMAGE` | `recoletas-diagnostic-appointments:local`; etiqueta de imagen Compose |

Para proyectos paralelos, elige nombre, puertos y etiqueta propios. Conserva
**las mismas variables en cada comando Compose**, incluidos stop/up/down/exec;
cambiar valores puede recrear contenedores con puertos distintos. Los puertos
internos de PostgreSQL, AMQP y API siguen siendo 5432, 5672 y 3000. Ajusta las URLs
del host cuando cambies puertos publicados. El worker local necesita
`RELAY_ENABLED=true` si debe publicar, y las otras réplicas deben mantenerlo en false.

### Verificación

Los comandos están en [Verificación del README](../README.md#verificación).

`pnpm test:integration` prepara y elimina su propio entorno Docker temporal;
puedes ejecutarlo con la demo activa y sin configurar URLs de prueba. Cada
ejecución utiliza un proyecto `appointment-tests-<UUID>`, volúmenes nuevos y
puertos de loopback asignados por Docker. Solo levanta PostgreSQL y RabbitMQ con
el `compose.yaml` del repositorio, espera sus healthchecks y ejecuta el verificador
de topología existente sobre ese mismo proyecto. Los escenarios siguen creando
sus propios procesos API y worker cuando los necesitan.

El comando ignora `.env` y las variables `COMPOSE_*` heredadas y sustituye los
puertos y las URLs de conexión de la suite por los del entorno temporal. Así evita
que la configuración de la demo redirija accidentalmente las integraciones.
Imprime el nombre del proyecto y sus puertos para identificar la ejecución.

Las integraciones crean fixtures/bases/roles y mensajes sintéticos. Al terminar,
también ante un fallo o una interrupción con `Ctrl+C`, el comando elimina solo
sus contenedores, red y volúmenes. Antes de limpiar un fallo muestra el estado y
las últimas 100 líneas de logs de cada servicio; no conserva los almacenes para
inspección posterior. Mantiene el código de salida de la suite; si falla la
preparación o la limpieza, también termina con error. Si Docker no permite la
limpieza, informa del proyecto afectado y del fallo.

Incluyen esperas reales de 5/30/120 s y del traslado DLX, por lo que tardan varios
minutos. La CI utiliza el mismo `pnpm test:integration`, manteniendo separados
typecheck estricto de aplicación/pruebas, unitarias y build.
No hay lint, formateador, umbral de cobertura ni benchmark obligatorios configurados.
`test/integration/expiry-isolation.test.ts` ejecuta un worker real con PostgreSQL
y RabbitMQ: mantiene fallos al commit en una reserva y en un lote de 100, comprueba
rollback, progreso de otro ámbito, publicación y consumo, y recuperación tras
retirar el fallo. Las unitarias verifican además que la indisponibilidad global
se propaga y detiene el lote.
La matriz registra resultados locales ejecutados; el estado remoto de CI se
consulta por su SHA y no se infiere de esos resultados.

## Reinicio, retención y recreación

Un reinicio normal conserva negocio, fechas, claves HTTP exitosas, eventos,
outbox pendiente **y publicada**, resultados terminales, intentos, ciclos,
recuperaciones, mensajes y DLQ. No hay purgas automáticas. PostgreSQL y RabbitMQ
usan volúmenes y RabbitMQ mantiene su identidad estable de nodo.

Los comandos de parada y arranque están en [Arranque y comandos Docker](../README.md#arranque-y-comandos-docker).

El worker retoma pendientes al llegar sus fechas, sin segunda asignación y sin
republicar filas ya marcadas publicadas. La retención no es backup, no migra un
esquema incompatible y no protege frente a pérdida irreversible del almacenamiento.

Para **recrear toda la demo sintética**, `docker compose down --volumes` elimina
coordinadamente los dos volúmenes; después usa `docker compose up --build --wait`.

Esto destruye toda la evidencia anterior de ese proyecto: negocio, claves,
deduplicación, outbox, resultados, intentos, recuperaciones, colas y DLQ. No borres
solo PostgreSQL o solo RabbitMQ: mezclar estados antiguos/nuevos puede perder
trabajo o deduplicación. Usa el mismo nombre de proyecto y variables al recrear.
Ningún comando de arranque normal realiza ese borrado. La comprobación de entrega
lo ejecutó únicamente sobre un proyecto nuevo desechable con datos sintéticos.
