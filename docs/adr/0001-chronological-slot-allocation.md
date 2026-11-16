# Adjudicar por inicio del hueco y FIFO entre inscripciones elegibles

Cuando haya varios huecos libres para adjudicar en un ámbito, se examinarán por inicio ascendente y se desempatará por identificador estable del hueco; para cada hueco se seleccionará la primera inscripción elegible según su orden de admisión. Se elige una regla determinista y explicable frente a buscar una combinación que maximice la ocupación: si Ana precede a Bruno y admite H1 y H2, pero Bruno ha excluido H2, ofrecer primero H1 a Ana puede dejar H2 libre y a Bruno esperando. Ese resultado es aceptado y no se corregirá alterando el FIFO de ese hueco para mejorar la ocupación global.

El [diseño consolidado](../functional-design.md) precisa la revisión común: un único `SlotReleased` tras un rechazo válido ya activa todo el ámbito, aunque el hueco de origen esté excluido, reocupado o iniciado. No se añade otra solicitud por ese mismo rechazo.
