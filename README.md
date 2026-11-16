# Citación de pruebas diagnósticas

Implementación de la [prueba de arquitectura de software](docs/diagnostic-appointment-requirements.pdf).
Esta entrega permite consultar una agenda sintética validada, bloquear un hueco
con exclusividad, confirmar o cancelar la reserva y caducar los bloqueos desde
el worker. Cada liberación conserva su evento y publicación pendiente en
PostgreSQL. También permite alta, consulta y retirada de espera sin oferta,
con FIFO persistido y prioridad frente a reserva directa. El transporte asíncrono,
la adjudicación de ofertas y los avisos corresponden a las siguientes entregas.

## Diseño funcional acordado

El [diseño funcional consolidado](docs/functional-design.md), revisión 5 de
2026-11-16, es la referencia vigente de Q1–Q26 y los criterios AC01–AC69.
Incorpora las últimas respuestas aceptadas y las correcciones de trazabilidad
de Q24. La [referencia técnica](docs/technical-design.md) registra su procedencia
y verificación de integridad. El [glosario](GLOSSARY.md) recoge su vocabulario.
Este resumen refleja las decisiones vigentes, incluidas las revisiones del
grilling. El recorrido implementado y sus verificaciones se concretan más abajo;
las reglas restantes siguen siendo trabajo pendiente.

1. **Agenda precargada.** La demo usa huecos sintéticos precargados, sin
   operaciones de administración de agendas. El seed se valida para impedir
   intervalos solapados de un mismo recurso. La exclusividad concurrente
   implementada para bloqueos es por hueco; esa garantía, por sí sola, no impide
   solapamientos entre huecos diferentes de una máquina.
2. **Admisión condicionada, Q2 revisada y Q24.** Primero se recuperará un éxito
   previo de la clave; para una intención nueva se resolverán vencimientos bajo
   coordinación y se devolverá una inscripción realmente activa si existe.
   Solo al decidir una admisión nueva se comprobará Q24: un bloqueo directo
   propio `HELD` vigente del mismo hospital y tipo de prueba produce
   `409 ACTIVE_HOLD_IN_SCOPE`. Si no lo hay pero existe disponibilidad directa,
   Q2 responderá `409` con otro motivo e información de disponibilidad. Ninguno
   de esos rechazos crea inscripción ni registra un alta exitosa; los cierres y
   liberaciones ya decididos se comprometen pese al conflicto. Si procede
   admitir, inscripción, resultado exitoso y activación durable del ámbito se
   guardarán juntos. No se prohíbe globalmente coexistir bloqueo e inscripción
   ni se modifica el endpoint de bloqueo por Q24.
3. **Orden de adjudicación.** Los huecos candidatos se examinarán por inicio
   ascendente y un desempate estable. Cada uno se ofrecerá a la primera
   inscripción elegible. Se acepta que las exclusiones dejen capacidad libre;
   no se buscará una combinación óptima global. El
   [ADR de adjudicación](docs/adr/0001-chronological-slot-allocation.md) conserva
   el motivo y un ejemplo de esa consecuencia.
4. **Límite de cancelación.** Una cita confirmada solo podrá cancelarse antes
   del inicio del hueco; en la igualdad o después se rechazará una cancelación
   nueva. Repetir una cancelación ya completada seguirá siendo idempotente,
   aunque la repetición llegue después del inicio. No se añaden estados de
   asistencia o realización de la prueba.
5. **Validez del aviso.** El consumidor comprobará inmediatamente antes de
   emitirlo que la reserva concreta sigue ofrecida y no ha vencido. Puede haber
   una cancelación o caducidad entre esa comprobación y la emisión del log; la
   garantía se refiere al instante de comprobación, no al de observación del
   aviso. Este incluirá el vencimiento persistido y comunicará una oferta sujeta
   a vigencia. La aceptación revalidará estado y plazo de forma atómica.
6. **Presupuesto de reintentos.** Para fallos transitorios se acepta un intento
   inicial y tres reintentos, con esperas de cinco segundos, treinta segundos y
   dos minutos desde el fallo anterior. Agotado el presupuesto, el trabajo se
   conservará en una DLQ para recuperación explícita. Una caída general de
   dependencias deberá pausar o limitar el consumo; las reentregas físicas de
   AMQP no equivalen automáticamente a nuevos intentos de procesamiento.

El plan de pruebas deberá cubrir el alta concurrente con una liberación, el
orden de adjudicación con exclusiones, la frontera de cancelación y su repetición,
y el presupuesto de reintentos. Para el aviso se comprobarán la validación previa
y la revalidación al aceptar; no se exigirá ausencia física de un log tardío si
el consumidor ya había superado una comprobación válida.

## Decisiones para el diseño técnico

El [documento consolidado](docs/functional-design.md) reúne reglas, contratos,
coordinación, tiempo, FIFO, mensajería, alternativas, pruebas previstas y
trazabilidad hasta Q26. La [referencia técnica](docs/technical-design.md) remite
a ese documento y recoge cómo reanudar `to-spec` tras limpiar el contexto.

Habrá un único relay habilitado por configuración y consumidores replicables,
sin elección de líder, bloqueo asesor ni relevo automático en la demo. El relay
publicará secuencialmente y conservará una próxima fecha durable tras un fallo,
permitiendo avanzar a otras publicaciones listas cuya ruta funcione.

Un rechazo válido guardará un único `SlotReleased`, que ya activa la revisión
completa del ámbito. No añadirá otra solicitud por ese mismo rechazo. Una
admisión real sin liberación que cubra su activación guardará
`AllocationReviewRequested` en la misma transacción.

Q17 conserva un límite físico finito en RabbitMQ y exige traslado seguro a DLQ
mediante `at-least-once`, `reject-publish` y DLX configurado. El presupuesto lógico
de PostgreSQL se mantiene separado; ambos motivos de aparcado serán recuperables.
La configuración y sus pruebas son trabajo pendiente, sin otra tecnología.

Q21 conserva los registros técnicos durante toda la vida de la demo, sin purgas
automáticas. Q22 hace prevalecer la caducidad al intentar cancelar un bloqueo
vencido y conserva las cancelaciones válidas anteriores. Q23 permite retirarse de
una inscripción ya cerrada sin alterar su causa, una cita confirmada ni una
reincorporación posterior.

Q25 hace prevalecer el estado actual en una confirmación repetida: `200` si la
reserva sigue `CONFIRMED`, o `409` con su identificación y estado `CANCELLED` si
después fue cancelada. No se repiten efectos ni se extiende a estas transiciones
sin clave la recuperación histórica inmutable de las creaciones.

Q26 diferencia en las consultas propias el estado persistido y la evaluación
temporal de PostgreSQL: vencimiento, cierre pendiente y acciones ya no permitidas.
Los GET no escriben ni emiten eventos; una `CONFIRMED` no caduca por su viejo plazo.

El grilling está cerrado para el alcance acordado hasta Q26. Los criterios
AC59–AC64 cubren el bloqueo propio, otros ámbitos, vencimiento durante la espera,
replays e inscripción existente y la convivencia permitida. AC65–AC67 cubren
Q25–Q26; AC68–AC69 hacen visibles límites ya aceptados de Q24 y del aviso.
Están implementados la consulta de agenda, los bloqueos, su consulta propia,
confirmación, cancelación y barrido de bloqueos vencidos con outbox, además del
alta/consulta/retirada de espera sin oferta y su prioridad. Las ofertas y la
publicación/consumo de mensajería siguen pendientes.

## Arranque con un comando

Requisitos: Docker con el motor en ejecución y Docker Compose. En macOS puede usarse
Docker Desktop. Las imágenes elegidas admiten ARM64 y AMD64.

```bash
docker compose up --build --wait
```

El comando construye una imagen de la aplicación y arranca API, worker, PostgreSQL
y RabbitMQ. Espera a que las comprobaciones de disponibilidad estén en verde.
Las credenciales de Compose son ficticias, exclusivas del entorno local sintético;
los puertos publicados se limitan a `127.0.0.1`.

```bash
curl --fail http://127.0.0.1:3000/health/ready
docker compose ps
docker compose exec worker node dist/bootstrap/check-connections.js
```

La última comprobación verifica el esquema `scheduling` y publica, confirma, recibe
y reconoce un mensaje en una cola AMQP exclusiva y efímera. La cola se elimina al
cerrar la conexión. No crea pacientes, citas ni mensajes de negocio.

## Consultar la agenda

```bash
curl --fail --get http://127.0.0.1:3000/slots \
  --data-urlencode hospitalId=hospital-north \
  --data-urlencode testTypeId=mri \
  --data-urlencode from=2020-01-01T00:00:00Z \
  --data-urlencode to=2100-01-01T00:00:00Z
```

Los cuatro filtros son obligatorios. Se incluyen los huecos cuyo inicio pertenece
a `[from,to)` y es estrictamente posterior a `evaluatedAt`. Un ámbito desconocido
devuelve `200` con una lista vacía. Los instantes requieren zona u offset explícito
y como máximo tres decimales; las respuestas usan UTC y tres decimales. Un intervalo
vacío, invertido o inválido produce `400`, también los parámetros desconocidos o
repetidos. Para offsets positivos, `--data-urlencode` conserva el signo `+`.

La respuesta contiene `evaluatedAt` y `slots`, ordenados por inicio e identificador.
Cada hueco expone `id`, `resourceId`, `hospitalId`, `testTypeId`, `startsAt`, `endsAt`
y `directlyBookable`; no incluye pacientes. Esta consulta pública de la demo no
requiere `X-Patient-Id`. PostgreSQL obtiene el tiempo truncado a milisegundos y los
huecos en una sola sentencia, con una fotografía coherente y sin escrituras.
Es información orientativa: una reserva posterior deberá revalidarla.

`directlyBookable` es falso si existe una reserva persistida en `HELD`, `OFFERED`
o `CONFIRMED`, aunque haya vencido su plazo temporal. GET no materializa cierres.
También es falso cuando hay una inscripción `WAITING` del ámbito que no excluyó
ese hueco. La prioridad se deriva de inscripciones y exclusiones, sin un marcador
persistente de adjudicación en el hueco; se mantiene con el consumidor detenido.

## Crear y consultar un bloqueo

La identidad de demostración se presenta mediante `X-Patient-Id`, con uno de los
tres pacientes sintéticos del seed. Esta cabecera puede falsificarse: demuestra
titularidad bajo la identidad presentada, no autenticación ni protección frente
a suplantación. No usar este modo con pacientes reales.

```bash
curl --fail -X POST http://127.0.0.1:3000/slots/slot-north-mri-1/holds \
  -H 'X-Patient-Id: patient-ana' \
  -H 'Idempotency-Key: ana-first-hold'
```

El POST no admite cuerpo: propietario, instante de creación y plazo los determina
el servidor. Devuelve `201` con `id`, `slotId`, estado `HELD`, `createdAt`,
`expiresAt`, `startsAt` y `endsAt`. El vencimiento es el menor entre creación más
diez minutos e inicio del hueco; desde la igualdad con el inicio no crea reserva.
El mismo paciente puede bloquear más de un hueco; no se añade una unicidad por
paciente ni se aplica aquí la regla de admisión Q24.

Guarda la clave antes del primer intento y conserva la misma para sus reintentos.
Misma clave, paciente, operación y destino recuperan el cuerpo y el `201`
originales, aunque la reserva haya cambiado después, sin ampliar plazo. Reutilizar
una clave exitosa para otro hueco da `409 IDEMPOTENCY_KEY_REUSED`; pacientes
distintos mantienen registros independientes. Un conflicto sin éxito previo se
reevalúa al reintentar y un rollback no conserva creación o éxito parciales.

Con el identificador devuelto:

```bash
curl --fail http://127.0.0.1:3000/reservations/ID_DEVUELTO \
  -H 'X-Patient-Id: patient-ana'
```

GET añade `evaluatedAt`, `temporal.expired`, `temporal.closurePending` y `actions`
(`canConfirm`, `canCancel`, `canRejectOffer`). El estado es siempre el persistido.
Si un temporal ha vencido, informa cierre pendiente y deshabilita las acciones,
sin modificar filas. Una confirmada no vence por su antiguo plazo. Las acciones
describen permisos funcionales de Q26. Confirmar y cancelar vuelven a validar
estado y tiempo; las operaciones de oferta se incorporarán en otra entrega.

Cabecera ausente o inválida, paciente inexistente, clave ausente o cuerpo dan
`400`; recurso inexistente o ajeno da el mismo `404 NOT_FOUND`. El POST responde
`409 SLOT_OCCUPIED` si ya existe un ocupante, y `409 SLOT_STARTED` si se alcanzó
el inicio. Devuelve `409 WAITING_LIST_PRIORITY` si existe espera elegible para
ese hueco libre. Los fallos transitorios identificables de PostgreSQL dan
`503 DEPENDENCY_UNAVAILABLE` también en GET; otros errores internos conservan
`500 INTERNAL_ERROR`. Puede reintentarse una creación incierta con su misma clave.

La transacción usa `READ COMMITTED`: coordina primero el registro único
paciente/operación/clave y recupera su resultado después de esperar; a continuación
bloquea la fila estable del ámbito, el hueco y sus reservas ordenadas por ID.
Hace lecturas nuevas tras adquirir la coordinación y pide
`date_trunc('milliseconds', clock_timestamp())` en otro comando después de leer
el estado protegido. Reserva y resultado se guardan con el mismo cliente antes
del commit. No mantiene bloqueos mientras responde HTTP o espera al paciente.
Un índice único parcial sobre estados ocupantes protege además la exclusividad,
incluidas filas vencidas aún sin cerrar. Ámbitos distintos avanzan de forma
independiente; el mismo ámbito serializa sus escrituras breves. La espera de
bloqueos se limita a dos segundos y las sentencias a 2,5 segundos.

### Confirmar, cancelar y caducar bloqueos directos

Las transiciones tampoco admiten cuerpo y se dirigen al ID concreto; no exigen
`Idempotency-Key`:

```bash
curl --fail -X POST http://127.0.0.1:3000/reservations/ID_DEVUELTO/confirm \
  -H 'X-Patient-Id: patient-ana'
curl --fail -X POST http://127.0.0.1:3000/reservations/ID_DEVUELTO/cancel \
  -H 'X-Patient-Id: patient-ana'
```

Confirmar un `HELD` vigente devuelve `200 CONFIRMED`, con el mismo ID y plazo
original. Repetir mientras siga confirmada devuelve `200`, incluso pasado el
antiguo TTL. Tras cancelarla, confirmar da `409 RESERVATION_STATE_CONFLICT` con
el ID y el estado actual `CANCELLED`; nunca toca una reserva posterior del hueco.

Cancelar un bloqueo vigente o una cita antes del inicio devuelve `200 CANCELLED`.
La repetición de una cancelación válida sigue devolviendo `200`, incluso tras
el inicio. Una cancelación nueva de una confirmada desde la igualdad con su
inicio responde `409 APPOINTMENT_STARTED` y conserva la cita. `OFFERED` exige las
operaciones de oferta y responde conflicto de estado en `/cancel`.

En la igualdad con el vencimiento o después, confirmar o cancelar un `HELD`
materializa `EXPIRED` y devuelve `409 RESERVATION_EXPIRED`. La caducidad y la
liberación se comprometen pese a ese conflicto; repetir no crea más trabajo.
Un fallo técnico revierte toda la transacción. El reloj es de PostgreSQL,
obtenido tras esperar los bloqueos; no se usa el inicio de la transacción para
conceder vigencia adicional.

El worker inicializa esquema/seed con la misma coordinación que la API antes de
barrer. Busca hasta 100 bloqueos vencidos por pasada, ordenados por vencimiento
e ID, y revalida cada uno bajo el mismo protocolo de ámbito, hueco y reserva.
Recupera atrasos aunque el hueco ya haya empezado; una confirmada no caduca por
su viejo TTL. El intervalo predeterminado es tres segundos; no acredita un plazo
máximo de liberación.

Cada cierre guarda atómicamente estado, causa en `reservation_closures`, un
`SlotReleased` v1 en `events` y una fila en `outbox_publications`. La clave única
de cierre por reserva protege una única liberación lógica. El evento contiene
ámbito, hueco, reserva y causa, sin datos clínicos. El ID de publicación es
distinto del ID del evento; consumidor lógico (`allocation`), ciclo e intento
iniciales se conservan como referencias separadas para las siguientes entregas.
Las tablas se retienen sin purgas. La publicación no está conectada todavía:
RabbitMQ inaccesible no impide guardar negocio y outbox, pero aún no hay revisión
de lista ni avisos a través del broker.

Para acortar una demostración local puede configurarse `DIRECT_HOLD_TTL_MS` en la
API, entre 1 y 600000 ms (predeterminado 600000). Nunca amplía el plazo de diez
minutos y siempre se limita al inicio. `EXPIRY_SWEEP_INTERVAL_MS` configura el
intervalo del worker, positivo y predeterminado 3000 ms. En ejecución con Node,
estas variables pueden añadirse al `.env` local; Compose conserva los valores
predeterminados. No se promete todavía el recorrido completo ni la prioridad
de lista del ticket siguiente.

## Disponibilidad y recuperación

| Proceso | Comprobación | Dependencias para estar disponible |
| --- | --- | --- |
| API | `GET /health/live` | Proceso HTTP en ejecución |
| API | `GET /health/ready` | PostgreSQL accesible y agenda inicializada y validada |
| Worker | `GET /health/live` en su puerto interno 3001 | Proceso en ejecución |
| Worker | `GET /health/ready` en su puerto interno 3001 | PostgreSQL y RabbitMQ accesibles |

La API no abre una conexión AMQP. Puede seguir disponible durante una caída del
broker; la outbox permanece pendiente. El worker barre bloqueos aunque RabbitMQ
esté inaccesible, revisa PostgreSQL cada tres segundos de forma predeterminada y
vuelve a conectar a RabbitMQ tras una desconexión.
Una dependencia no disponible produce estado HTTP 503; el proceso sigue vivo para
recuperarse. Ambos procesos cierran sus recursos al recibir `SIGINT` o `SIGTERM`.

```bash
docker compose logs --follow api worker
```

El worker todavía no publica ni consume trabajos de outbox. Ya ejecuta el barrido
de bloqueos directos y conserva las conexiones y su estado de disponibilidad.

## Alta, consulta y retirada de espera

```bash
curl -X POST http://127.0.0.1:3000/waiting-list-entries \
  -H 'Content-Type: application/json' \
  -H 'X-Patient-Id: patient-ana' \
  -H 'Idempotency-Key: ana-waiting-1' \
  -d '{"hospitalId":"hospital-north","testTypeId":"mri"}'
curl --fail http://127.0.0.1:3000/waiting-list-entries/ID_DEVUELTO \
  -H 'X-Patient-Id: patient-ana'
curl --fail -X POST http://127.0.0.1:3000/waiting-list-entries/ID_DEVUELTO/withdraw \
  -H 'X-Patient-Id: patient-ana'
```

El alta exige la clave y únicamente hospital/tipo de prueba en el cuerpo. Primero
recupera un éxito anterior con su código original. Para una clave nueva coordina
el ámbito, bloquea las filas por orden estable y obtiene el reloj de PostgreSQL.
Materializa los bloqueos propios vencidos, incluidos los huecos ya iniciados.
Una inscripción realmente activa se devuelve con `200` y guarda ese éxito para
la clave nueva, sin cambiar antigüedad ni exclusiones. Antes de una admisión
nueva también cierra los bloqueos ajenos vencidos de huecos futuros.

Q24 tiene precedencia: un `HELD` propio vigente del mismo ámbito responde
`409 ACTIVE_HOLD_IN_SCOPE`. Sin él, si existe capacidad directamente reservable,
responde `409 DIRECT_CAPACITY_AVAILABLE` con `slots` públicos: ID, ámbito e
inicio/fin; esas referencias permiten continuar por el endpoint de bloqueo y no
reservan nada. Ambos conflictos conservan las caducidades y liberaciones ya
decididas, sin crear inscripción, prioridad latente ni éxito para la clave.
Un bloqueo en otro ámbito no activa Q24. Tampoco lo activa una cita confirmada;
no hay prohibición general de coexistencia entre reserva e inscripción.

Si no hay impedimentos, `201` devuelve una inscripción `WAITING`, con ID nuevo,
`admissionOrder` como entero decimal en texto, `createdAt`, ámbito y exclusiones.
Bajo el bloqueo del ámbito, el siguiente orden es el máximo histórico más uno;
la retención del historial y la unicidad de ámbito/orden conservan FIFO incluso
con tiempos empatados. Un índice parcial asegura una sola inscripción activa
por paciente y ámbito. Inscripción, éxito de clave y revisión durable se guardan
juntos. El evento `AllocationReviewRequested` v1 incluye ámbito, inscripción y
causa de admisión, con publicación pendiente para `allocation`. Si una liberación
de esa misma transacción ya activa el ámbito, no se añade otro evento de revisión.

GET solo permite consultar la inscripción propia bajo la identidad presentada.
Añade `evaluatedAt`, evaluación temporal y `canWithdraw`; una espera sin oferta
no tiene vencimiento ficticio y la consulta no escribe. Retirarse de `WAITING`
cierra con causa `WITHDRAWN` y devuelve `200`. Repetir sobre una inscripción
cerrada conserva su causa y no modifica otra inscripción posterior ni una cita.
Reinscribirse tras el cierre usa una clave nueva y, si procede, identidad y orden
nuevos. Repetir una clave exitosa sigue devolviendo su representación histórica;
GET devuelve el estado actual. Una clave exitosa reutilizada para otro ámbito da
`409 IDEMPOTENCY_KEY_REUSED`; las claves se separan por paciente y operación.

Esta entrega no crea ofertas ni consume las activaciones. La asociación de oferta,
su aceptación/rechazo, retirada con oferta y normalización de ofertas vencidas
completan Q2/Q23/Q26 y los criterios compartidos en las entregas #8–#10. Los estados
preparados para ofertas y las exclusiones no acreditan esos recorridos todavía.

## Desarrollo local

Node y pnpm tienen sus versiones fijadas en `.nvmrc` y `package.json`. Con nvm:

```bash
nvm install
nvm use
npm install --global pnpm@12.21.0
```

Si utilizas otro gestor de Node, selecciona igualmente la versión de `.nvmrc`.
La imagen Docker contiene su propio runtime; el equipo evaluador solo necesita
Docker y Compose.

Si ya arrancaste todo mediante Compose, detén antes API y worker para liberar
los puertos de los procesos que ejecutarás en el host:

```bash
docker compose stop api worker
```

```bash
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up --wait postgres rabbitmq
pnpm dev:api
```

En otra terminal, desde el mismo directorio y con la versión de Node seleccionada:

```bash
pnpm dev:worker
```

Los dos comandos observan los cambios y ejecutan TypeScript mediante el soporte
nativo estable de Node. La compilación para la imagen genera JavaScript:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm check:connections
```

Las pruebas de integración requieren una base de pruebas aislada, nunca una base
con datos que se deban conservar. Un ejemplo con un proyecto y puerto propios:

```bash
POSTGRES_PORT=55434 docker compose -p agenda-tests up --wait postgres
TEST_DATABASE_URL=postgresql://diagnostic:diagnostic_dev@127.0.0.1:55434/diagnostic_appointments pnpm test:integration
```

`pnpm test` ejecuta las reglas puras; `pnpm test:integration` comprueba el contrato
HTTP con Fastify `inject` y PostgreSQL real. Las consultas se comprueban también
con una conexión de solo lectura. La concurrencia arranca dos procesos Node con
pools propios y usa una conexión controladora que retiene el ámbito; un observador
verifica esperas reales y sus cadenas con `pg_stat_activity`/`pg_blocking_pids`
antes de soltarlo. Cubre tres pacientes competidores, ámbitos independientes,
misma clave entre instancias, respuesta no leída y cruce del inicio durante la
espera. Las transiciones añaden carreras de confirmación/cancelación/barrido,
cruce real del vencimiento tras la barrera y un orden forzado donde el worker
vence primero. La lista añade ambos órdenes de alta/directa y alta/liberación,
claves iguales/distintas entre procesos y cruce del vencimiento del bloqueo
propio con capacidad directa o prioridad previa de otro paciente. El consumidor
permanece detenido: GET y POST siguen respetando la prioridad. Las fronteras exactas de igualdad y 1 ms se comprueban en reglas
puras con tiempo explícito, sin atribuir fake timers de JavaScript a PostgreSQL.
Los fallos SQL por permisos en la escritura final del resultado o de outbox
acreditan rollback completo y permiten reintentar. El usuario SQL de esta base
aislada debe poder crear/eliminar roles temporales y crear bases de pruebas.
La prueba del worker arranca API y worker sobre otra base vacía, usa un TTL
acortado, conserva la liberación con AMQP inaccesible y comprueba retención de la
outbox al reiniciar el worker.
También comprueba reinicialización, rechazo de solapamientos, restricciones,
titularidad sintética, plazos, replay, lectura conservadora, unicidad con ocupante
vencido y clasificación de fallos. `pnpm typecheck` comprueba
aplicación, pruebas y configuración con TypeScript estricto; `pnpm build` genera
la aplicación. CI ejecuta esos mismos comandos con PostgreSQL real. No hay lint ni
formato automáticos configurados, ni se atribuye a `inject` cobertura de red E2E.

Si utilizas VS Code mediante SSH, reenvía el puerto 3000 desde la ventana remota
para acceder a la API desde el navegador del portátil.

## Configuración y datos

`.env.example` documenta las conexiones del modo local. Compose configura sus
conexiones internas mediante los nombres `postgres` y `rabbitmq`.

| Variable | Uso |
| --- | --- |
| `DATABASE_URL` | Conexión PostgreSQL de API y worker |
| `RABBITMQ_URL` | Conexión AMQP del worker y de la comprobación de conexiones |
| `HOST` | Dirección de escucha; `127.0.0.1` local y `0.0.0.0` dentro del contenedor |
| `API_PORT` | Puerto de la API; 3000 por defecto |
| `WORKER_HEALTH_PORT` | Comprobaciones del worker local; 3001 por defecto |
| `DIRECT_HOLD_TTL_MS` | TTL de bloqueo de la API; 600000 por defecto, entre 1 y 600000 ms |
| `EXPIRY_SWEEP_INTERVAL_MS` | Intervalo positivo de barrido del worker; 3000 ms por defecto |
| `POSTGRES_PORT`, `RABBITMQ_PORT` | Puertos publicados por Compose; 5432 y 5672 por defecto |

Si cambias un puerto publicado de PostgreSQL o RabbitMQ, ajusta también la URL
correspondiente del modo local. Los servicios de Compose conservan sus puertos
internos. La API de Compose escucha internamente en 3000.

PostgreSQL conserva su volumen entre arranques. `db/schema.sql` define hospitales,
tipos, recursos, pacientes sintéticos, ámbitos, huecos, reservas, resultados de
creación, causas de cierre, eventos y publicaciones de outbox, con claves que
impiden mezclar ámbitos y restricciones que exigen intervalos no vacíos,
milisegundos y un ocupante por hueco.
API y worker ejecutan esquema y seed en una transacción de inicialización
coordinada, validan automáticamente la agenda completa y solo después sirven
negocio o ejecutan el barrido.
Una agenda solapada de un mismo recurso impide arrancar la API. El worker exige
la marca de validación para anunciar disponibilidad. RabbitMQ tiene su propio
volumen y un nombre de nodo estable.

El seed contiene cinco huecos en tres ámbitos, cuatro recursos y tres pacientes
(`patient-ana`, `patient-bruno`, `patient-carlos`). El primer arranque fija el
ancla al día siguiente a las 09:00 UTC en `scheduling.demo_seed`; los arranques
posteriores insertan solo las filas ausentes usando esa misma ancla y nunca
desplazan fechas existentes. Los huecos contiguos y simultáneos de recursos
distintos son válidos. El dataset queda por debajo de veinte futuros por ámbito;
ese límite no restringe el endpoint. Tras pasar sus fechas, la agenda deja de
tener huecos futuros: para otra demostración se requiere la recreación explícita
del entorno sintético, no un reinicio normal.

Los scripts SQL de PostgreSQL se ejecutan sobre un volumen vacío; además API y worker
los aplican de forma idempotente antes de servir. No se ofrecen migraciones de
bases pobladas. Para recrear explícitamente toda la demo, el siguiente
comando elimina los volúmenes y sus datos locales:

```bash
docker compose down --volumes
docker compose up --build --wait
```

Para detenerlo conservando los datos:

```bash
docker compose down
```

## Decisiones y alternativas

| Elección | Versión | Motivo |
| --- | --- | --- |
| Node.js | 26.13.1 LTS | Runtime mantenido y soporte nativo de TypeScript para desarrollo |
| TypeScript | 6.0.3 | Versión estable mantenida y compatible con la preparación de calidad prevista |
| pnpm | 12.21.0 | Versión y lockfile fijados |
| Fastify | 5.12.8 | HTTP directo con composición explícita y política LTS |
| PostgreSQL | 18.7 | Transacciones y restricciones para exclusividad e idempotencia |
| `pg` | 8.23.1 | SQL y cliente transaccional explícitos, sin ORM |
| RabbitMQ | 4.4.0 | Broker independiente de la base de datos, con soporte comunitario vigente |
| `amqplib` | 2.3.1 | Control directo de conexiones, confirmaciones y acuses AMQP |
| Vitest | 5.1.0 | Pruebas de reglas puras, contrato HTTP e integración SQL |

Usamos LTS cuando existe y versiones estables soportadas en el resto. RabbitMQ
distingue soporte comunitario y soporte prolongado comercial; no se presupone una
licencia comercial. Las imágenes y dependencias se fijan para reproducir el entorno.

Un único paquete TypeScript contiene dos puntos de entrada y produce una imagen
común. API y worker se ejecutan por separado. Frente al workspace de pnpm, esta
opción reduce la configuración inicial y mantiene los módulos dentro del mismo
paquete. La separación de responsabilidades permitirá extraer paquetes cuando
exista una necesidad concreta.

```text
src/
├── bootstrap/                     Composición y ciclo de vida de cada proceso
├── config/                        Lectura de configuración por proceso
└── scheduling/
    ├── domain/                    Reglas puras de agenda, plazos y evaluación
    ├── application/               Casos de uso y puerto transaccional de citación
    └── adapters/
        ├── http/                  Contrato HTTP e identidad sintética
        ├── postgres/              Coordinación, persistencia y reloj autoritativo
        └── rabbitmq/              Conexión AMQP
```

Las reglas no importan HTTP, SQL ni AMQP. Los casos de uso acceden a un único
puerto de citación con un callback transaccional y operaciones concretas; el
cliente `pg` permanece dentro del adaptador. Se evita un mutex en memoria, que
no coordinaría instancias, y repositorios CRUD genéricos, que ocultarían la
atomicidad necesaria. Los bloqueos pesimistas del ámbito simplifican este
ejercicio frente a detectar conflictos de varias escrituras al final.

## Alcance pendiente

- Adjudicación, aceptación/rechazo de ofertas, retirada con oferta y caducidad de
  ofertas/reinscripción; completar sus criterios compartidos con el alta actual.
- Relay de la outbox, consumidores idempotentes, avisos asíncronos, reintentos y DLQ.
  Negocio y trabajo durable ya se guardan atómicamente en PostgreSQL.
- Ampliar las suites y CI al entregar las siguientes funcionalidades. Herramientas
  adicionales de lint/formato siguen siendo propuestas.

## Mensajería: garantías previstas

La comprobación técnica actual usa confirmaciones del publicador y acuse del
mensaje recibido, en una cola efímera. Todavía no hay garantías de entrega de
eventos de citación implementadas.

La estrategia acordada para la siguiente fase funcional es entrega al menos una
vez: cambio de negocio y evento pendiente ya se guardan en una misma transacción;
el futuro publicador recuperará pendientes y confirmará su publicación. Una caída entre
publicar y registrar el envío puede producir duplicados. El consumidor deduplicará
el mensaje y aplicará su efecto en una misma transacción antes de reconocerlo.
La validez de cada transición deberá comprobarse para gestionar mensajes que lleguen
desordenados. Estos comportamientos necesitarán pruebas con PostgreSQL y RabbitMQ
reales cuando se implementen.

## Datos de pacientes en un entorno real

Diseñaría el modelo para almacenar la mínima información necesaria y usar
identificadores de paciente opacos. Separaría los datos clínicos de la citación
cuando corresponda, aplicaría permisos por función y hospital, conexiones cifradas,
gestión externa de secretos y auditoría de acceso. Los logs evitarían datos de
pacientes. La retención, las copias de seguridad y su restauración formarían parte
del diseño operativo y de las políticas de la organización.

## Evolución a una red de hospitales

El modelo deberá expresar el hospital, el recurso diagnóstico, sus horarios y la
zona horaria. Las reglas de exclusividad y autorización tendrán que respetar ese
ámbito. API y worker podrán replicarse por separado; antes de aumentar réplicas
será necesario demostrar el comportamiento concurrente de la adjudicación y el
tratamiento de reentregas. La evolución incluirá capacidad de base de datos,
observabilidad del retraso del outbox y de las colas, recuperación y despliegues
compatibles con el estado persistido.
