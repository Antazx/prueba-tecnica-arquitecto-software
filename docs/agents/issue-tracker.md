# Gestor de tareas: GitHub Issues

Las tareas y especificaciones viven en las incidencias de
`Antazx/prueba-tecnica-arquitecto-software`.

## Identidad y destino

- Usa exclusivamente la cuenta `Antazx` para las operaciones Git y GitHub
  de este repositorio, incluidas las consultas y modificaciones de PR.
- Selecciona la credencial guardada de ese perfil y pásala mediante `GH_TOKEN`
  solo a los procesos de la operación. Conserva la cuenta global del usuario.
  Mantén la credencial fuera de archivos, argumentos y salidas visibles.
- Verifica la identidad con `gh api user --jq .login` bajo ese entorno.
  El resultado debe ser `Antazx`.
- Comprueba el destino con `gh repo view --json nameWithOwner`.
  Debe ser `Antazx/prueba-tecnica-arquitecto-software`.
- Añade `--repo Antazx/prueba-tecnica-arquitecto-software` a los comandos
  que lo admitan. En llamadas API, indica explícitamente ese repositorio.
- Para Git con `origin`, usa la misma identidad mediante un helper de
  credenciales temporal, sin modificar la configuración global.

## Operaciones

Los ejemplos usan `NUMBER` para el número de incidencia y `BODY_FILE`
para un archivo con el texto que se publicará.

- Crear: `gh issue create --title "TITLE" --body-file BODY_FILE`.
- Consultar: `gh issue view NUMBER --json number,title,body,labels,comments`.
- Listar: `gh issue list --state open --json number,title,body,labels`.
- Comentar: `gh issue comment NUMBER --body-file BODY_FILE`.
- Etiquetar: `gh issue edit NUMBER --add-label "LABEL"` o `--remove-label "LABEL"`.
- Cerrar: publica primero la explicación y ejecuta `gh issue close NUMBER`.

Usa archivos de texto y `--body-file` para los cuerpos multilínea.

## Relaciones y planificación

Usa las relaciones nativas de subincidencias y dependencias cuando estén
disponibles. Como alternativa, escribe `Part of #NUMBER` en la incidencia
hija y `Blocked by: #NUMBER` en la bloqueada. Una tarea queda desbloqueada
cuando todas sus dependencias están cerradas.

Para `wayfinder`, el mapa es una incidencia con etiqueta `wayfinder:map`;
sus tareas usan `wayfinder:research`, `wayfinder:prototype`,
`wayfinder:grilling` o `wayfinder:task`. Vincúlalas al mapa y registra
el responsable antes de comenzar el trabajo.

## Publicar y recuperar trabajo

Cuando una skill pida publicar en el gestor, crea una incidencia aquí.
Cuando pida recuperar un ticket, consulta la incidencia correspondiente.

## PR como solicitudes

**PRs as a request surface: no.**
