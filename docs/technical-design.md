# Referencia para el diseño técnico

El [diseño funcional consolidado](functional-design.md) es la referencia vigente
de las decisiones del ejercicio. Su revisión 5, de 2026-11-16, incorpora Q1–Q26,
la revisión de Q2 y los criterios AC01–AC69.

Este archivo se mantiene como punto de entrada y sustituye la recopilación
parcial anterior. Las reglas, contratos, límites, alternativas y pruebas de
aceptación se consultan en el documento consolidado, sin mantener otra
especificación en paralelo.

El [enunciado](diagnostic-appointment-requirements.pdf) conserva los requisitos
originales; el [glosario](../GLOSSARY.md) fija el vocabulario y los
[ADR](adr/) explican decisiones seleccionadas. El README resume el alcance y
documenta los comandos realmente disponibles.

La implementación funcional, su configuración y sus pruebas siguen pendientes.
La sincronización documental no acredita resultados de ejecución.

## Procedencia e integridad

La base importada fue la revisión 4, idéntica entonces al documento de trabajo,
con SHA-256:
`711eae6e4d2b7f392b23a723947e5777f47eac96bdde5f158e0600ce6e8c5f84`.

La revisión 5 incorpora Q25 y Q26, aceptadas después, y corrige AC30, AC57 y 15.6
para expresar las precondiciones completas de Q24. AC68–AC69 explicitan límites
ya aceptados, sin decisiones nuevas de producto. El glosario y los ADR anteriores
siguen siendo compatibles; estos dos acuerdos precisan contratos observables.

La revisión 5 se ha sincronizado con el documento de trabajo de Obsidian y se
ha comprobado igualdad byte por byte. SHA-256 de ambas copias vigentes:
`c941187ff1c7f1ff493464ec3906b83c37acce96c130c7781d5c9682073c65f8`.

## Reanudar `to-spec` tras limpiar el contexto

Esta es la continuación de la tarea de diseño en la rama
`docs/appointment-design-review`. La documentación todavía tiene cambios sin
commit: limpiar el contexto de conversación no debe descartar esos archivos ni
tratarlos como trabajo ajeno que haya que reemplazar.

Antes de redactar la spec:

1. Leer las [instrucciones del proyecto](../AGENTS.md), el [README](../README.md)
   y el [diseño consolidado](functional-design.md) completo, con Q1–Q26 y
   AC01–AC69. No usar una revisión anterior como sustituto de estas decisiones.
2. Usar el [glosario](../GLOSSARY.md) y consultar los [ADR](adr/). Mantener la
   distinción entre decisiones aceptadas, propuestas de calidad y resultados
   todavía no acreditados.
3. Leer la skill `to-spec`, el [gestor de tareas](agents/issue-tracker.md) y las
   [etiquetas de clasificación](agents/triage-labels.md). La cuenta autorizada es
   `Antazx`; el destino es `Antazx/prueba-tecnica-arquitecto-software`.
4. Sintetizar en español el problema, solución, historias de usuario, decisiones,
   pruebas y exclusiones según la plantilla de la skill. No reabrir el grilling
   ni incorporar rutas personales o detalles técnicos todavía no decididos.
5. Conservar las fronteras de prueba acordadas: reglas puras con tiempo
   controlado; integración con PostgreSQL y RabbitMQ reales; contratos HTTP;
   pocas E2E completas. El caso de concurrencia exige procesos de API separados
   y barreras observables; las pruebas temporales no confunden un reloj falso
   de JavaScript con el reloj de PostgreSQL.

El código disponible corresponde a la preparación técnica: API de salud y
worker de conexiones, sin citación funcional ni resultados de AC01–AC69. Los
cambios de implementación iniciados por error durante el grilling fueron
deshechos.

La especificación se ha publicado en la [incidencia #3](https://github.com/Antazx/prueba-tecnica-arquitecto-software/issues/3)
con el perfil `Antazx` y la etiqueta `ready-for-agent`. Sintetiza la revisión 5,
Q1–Q26 y AC01–AC69; las fronteras de prueba se han vuelto a confirmar con el
usuario. Se ha verificado que el contenido publicado coincide íntegramente con
el borrador preparado. Esta continuación de `to-spec` no implementa funcionalidad
ni acredita pruebas de comportamiento.
