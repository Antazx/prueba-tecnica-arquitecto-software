# Trazabilidad de aceptación

Fuente normativa: [diseño funcional, revisión 5](functional-design.md), AC01–AC69.
Esta matriz enlaza comportamientos con pruebas concretas de la entrega. No es una
prueba de todas las permutaciones ni una promesa de HA, capacidad o recepción humana.
`U/` significa [test/unit](../test/unit/) e `I/`, [test/integration](../test/integration/).
Los nombres abreviados indican el caso o sus variantes, buscables en el archivo.
Las garantías SQL/AMQP se verifican contra PostgreSQL/RabbitMQ reales; igualdad
exacta de milisegundos se demuestra en reglas puras, no con fake timers sobre BD.

## Criterios y fronteras verificadas

| AC | Pruebas y evidencia | Alcance concreto |
| --- | --- | --- |
| AC01 | [U/agenda](../test/unit/agenda.test.ts); [I/agenda](../test/integration/agenda.test.ts): “refuses startup with an overlapping resource agenda” | Validación de solapamientos de un recurso y rechazo del arranque real. |
| AC02 | [U/agenda](../test/unit/agenda.test.ts); [I/agenda](../test/integration/agenda.test.ts): “rejects an empty slot and a resource from another scope” | Intervalos contiguos/recursos distintos válidos; vacío y mezcla de ámbito rechazados. |
| AC03 | [I/holds-concurrency](../test/integration/holds-concurrency.test.ts): “admits exactly one of three competing patients” | Tres pacientes, dos procesos/pools, esperas PG observadas, 201/409/409 y un ocupante. |
| AC04 | [I/holds-concurrency](../test/integration/holds-concurrency.test.ts): “lets a distinct scope commit”; [I/waiting-list-concurrency](../test/integration/waiting-list-concurrency.test.ts) | Independencia entre ámbitos mientras otro espera; serialización dentro del ámbito. |
| AC05 | [I/waiting-list-concurrency](../test/integration/waiting-list-concurrency.test.ts): “serializes join/direct” (ambos órdenes) | Alta primero informa capacidad; hold primero permite alta posterior. |
| AC06 | [I/waiting-list](../test/integration/waiting-list.test.ts): “keeps eligible waiting priority” | Consumidor detenido, GET false y hold 409; al retirar toda espera vuelve a reservarse. |
| AC07 | [U/offers](../test/unit/offers.test.ts): “visits all future slots chronologically”; [I/offer-decisions](../test/integration/offer-decisions.test.ts): H1/H2 excluded-prefix | Continúa tras prefijos sin candidato y revisa H2 sin nuevo estímulo. |
| AC08 | [I/offers](../test/integration/offers.test.ts): “uses chronological slot IDs and FIFO regardless of message order” | Inicio empatado e IDs estables; inscripciones con `created_at` idéntico conservan FIFO por entero persistido. |
| AC09 | [U/offers](../test/unit/offers.test.ts): “without global matching”; [I/offers](../test/integration/offers.test.ts): “documented matching cost” | Regla pura deja capacidad libre por exclusiones; integración conserva ese criterio y ofrece un tercer hueco posterior a Bruno. |
| AC10 | [I/offers](../test/integration/offers.test.ts): “regardless of message order” | Consume publicaciones persistidas en orden inverso; no presupone orden inverso garantizado por broker. |
| AC11 | [I/waiting-list-concurrency](../test/integration/waiting-list-concurrency.test.ts): join/release ambos órdenes; [I/acceptance-variants](../test/integration/acceptance-variants.test.ts): “AC59/AC11” | Incluye liberación consumida y terminada antes de alta Q2, sin depender de reentrega. |
| AC12 | [I/waiting-list](../test/integration/waiting-list.test.ts): “returns the actual active entry”; [I/offer-expiry](../test/integration/offer-expiry.test.ts): “normalizes a new rejoining intention”, “live offer despite a coexisting own hold” | Clave nueva recupera activa con 200; normaliza oferta vencida antes; guarda éxito histórico K2. |
| AC13 | [I/offer-decisions](../test/integration/offer-decisions.test.ts): “H1/H2” seis variantes | Solo rechazo HTTP activa H2 ya revisado: base, prefijo excluido, caída antes del relay, duplicados, origen reocupado o iniciado. |
| AC14 | [U/reservation](../test/unit/reservation.test.ts) y [U/offers](../test/unit/offers.test.ts); [I/holds](../test/integration/holds.test.ts), [I/offers](../test/integration/offers.test.ts), [I/offer-expiry-e2e](../test/integration/offer-expiry-e2e.test.ts) | Plazos recortados al inicio, hold máximo diez minutos, oferta dos horas por defecto configurable; no crear ventana vacía. |
| AC15 | [U/reservation](../test/unit/reservation.test.ts): confirmación HELD/OFFERED a -1/0/+1 ms; [I/offers](../test/integration/offers.test.ts): “preserves a substitute offer when an old expired offer is accepted again” | Aceptación tardía no revive R1 ni cambia R2; integración no atribuye igualdad exacta al reloj PG. |
| AC16 | [U/offer-decisions](../test/unit/offer-decisions.test.ts): rechazo -1/0/+1; [I/offer-decisions](../test/integration/offer-decisions.test.ts) | Antes conserva FIFO/excluye; al vencer cierra EXPIRED con conflicto. |
| AC17 | [I/offer-decisions](../test/integration/offer-decisions.test.ts): “repeats a past valid rejection” | Replay válido, exclusión/liberación únicas, oferta posterior intacta tras deadline anterior. |
| AC18 | [U/reservation](../test/unit/reservation.test.ts): cancelación inicio -1/0/+1; [I/reservation-lifecycle](../test/integration/reservation-lifecycle.test.ts) | Cita iniciada intacta con 409; repetición de cancelación ya completada válida. |
| AC19 | [U/reservation](../test/unit/reservation.test.ts): hold -1/0/+1; [I/reservation-lifecycle](../test/integration/reservation-lifecycle.test.ts) | Cancelación tardía de hold compromete caducidad y liberación única. |
| AC20 | [I/reservation-lifecycle-concurrency](../test/integration/reservation-lifecycle-concurrency.test.ts): “rechecks PostgreSQL time”, “wait across the slot start”; [I/offer-decisions](../test/integration/offer-decisions.test.ts), [I/offer-expiry](../test/integration/offer-expiry.test.ts) | Dos APIs esperan y cruzan vencimiento o inicio de cita; decisión usa tiempo protegido posterior. |
| AC21 | [U/offer-decisions](../test/unit/offer-decisions.test.ts); [I/waiting-list](../test/integration/waiting-list.test.ts); [I/offer-decisions](../test/integration/offer-decisions.test.ts) | Retirada WAITING, OFFERED vigente y vencida; causa real, sin reactivar espera. |
| AC22 | [I/offer-decisions](../test/integration/offer-decisions.test.ts): “serializes” accept-first/withdraw-first | Dos procesos y barreras: ACCEPTED conserva cita; WITHDRAWN impide aceptar; vencimiento prevalece. |
| AC23 | [I/waiting-list](../test/integration/waiting-list.test.ts): “preserves closed cause”; [I/offer-decisions](../test/integration/offer-decisions.test.ts): “preserves an accepted appointment” | Retirada I1 cerrada no altera I2 ni cita; causas ACCEPTED/EXPIRED/WITHDRAWN. |
| AC24 | [I/reservation-lifecycle-concurrency](../test/integration/reservation-lifecycle-concurrency.test.ts); [I/offer-expiry](../test/integration/offer-expiry.test.ts); [I/offer-decisions](../test/integration/offer-decisions.test.ts): sweep/request | Barrido compite con confirmación/cancelación/rechazo/retirada; cierre, causa e intención de liberación coherentes. |
| AC25 | [I/acceptance-variants](../test/integration/acceptance-variants.test.ts): “AC25: a restarted worker”; [I/expiry-worker](../test/integration/expiry-worker.test.ts) | HELD y OFFERED vencen durante parada y cierran al volver; CONFIRMED con antiguo plazo pasado permanece. |
| AC26 | [I/agenda](../test/integration/agenda.test.ts); [I/holds](../test/integration/holds.test.ts): “pending expiry without writing”; [I/waiting-list](../test/integration/waiting-list.test.ts): prioridad | GET read-only, conservador con ocupación persistida y espera elegible; POST revalida. |
| AC27 | [U/instant](../test/unit/instant.test.ts); [I/agenda](../test/integration/agenda.test.ts); [I/holds](../test/integration/holds.test.ts): “truncates a PostgreSQL internal clock” | Zona obligatoria, precisión externa excesiva rechazada y truncado interno real sin redondeo. |
| AC28 | [I/holds-concurrency](../test/integration/holds-concurrency.test.ts): “coordinates the same patient and key”, “client disconnects”; [I/waiting-list-concurrency](../test/integration/waiting-list-concurrency.test.ts) | Reintentos multiproceso y respuesta de hold no leída conservan ID/plazo/evento; alta concurrente única. |
| AC29 | [I/holds](../test/integration/holds.test.ts): “incompatible destination”; [I/waiting-list](../test/integration/waiting-list.test.ts): “separates successful keys by operation” | Claves independientes por paciente/operación; destino incompatible 409. |
| AC30 | [I/waiting-list](../test/integration/waiting-list.test.ts); [I/offer-expiry](../test/integration/offer-expiry.test.ts): reinscripción priority/capacity/own-hold × swept; [I/acceptance-variants](../test/integration/acceptance-variants.test.ts) AC63 | Normalización antes de nueva admisión, causas, histórico y claves nuevas sin falsas inscripciones. |
| AC31 | [I/holds](../test/integration/holds.test.ts); [I/waiting-list](../test/integration/waiting-list.test.ts): rollback outbox/result; [I/offers](../test/integration/offers.test.ts); [I/offer-decisions](../test/integration/offer-decisions.test.ts); [I/offer-expiry](../test/integration/offer-expiry.test.ts): deferred commit | Fallos SQL reales revierten negocio, claves, activación y resultado; no éxito parcial. |
| AC32 | [I/holds](../test/integration/holds.test.ts); [I/waiting-list](../test/integration/waiting-list.test.ts); [I/reservation-lifecycle](../test/integration/reservation-lifecycle.test.ts); [I/offer-decisions](../test/integration/offer-decisions.test.ts) | Validación HTTP y 404 uniforme para ajeno/inexistente bajo identidad presentada; no prueba autenticación. |
| AC33 | [I/acceptance-variants](../test/integration/acceptance-variants.test.ts): “AC68/AC33” | Proxy TCP AMQP inaccesible → cancelación HTTP y outbox de esa intención → reparación → oferta/aviso real. |
| AC34 | [I/offers](../test/integration/offers.test.ts): “relay dies after broker confirmation” | SIGKILL tras confirmación real y antes del marcador SQL: reenvío físico, un efecto SQL. |
| AC35 | [I/relay-recovery](../test/integration/relay-recovery.test.ts): “AC35”, timeout, fechas, envío SQL incierto | P2 progresa mientras P1 no tiene ruta; fecha durable tras reinicio, conexión vieja retirada, W2 no se promociona. |
| AC36 | [I/offers](../test/integration/offers.test.ts): “in-flight allocation after SIGKILL before commit”, “between SQL commit and ack”, duplicados | Muerte con INSERT de outbox bloqueado tras escrituras no comprometidas revierte; reentrega única. Otra prueba cubre postcommit/preack. |
| AC37 | [I/message-retries](../test/integration/message-retries.test.ts): “retains a committed failure across SIGKILL”; ciclo transportado | Fallo/intento siguiente guardados antes del ack y conservados tras reiniciar, sin adelantar fecha. |
| AC38 | [I/message-retries](../test/integration/message-retries.test.ts): “duplicate win after rollback”, “uncertain successful commit” | Proxy PG retiene rollback/pierde respuesta commit; terminal ganador evita fallo incompatible. |
| AC39 | [U/message-retries](../test/unit/message-retries.test.ts); [I/message-retries](../test/integration/message-retries.test.ts): “four real transported attempts” | Esperas reales 5/30/120 s, cuatro intentos y aparcado; envíos nunca anteriores a not_before. |
| AC40 | [U/notification](../test/unit/notification.test.ts); [I/message-retries](../test/integration/message-retries.test.ts): permanente, outage BD, salida rota y “shared output stalls” | Permanente aparca; inválido descarta; salida bloqueada pausa sin acumular escrituras ni gastar intentos y recupera los mismos intentos originales. |
| AC41 | [U/environment](../test/unit/environment.test.ts); [I/relay-recovery](../test/integration/relay-recovery.test.ts) AC35; [I/async-offers-e2e](../test/integration/async-offers-e2e.test.ts) | Un relay explícito; otro worker consume/barre sin asumir publicación. |
| AC42 | [I/offers](../test/integration/offers.test.ts): “omits an expired notice”, “revalidates a now invalid offer”; [I/offer-expiry-e2e](../test/integration/offer-expiry-e2e.test.ts) | Descarte no toca reserva ni busca sustituta; retry vuelve a comprobar vigencia. |
| AC43 | [I/offers](../test/integration/offers.test.ts): “checked before acceptance”, “real log after the checked deadline”, “checked notice after rejection” | Log puede completar tras aceptación/vencimiento/rechazo; plazo original y R2 posterior intactos. |
| AC44 | [U/notification](../test/unit/notification.test.ts); [I/offers](../test/integration/offers.test.ts): “real notice after SIGKILL between completed output and SQL result” | Callback completo, caída real preSQL/preack, dos líneas iguales, una oferta y resultado terminal. |
| AC45 | [I/offers](../test/integration/offers.test.ts): “reviews beyond an … origin”; [I/offer-decisions](../test/integration/offer-decisions.test.ts) H1/H2 | Origen excluido, reocupado o iniciado no impide revisar otro hueco ni altera sustituta. |
| AC46 | [I/message-transport](../test/integration/message-transport.test.ts); [I/message-retries](../test/integration/message-retries.test.ts): “physically parks real process crashes” | Contadores físicos 0…20 y SIGKILL anteriores a evidencia SQL; DLQ no equivale a éxito de negocio. |
| AC47 | [I/message-transport](../test/integration/message-transport.test.ts): “DLQ has no route”; [I/message-retries](../test/integration/message-retries.test.ts): permanente sin ruta DLQ | Broker conserva traslado (timer real); aplicación conserva outbox; ambos entregan al reparar. |
| AC48 | [I/manual-recovery](../test/integration/manual-recovery.test.ts): recuperación repetida, SIGKILL, copias DLQ, proxy COMMIT | Una recuperación/nuevo ciclo y outbox antes del ack; rollback conserva original; caída incierta reconoce historial. |
| AC49 | [I/manual-recovery](../test/integration/manual-recovery.test.ts): aparcado físico, copia antigua, dos operadores y consumidor concurrente | Origen físico sin SQL previo recuperable; terminal/ciclo/intento vigente prevalecen bajo coordinación real. |
| AC50 | [I/manual-recovery](../test/integration/manual-recovery.test.ts): revisión con origen ocupado/iniciado, aviso vencido, evento terminal | Recuperar revalida ámbito/estado; no amplía deadline ni repite trabajo terminal. |
| AC51 | Comprobación de entrega descrita abajo; [I/expiry-worker](../test/integration/expiry-worker.test.ts), [I/relay-recovery](../test/integration/relay-recovery.test.ts), [I/message-retries](../test/integration/message-retries.test.ts) | Snapshot conjunto de negocio/técnica/mensajes antes/después de reinicio normal; progreso sin segunda asignación ni reenviar publicadas. |
| AC52 | Comprobación de recreación abajo; [I/message-transport](../test/integration/message-transport.test.ts) y [I/manual-recovery](../test/integration/manual-recovery.test.ts) (22 fallos SQL al consumir DLQ) | Reinicia ambos almacenes/dedup/DLQ juntos solo por acción explícita; fallos de recuperación no pierden original. |
| AC53 | [I/agenda](../test/integration/agenda.test.ts): “initialization repeats”; arranque completo de entrega | Un comando, seed sin duplicados, identidad/fechas estables y cuatro servicios healthy desde vacío. |
| AC54 | [I/async-offers-e2e](../test/integration/async-offers-e2e.test.ts): “AC54” | Red HTTP real: hold Carlos vigente → caducidad normal → aviso Ana → misma R2 confirmada; luego cancelación → oferta Bruno. |
| AC55 | [I/holds](../test/integration/holds.test.ts), [I/waiting-list](../test/integration/waiting-list.test.ts), [I/offers](../test/integration/offers.test.ts): restricciones SQL 23505; [I/offer-decisions](../test/integration/offer-decisions.test.ts) | Un ocupante, activa única, oferta única y exclusión única; temporal vencida aún persistida conserva ocupación. |
| AC56 | [I/message-retries](../test/integration/message-retries.test.ts): publicación distinta del mismo intento y terminales | Deduplicación por evento/consumidor; intentos antiguos no gastan presupuesto; consumidores mantienen historias separadas. |
| AC57 | [I/offer-expiry](../test/integration/offer-expiry.test.ts): “coordinates two new keys”, reinscripción swept false/true | Dos APIs usan la misma K2 en la carrera temporal; una I2 o ninguna y una liberación. Claves distintas se cubren aparte en waiting-list-concurrency. |
| AC58 | [I/waiting-list](../test/integration/waiting-list.test.ts): hold ajeno vencido; [I/offer-expiry](../test/integration/offer-expiry.test.ts): “live offer despite a coexisting own hold” | A: Q2 tras cierre sin alta ficticia. B: oferta activa recuperada con 200 y K2 retenida. Son fixtures separados. |
| AC59 | [I/acceptance-variants](../test/integration/acceptance-variants.test.ts): “AC59/AC11” | Repite alta con HELD vigente/plazo intacto, cancela y consume liberación; cero participación/oferta latente ni éxito de alta. |
| AC60 | [I/acceptance-variants](../test/integration/acceptance-variants.test.ts): “AC60” (otro hospital/tipo) | Hold propio no cambia Q2 cuando otro ámbito tiene capacidad; 409 DIRECT_CAPACITY_AVAILABLE, nunca Q24. |
| AC61 | [U/waiting-list](../test/unit/waiting-list.test.ts); [I/waiting-list-concurrency](../test/integration/waiting-list-concurrency.test.ts): cruce real; [I/acceptance-variants](../test/integration/acceptance-variants.test.ts): “AC61” | Frontera pura, dos APIs esperando y comparación hold ya barrido/sin barrer, con/sin prioridad previa. |
| AC62 | [I/offers](../test/integration/offers.test.ts); [I/offer-expiry](../test/integration/offer-expiry.test.ts): activa ofrecida más hold propio | Clave nueva devuelve activa con 200 y conserva plazo/oferta; Q24 no rechaza activa. |
| AC63 | [I/acceptance-variants](../test/integration/acceptance-variants.test.ts): “AC63” | I1 cerrada + HELD propio vigente + K1 devuelve 201 histórico; no I2 y hold/plazo intactos. |
| AC64 | [I/offers](../test/integration/offers.test.ts): “permitted direct hold” | Oferta de un hueco y hold de otro libre coexisten; creación real mediante caso de uso/SQL. Ruta HTTP cubierta en holds. |
| AC65 | [U/reservation](../test/unit/reservation.test.ts); [I/reservation-lifecycle](../test/integration/reservation-lifecycle.test.ts): “reconfirmation reports its current CANCELLED state” | Reconfirmar CANCELLED da 409 con ID/estado actuales; R2 intacta. CONFIRMED sigue 200 tras su TTL antiguo. |
| AC66 | [U/reservation](../test/unit/reservation.test.ts): evaluación HELD/OFFERED -1/0/+1; [I/reservation-lifecycle](../test/integration/reservation-lifecycle.test.ts) | GET read-only, tiempo/estado/plazo y acciones separados; confirmada no caduca por TTL pasado. |
| AC67 | [U/offers](../test/unit/offers.test.ts); [I/offer-expiry](../test/integration/offer-expiry.test.ts): “keeps GETs read only”; [I/waiting-list](../test/integration/waiting-list.test.ts) | Oferta vencida no parece aceptable ni WAITING; sin vencimiento ficticio en inscripción sin oferta. |
| AC68 | [I/acceptance-variants](../test/integration/acceptance-variants.test.ts): “AC68/AC33” | Ana hold → CONFIRMED → alta → cancelar → OFFERED mismo H a Ana; R1 CANCELLED retenida y R2 distinta. |
| AC69 | [I/offer-expiry-e2e](../test/integration/offer-expiry-e2e.test.ts): “AC69”, started false/true | Aviso queda pendiente más allá del vencimiento; se descarta y aceptación antigua da 409. Bruno recibe solo hueco aún futuro; si empezó, sigue WAITING. |

## Comprobación de retención y recreación

Se usa un proyecto Compose nuevo desechable e imagen propia; los recursos de otras
entregas se conservan. Procedimiento de entrega, con API/CLI compiladas y servicios reales:

1. Arrancar los cuatro servicios desde volúmenes vacíos; comprobar salud y cinco
   huecos sin duplicados. Detener worker para preparar una fotografía estable.
2. Crear por HTTP hold, confirmación, altas 201/200 y cancelación; adjudicar y escribir
   aviso con los casos de uso/adaptadores reales. Preparar también descarte terminal,
   aparcado y recuperación real por CLI DLQ tras corregir un ámbito sintético.
3. Con API/worker detenidos, capturar filas completas ordenadas de las 18 tablas de
   `scheduling`, incluidas fechas, claves, negocio, outbox pendiente/publicada,
   resultados succeeded/discarded, ciclos, intentos y recuperación. Inspeccionar
   mensajes de las cuatro colas sin reconocerlos y devolverlos al cerrar el canal.
4. Detener PostgreSQL/RabbitMQ y arrancarlos con los mismos volúmenes/identidad.
   Comparar todas las filas y cuerpos/identidades de mensajes antes/después.
5. Arrancar API/worker: el pendiente recuperado termina, colas principales drenan,
   negocio/fechas/claves y recuperación siguen; todas las publicaciones ya completadas
   conservan exactamente sus filas y contadores. Repetir claves 201/200 recupera
   las respuestas originales aunque la inscripción ya esté cerrada.
6. Solo sobre ese proyecto desechable, `down --volumes` elimina los dos almacenes
   y `up -d --wait` los crea juntos. Verificar cinco huecos, tres pacientes, cuatro
   recursos, tablas de negocio/técnica vacías y cuatro colas vacías. Salud disponible.

Inspeccionar mensajes puede modificar sus contadores físicos de reentrega; la
comparación de transporte corresponde a cuerpos/identidades y cantidades retenidas,
no a inmutabilidad de esos contadores. El fixture prepara fallos técnicos sintéticos
para retención; los recorridos E2E AC54/68/69 demuestran la generación normal del negocio.
Retención no es backup ni recuperación tras pérdida irreversible de almacenamiento.

## Resultados de la entrega

La verificación local de 2026-11-16 usa Node 26.13.1 y las versiones fijadas en
el repositorio. Los comandos están en el [README](../README.md#verificación).
Las pruebas de variantes pasan antes de la suite conjunta; no se ha forzado
un fallo artificial de código funcional ya correcto para atribuirle TDD.
El estado de CI remota se verifica por SHA al publicar; un resultado local no
sustituye esa comprobación. No se añaden lint, formato, cobertura mínima o benchmarks.


Resultados operativos ejecutados: arranque desde vacío con cuatro servicios
healthy; roundtrip de esquema/AMQP y topología efectiva correctos; runtime de la
imagen `v26.13.1`. El snapshot retuvo 18 tablas, 10 publicaciones (9 completadas y
1 pendiente), 5 resultados de consumidor, 6 ciclos, 6 intentos y 1 recuperación.
RabbitMQ retuvo 5 mensajes de adjudicación, 2 de aviso y 1 en DLQ de adjudicación.
Tras reiniciar, todas las filas y cuerpos coincidieron; el pendiente progresó,
las 9 publicadas conservaron sus contadores y el negocio quedó idéntico.
La recreación conjunta dejó 5 huecos, 3 pacientes, 4 recursos y ninguna fila de
negocio, clave, evento, outbox o historial de consumidor, con las cuatro colas vacías.

La siguiente tabla conserva los resultados completos anteriores a las correcciones
de revisión, cuya base es `92fa49d`:

| Comprobación local anterior | Resultado ejecutado |
| --- | --- |
| `pnpm typecheck` | Aplicación y pruebas estrictas, correcto |
| `pnpm test` | 51 pruebas unitarias, 11 archivos, correcto |
| `pnpm test:integration` | 192 integraciones, 18 archivos, 413,95 s, correcto |
| `pnpm build` | Compilación correcta |
| `git diff --check` | Sin errores de espacios |
| Compose desde vacío, retención/progreso, recreación conjunta | Correctos sobre proyecto sintético propio |
| Topología efectiva y esquema/roundtrip AMQP | Correctos |

Estos resultados completos no son una nueva ejecución tras las correcciones siguientes.
El diseño funcional conserva SHA-256
`c941187ff1c7f1ff493464ec3906b83c37acce96c130c7781d5c9682073c65f8` y el PDF original
permanece intacto.

## Correcciones tras la revisión

El timeout de una salida compartida sin progreso ahora pausa el consumo. El
escritor conserva una única escritura pendiente hasta su callback; durante la
pausa no encola otros avisos. Los errores específicos de escritura mantienen su
tratamiento de fallo lógico. Se extrajeron los efectos comunes de caducidad sin
mover selección, tiempo protegido ni actualización local, y los tres recorridos
E2E/relay reutilizan el helper existente de procesos worker con sus plazos originales.

Las dos regresiones nuevas fallaron antes del cambio: la unitaria recibió un
`Error` corriente y la integración resolvió el consumo en lugar de pausar.
Después pasan con un `Writable` real bloqueado y PostgreSQL real: dos avisos y
consumos repetidos conservan las publicaciones de intento `0`, sin filas de fallo ni
resultado prematuro; al drenar, ambos completan ese mismo intento. Solo la prueba
unitaria controla el timeout técnico con fake timers; la integración espera los
cinco segundos reales y usa el reloj de PostgreSQL.

| Comprobación local tras las correcciones, 2026-11-16 | Resultado ejecutado |
| --- | --- |
| `pnpm typecheck` y `pnpm build` | Correctos, aplicación y pruebas estrictas |
| `pnpm test` | 52 unitarias, 11 archivos, correcto |
| Integraciones de caducidad, lista, reservas, avisos y los tres recorridos del helper | 77 pruebas, 7 archivos, 38,29 s, correcto |
| `message-retries` filtrado por salida compartida, intento original, permanente y terminales | 4 pruebas, 8 omitidas por filtro, 5,40 s, correcto |
| `git diff --check` e integridad de las fuentes funcionales | Correctos |

Los comandos de integración ejecutados, con las URLs sintéticas configuradas
como indica el README, son:

```bash
pnpm exec vitest run test/integration/offer-expiry.test.ts \
  test/integration/waiting-list.test.ts test/integration/reservation-lifecycle.test.ts \
  test/integration/offers.test.ts test/integration/async-offers-e2e.test.ts \
  test/integration/offer-expiry-e2e.test.ts test/integration/relay-recovery.test.ts
pnpm exec vitest run test/integration/message-retries.test.ts \
  -t 'shared output|original notification attempts|permanent failure|terminal outcomes'
```

Se ejecutaron 81 integraciones afectadas, sin repetir localmente las esperas
no afectadas de 155 s y del traslado DLX. Tampoco se repitieron las comprobaciones
de retención/recreación: no cambian esquema, topología, Compose ni arranque.
La suite completa y la CI del SHA final publicado siguen pendientes de consulta;
estos resultados locales no acreditan esa ejecución remota.
