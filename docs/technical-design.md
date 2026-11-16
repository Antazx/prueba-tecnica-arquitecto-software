# Diseño técnico de la entrega

La [revisión funcional 5](functional-design.md), de 2026-11-16, es normativa:
Q1–Q26 y AC01–AC69. Este documento describe su implementación; no añade reglas
funcionales. El [README](../README.md) contiene los comandos operativos y la
[matriz de aceptación](acceptance.md) enlaza pruebas y evidencia.

## Composición

`src/bootstrap/api.ts` y `worker.ts` inicializan esquema/seed y conectan los
adaptadores. La API sirve las nueve rutas de negocio; el worker combina barrido,
dos consumidores y un relay opcional por configuración. La herramienta
`recover-message.ts` ejecuta recuperaciones locales explícitas.

```text
HTTP → casos de uso → Scheduling.transaction → PostgreSQL
                         reglas puras             │
                                             eventos/outbox
                                                  ↓
                                        relay → RabbitMQ
                                                  ↓
                                     consumidores → casos de uso
                                                  ↓
                                           aviso estructurado
```

`src/scheduling/domain/` contiene reglas puras con tiempo explícito.
`application/` expresa transiciones y el puerto específico `Scheduling`, cuyo
callback usa operaciones de citación. `adapters/` implementa HTTP, PostgreSQL,
RabbitMQ y salida del aviso. No se expone `PoolClient` fuera del adaptador ni se
usan transacciones anidadas, repositorios genéricos o mutex de proceso.

## Persistencia y protocolo transaccional

`db/schema.sql` conserva hospitales, tipos, recursos, pacientes sintéticos,
ámbitos, huecos, inscripciones, exclusiones y reservas con identidad estable.
Las claves compuestas impiden mezclar recurso/ámbito; los checks exigen intervalos
no vacíos y precisión de milisegundos. Inicialización valida solapamientos por
recurso. `demo_seed` fija un ancla persistida; inicializaciones repetidas no mueven
las fechas ni duplican filas. No es un sistema de migraciones de bases pobladas.

Índices únicos parciales protegen ocupante por hueco, inscripción activa por
paciente/ámbito y oferta por inscripción. Una fila temporal vencida sigue
ocupando hasta que una escritura materializa su cierre. El historial conserva
el máximo de `admission_order` bigint para nuevas altas; no se ordena por timestamp.
Cada cierre de reserva tiene una única causa y evento asociado.

En `adapters/postgres/scheduling.ts` las transacciones usan `READ COMMITTED`:

1. Coordinar clave HTTP o pareja evento/consumidor si corresponde; recuperar
   resultado tras cualquier espera técnica.
2. Adquirir la fila estable del ámbito como primer bloqueo de negocio; bloquear
   filas relacionadas en orden estable y releer mediante comandos posteriores.
3. Tomar `date_trunc('milliseconds', clock_timestamp())` después de la coordinación
   y decidir con el estado protegido. No usar el tiempo de inicio de transacción.
4. Guardar negocio, resultado y outbox atómicamente; commit antes de respuesta/ack.

Un conflicto funcional puede comprometer caducidad/liberación ya válida y devolver
`409`; una excepción técnica revierte la transacción. Los GET toman una fotografía
coherente de estado/tiempo sin escrituras. Lock/statement timeout acotan esperas
individuales a 2/2,5 s. No se mantienen bloqueos de ámbito al esperar red, salida
del aviso o al paciente. Las pruebas de carreras usan dos procesos/pools y
`pg_stat_activity`/`pg_blocking_pids` como barreras observables.

## Identidad durable y transporte

`events` conserva el trabajo lógico versionado. `outbox_publications` identifica
cada envío y conserva consumidor, ciclo/intento, destino, fecha lógica,
`send_count`, error, próximo envío y `published_at`. Las publicadas no vuelven a
seleccionarse; incertidumbre antes de registrar confirmación puede duplicar.

El relay configurado único publica secuencialmente con persistencia, `mandatory`
y confirm. Un return invalida el envío aunque llegue confirm positivo. Un fallo
conserva su próxima fecha y deja avanzar otras listas. Timeout/cierre retira esa
generación de conexión; respuestas antiguas no confirman publicaciones nuevas.
`available_at`, `next_attempt_at` y `consumer_attempts.not_before` se respetan al
seleccionar. Envios de transporte e intentos de negocio son presupuestos distintos.

`rabbitmq/definitions.json` y `rabbitmq.conf` aprovisionan dos exchanges, dos colas
principales y sus dos DLQ quorum durables. Principales: límite físico 20, DLX
`at-least-once`, `reject-publish` y rutas específicas. DLQ: sin TTL, DLX, retorno
automático ni límite físico. `scripts/verify-rabbitmq.mjs` consulta configuración
efectiva, bindings, políticas y flags. La falta de ruta DLQ conserva el traslado
en el broker hasta reparación; su timer interno es distinto de los reintentos SQL.
El volumen y hostname estables conservan identidad. Un miembro quorum no es HA.

## Consumo, fallos y recuperación

`consumer_results` coordina globalmente evento/consumidor y conserva el terminal
`succeeded` o `discarded`; protege todos los ciclos/intentos. `consumer_cycles`
y `consumer_attempts` conservan presupuesto, estados, fallos y fechas.
El consumidor adquiere esa coordinación antes del ámbito y hace ack después del
commit. Duplicados o intentos viejos no duplican efectos ni reinician presupuesto.

Un fallo específico hace rollback; otra transacción vuelve a coordinar y revalida
si otra entrega ganó antes de programar 5 s, 30 s y 120 s. El cuarto fallo o uno
permanente aparca y guarda publicación DLQ antes del ack. Una caída global de
PostgreSQL/salida pausa consumo con espera; no agota intentos en masa. El límite
físico del broker cubre caídas anteriores al registro SQL. Aparcado no es éxito.

`consumer_recoveries` registra publicación de origen, operador, motivo y nuevo
ciclo/publicación. La herramienta valida procedencia DLQ o evidencia persistida,
coordina como el consumidor y comprueba terminal, ciclo e intento vigentes. Un
índice impide dos recuperaciones efectivas del mismo ciclo. Registra auditoría,
intento cero y outbox antes de retirar la entrega; commit incierto o caída preack
se resuelven por esa evidencia. No reproduce toda la outbox publicada, modifica
contenido ni amplía deadlines. El modo persistido no requiere RabbitMQ; el modo
DLQ usa conexión dedicada con cierre acotado y conserva entregas no seleccionadas.

## Adjudicación y aviso

Una revisión relee todo el ámbito y tiempo actual; recorre huecos futuros por
inicio/ID y FIFO por elegibilidad/exclusiones. Un origen reocupado o iniciado no
invalida revisar otros huecos. Oferta, inscripción `OFFERED`, `OfferCreated` y
outbox se comprometen juntos. Aceptar conserva ID; rechazar conserva antigüedad
y activa el ámbito mediante una sola liberación. Barrido y peticiones comparten
coordinación y reglas de caducidad.

El aviso relee la reserva concreta próxima a la escritura y espera su callback
antes de resultado/ack; solo conserva el bloqueo técnico del evento/consumidor.
Puede repetirse después de escritura/caída o terminar tras rechazo/vencimiento.
No toca una reserva sustituta ni acredita recepción humana. La aceptación siempre
revalida. Una oferta puede vencer sin aviso útil. Las pruebas no atribuyen los
fake timers de JavaScript al reloj de PostgreSQL: igualdad exacta se prueba en
reglas puras y cruces reales con barreras de BD en integración.

## Operación y alcance de evidencia

El [README](../README.md) diferencia reinicio reteniendo los dos volúmenes,
recreación sintética coordinada y backup no implementado. No hay purgas al
arrancar. API/consumidores son procesos separados; el relay no tiene liderazgo ni
relevo automáticos. Identidad por cabecera y operador CLI no están autenticados.
Las pruebas de integración y pocas E2E cubren transporte/persistencia reales;
no constituyen una demostración de todas las permutaciones, HA o capacidad.

## Procedencia e integridad funcional

La base importada fue revisión 4, SHA-256
`711eae6e4d2b7f392b23a723947e5777f47eac96bdde5f158e0600ce6e8c5f84`.
La revisión 5 incorporó Q25/Q26 y precisó Q24, AC30, AC57 y §15.6;
AC68–AC69 explicitan límites ya aceptados. Se comprobó igualdad byte a byte con
el documento de trabajo al consolidarla. Su SHA-256 conservado es
`c941187ff1c7f1ff493464ec3906b83c37acce96c130c7781d5c9682073c65f8`.
El PDF original se conserva sin modificación. La entrega técnica no altera esas
fuentes ni mantiene otra especificación funcional en paralelo.
