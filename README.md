# Citación de pruebas diagnósticas

Preparación técnica de la [prueba de arquitectura de software](docs/diagnostic-appointment-requirements.pdf).
Esta entrega prepara el entorno y sus conexiones. La agenda, los bloqueos, las citas
y la lista de espera se implementarán en las siguientes entregas funcionales.

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

## Disponibilidad y recuperación

| Proceso | Comprobación | Dependencias para estar disponible |
| --- | --- | --- |
| API | `GET /health/live` | Proceso HTTP en ejecución |
| API | `GET /health/ready` | PostgreSQL accesible y esquema inicializado |
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
pnpm check:connections
```

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

PostgreSQL conserva su volumen entre arranques. `db/schema.sql` crea el esquema
`scheduling`; `db/seed.sql` comprueba la inicialización sin cargar datos de negocio.
RabbitMQ tiene su propio volumen y un nombre de nodo estable.

Los scripts de inicialización se ejecutan sobre un volumen vacío. Al cambiar el
esquema durante el ejercicio, regeneraremos explícitamente el entorno. El siguiente
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
        ├── http/                  API y comprobaciones de disponibilidad
        ├── postgres/              Pool y comprobación del esquema
        └── rabbitmq/              Conexión AMQP
```

El dominio y los casos de uso se incorporarán a `scheduling/domain/` y
`scheduling/application/` al trabajar las funcionalidades. No se crean modelos,
repositorios genéricos ni reglas de negocio de ejemplo durante esta preparación.

## Alcance pendiente

- Funcionalidades del PDF: agenda, bloqueos con caducidad, confirmaciones,
  cancelaciones, exclusividad bajo concurrencia y lista de espera con ofertas.
- Transactional Outbox e Idempotent Consumer, acordados para la entrega funcional.
- Seed de negocio, con datos exclusivamente sintéticos.
- Preparación de calidad: configuración de Vitest, suites automatizadas, lint,
  formato y CI. Se abordará en la siguiente fase de preparación.

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
