# Instrucciones del proyecto

## Propósito y fuente de requisitos

Este repositorio público contiene una prueba técnica de arquitectura de software
para gestionar la citación de pruebas diagnósticas en una red sanitaria.

El enunciado original está en
[`docs/diagnostic-appointment-requirements.pdf`](docs/diagnostic-appointment-requirements.pdf).
Consúltalo antes de cambiar el alcance o tomar decisiones funcionales. Conserva
el PDF sin modificaciones; documenta las interpretaciones y decisiones en el README.

El tiempo orientativo del ejercicio es de 6 a 8 horas. Prioriza una solución
pequeña, correcta y fácil de explicar y revisar por una persona. Cada incorporación
debe justificar su coste de implementación, comprensión y mantenimiento.

## Idiomas

- Escribe en español la documentación, incluido este archivo, el README, las
  decisiones de arquitectura y las explicaciones de las pull requests.
- Escribe en inglés el código, los identificadores, los comentarios y docstrings
  del código, las pruebas, los mensajes de log y error y la configuración.
- Usa nombres de archivos, directorios y ramas en inglés, con las convenciones
  habituales de cada herramienta, como `AGENTS.md` y `README.md`.
- Escribe los mensajes de commit en inglés.

## Flujo de Git y GitHub

- El remoto del proyecto es
  `https://github.com/Antazx/prueba-tecnica-arquitecto-software.git` (`origin`).
- La rama de integración es `main`. Nunca hagas push directo a `main` ni la
  actualices directamente mediante una API. Integra los cambios mediante una PR.
- Antes de escribir archivos para una tarea nueva, inspecciona la rama y el
  estado del árbol, ejecuta `git fetch origin` y crea una rama específica desde
  el `origin/main` recién actualizado. Si falla la actualización, comunica el
  bloqueo antes de modificar archivos; una referencia en caché no acredita frescura.
- Continúa las tareas existentes en su propia rama. Si hay trabajo ajeno o de
  otra tarea pendiente, consérvalo y usa un worktree aislado desde `origin/main`.
- No descartes cambios, archivos sin seguimiento ni archivos ignorados. No hagas
  force push, reset destructivo, clean, amend o rebase, ni omitas hooks o protecciones.
- Añade al staging rutas explícitas de la tarea y revisa el diff antes del commit.
  Puedes publicar la rama de trabajo; nunca elimines ramas remotas.
- No fusiones una PR, actives auto-merge ni la añadas a una cola de integración
  sin una petición explícita del usuario para esa PR. Antes de fusionar, comprueba
  el SHA actual, las revisiones y los controles exigidos por el repositorio.

## Alcance funcional mínimo

La implementación debe cubrir los cinco puntos del enunciado:

1. Consultar la agenda y los huecos disponibles.
2. Bloquear temporalmente un hueco para un paciente, con caducidad si no se confirma.
3. Confirmar una cita bloqueada y cancelar una cita existente.
4. Impedir que un hueco se asigne a dos pacientes, incluso con peticiones concurrentes.
5. Gestionar una lista de espera ordenada. Cuando se libere un hueco por cancelación
   o caducidad, ofrecerlo de forma asíncrona al primer paciente, con un plazo de
   aceptación; si vence, pasar al siguiente.

La comunicación entre la liberación del hueco y el aviso al paciente debe usar
mensajería asíncrona. El aviso puede simularse, por ejemplo con un log. No sustituyas
ese flujo por una llamada síncrona. Explica las ambigüedades mediante decisiones
razonadas y documentadas.

## Legibilidad y mantenibilidad

- Optimiza el código para su lectura y revisión humana: nombres expresivos,
  funciones enfocadas, responsabilidades claras y flujos de control explícitos.
- Haz visibles las reglas de negocio, los estados y las transiciones permitidas.
  Mantén comprensibles los límites entre esas reglas, la persistencia, la API
  y la mensajería, sin imponer capas que no aporten valor al alcance elegido.
- Prefiere soluciones sencillas y convencionales. Evita abstracciones genéricas,
  jerarquías, patrones o infraestructura que solo respondan a necesidades futuras.
- Usa comentarios para explicar decisiones, restricciones o motivos que el código
  no pueda expresar; evita comentarios que repitan lo que hace una instrucción.
- Añade dependencias solo cuando resuelvan una necesidad concreta y justifica las
  decisiones técnicas relevantes y las alternativas descartadas.
- Usa el stack y el alcance de preparación acordados en `README.md`.
  Conserva la separación entre el setup técnico y las funcionalidades del enunciado.

## Corrección y verificación

- Sustenta la exclusividad de los huecos en garantías adecuadas a la persistencia
  y al despliegue elegidos. Explica cómo se mantiene ante solicitudes concurrentes.
- Define la relación entre caducidad, confirmación, cancelación y ofertas de la
  lista de espera, incluidos sus conflictos. Haz comprobable el comportamiento
  dependiente del tiempo.
- Prueba los comportamientos relevantes: reserva concurrente de un mismo hueco,
  caducidad de bloqueos, confirmación y cancelación, orden de la lista de espera
  y vencimiento de las ofertas. Verifica también los fallos de mensajería que
  contemple la solución.
- Usa pruebas de integración cuando una garantía dependa de la base de datos o
  del transporte. Un mock por sí solo no demuestra esa garantía.
- Ejecuta las comprobaciones disponibles que correspondan al cambio. No añadas
  pruebas para cambios exclusivamente documentales ni pruebas que se limiten a
  reproducir la implementación. No inventes comandos ni resultados.
- Al entregar avances, indica qué cambió, cómo se verificó y qué limitaciones
  quedan. Si una comprobación no se pudo ejecutar, dilo expresamente.

## Entrega y documentación

- La solución debe poder ejecutarse con un solo comando. Documenta los requisitos
  previos y un recorrido breve y reproducible para comprobar su funcionamiento.
- Mantén el README en español y actualizado con el comportamiento implementado.
  Debe explicar, como exige el enunciado:
  1. Las decisiones tomadas y las alternativas descartadas.
  2. Lo que queda fuera del alcance y por qué.
  3. Las garantías de entrega de la mensajería y qué sucede si un mensaje se pierde,
     llega duplicado o llega desordenado.
  4. Cómo se tratarían los datos de pacientes en un entorno real.
  5. Qué cambiaría para dar servicio a una red de hospitales.
- Documenta los comandos reales de arranque y verificación al incorporarlos.
  Mantén las explicaciones proporcionadas al tamaño del ejercicio.

## Datos y repositorio público

- Usa exclusivamente datos sintéticos; nunca datos reales de pacientes, tampoco
  en pruebas, ejemplos, logs, capturas o documentación.
- No incluyas credenciales, tokens, claves, archivos de entorno con secretos,
  volcados reales ni rutas personales. Los ejemplos de configuración deben usar
  valores ficticios y seguros.
- Revisa los archivos que se van a publicar teniendo presente que el repositorio
  es público. Mantén el enunciado original como documentación del ejercicio.

## Skills de agentes

### GitHub y tareas

Antes de operar en GitHub, lee
[docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
Define la cuenta `Antazx`, el repositorio de incidencias y las convenciones de trabajo.

### Etiquetas de clasificación

Para interpretar o cambiar la clasificación de una incidencia, usa
[docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Documentación del dominio

Antes de explorar el código, consulta
[docs/agents/domain.md](docs/agents/domain.md):
glosario único en la raíz y decisiones de arquitectura en `docs/adr/`.
