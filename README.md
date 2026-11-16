# Citación de pruebas diagnósticas

Implementación de la [prueba de arquitectura de software](docs/diagnostic-appointment-requirements.pdf).
Esta entrega permite arrancar una agenda sintética validada y consultarla por HTTP.
Los bloqueos, las citas y la lista de espera corresponden a las siguientes entregas.

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
   intervalos solapados de un mismo recurso. La exclusividad concurrente que
   implementará el servicio será por hueco; esa garantía, por sí sola, no impide
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
La implementación de reservas, lista de espera y mensajería de negocio sigue
pendiente. Los comandos siguientes incluyen la consulta de agenda ya entregada.

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

En esta primera entrega todos los huecos futuros son directamente reservables:
todavía no existen reservas ni inscripciones. Los siguientes tickets incorporarán
la ocupación persistida y la prioridad elegible a esa misma consulta.

## Disponibilidad y recuperación

| Proceso | Comprobación | Dependencias para estar disponible |
| --- | --- | --- |
| API | `GET /health/live` | Proceso HTTP en ejecución |
| API | `GET /health/ready` | PostgreSQL accesible y agenda inicializada y validada |
| Worker | `GET /health/live` en su puerto interno 3001 | Proceso en ejecución |
| Worker | `GET /health/ready` en su puerto interno 3001 | PostgreSQL y RabbitMQ accesibles |

La API no abre una conexión AMQP. Puede seguir disponible durante una caída del
broker, coherentemente con el outbox que se implementará después. El worker revisa
PostgreSQL cada tres segundos y vuelve a conectar a RabbitMQ tras una desconexión.
Una dependencia no disponible produce estado HTTP 503; el proceso sigue vivo para
recuperarse. Ambos procesos cierran sus recursos al recibir `SIGINT` o `SIGTERM`.

```bash
docker compose logs --follow api worker
```

El worker todavía no consume trabajos de citación. Mantiene las conexiones y
expone su estado para comprobar la preparación técnica.

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
HTTP con Fastify `inject` y PostgreSQL real. La lectura usa una conexión PostgreSQL
de solo lectura. También comprueba reinicialización, rechazo de solapamientos y
restricciones de intervalo y coherencia de recursos. `pnpm typecheck` comprueba
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
| `POSTGRES_PORT`, `RABBITMQ_PORT` | Puertos publicados por Compose; 5432 y 5672 por defecto |

Si cambias un puerto publicado de PostgreSQL o RabbitMQ, ajusta también la URL
correspondiente del modo local. Los servicios de Compose conservan sus puertos
internos. La API de Compose escucha internamente en 3000.

PostgreSQL conserva su volumen entre arranques. `db/schema.sql` define hospitales,
tipos, recursos, pacientes sintéticos, ámbitos y huecos, con claves que impiden
mezclar ámbitos y restricciones que exigen intervalos no vacíos y milisegundos.
La API ejecuta esquema y seed en una transacción de inicialización coordinada,
valida automáticamente la agenda completa y solo después empieza a escuchar.
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

Los scripts SQL de PostgreSQL se ejecutan sobre un volumen vacío; además la API
los aplica de forma idempotente antes de servir. No se ofrecen migraciones de
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
| PostgreSQL | 18.7 | Versión estable soportada; transacciones y restricciones para la futura citación |
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
    └── adapters/
        ├── http/                  API, agenda y comprobaciones de disponibilidad
        ├── postgres/              Pool, inicialización validada y lectura de agenda
        └── rabbitmq/              Conexión AMQP
```

`scheduling/domain/` contiene la validación pura de agenda e instantes;
`scheduling/application/` define el contrato de lectura. No se imponen repositorios
CRUD genéricos ni se adelantan transacciones de funcionalidades aún pendientes.

## Alcance pendiente

- Funcionalidades del PDF: bloqueos con caducidad, confirmaciones,
  cancelaciones, exclusividad bajo concurrencia y lista de espera con ofertas.
- Transactional Outbox e Idempotent Consumer, acordados para la entrega funcional.
- Ampliar las suites y CI al entregar las siguientes funcionalidades. Herramientas
  adicionales de lint/formato siguen siendo propuestas.

## Mensajería: garantías previstas

La comprobación técnica actual usa confirmaciones del publicador y acuse del
mensaje recibido, en una cola efímera. Todavía no hay garantías de entrega de
eventos de citación implementadas.

La estrategia acordada para la siguiente fase funcional es entrega al menos una
vez: cambio de negocio y evento pendiente se guardarán en una misma transacción;
el publicador recuperará pendientes y confirmará su publicación. Una caída entre
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
