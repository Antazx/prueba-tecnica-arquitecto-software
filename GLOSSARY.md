# Citación de pruebas diagnósticas

Vocabulario compartido para gestionar la agenda, las reservas y la lista de espera.
Los equivalentes ingleses se usan al nombrar los conceptos en el código.

## Lenguaje

**Tipo de prueba (Test type)**:
Servicio diagnóstico para el que un hospital agrupa recursos equivalentes y una lista de espera común.

**Recurso diagnóstico (Diagnostic resource)**:
Máquina o capacidad concreta a la que pertenecen los huecos de agenda.
_Evitar_: Hueco como sinónimo del recurso que lo proporciona.

**Hueco (Slot)**:
Intervalo de agenda de un recurso diagnóstico, perteneciente a un hospital y un tipo de prueba. Existe con independencia de las reservas que lo hayan ocupado.
_Evitar_: Cita para referirse al intervalo disponible.

**Reserva (Reservation)**:
Asignación de un hueco a un paciente, con identidad propia, que puede ser temporal, confirmada o terminada. Cada nueva asignación del mismo hueco es otra reserva.
_Evitar_: Hueco; cita como entidad independiente de la reserva.

**Bloqueo directo (Direct hold)**:
Reserva temporal solicitada directamente por un paciente, con un plazo para confirmarla.
_Evitar_: Oferta; bloqueo para referirse a mecanismos de coordinación técnica.

**Oferta (Offer)**:
Reserva temporal exclusiva para un paciente de la lista de espera, con un plazo para aceptarla.
_Evitar_: Aviso; propuesta sin reserva del hueco.

**Cita confirmada (Confirmed appointment)**:
Reserva que el paciente ha confirmado, incluida la aceptación de una oferta. Conserva la identidad que tenía como reserva temporal.
_Evitar_: Nueva reserva al confirmar.

**Ámbito de espera (Waiting list scope)**:
Combinación de hospital y tipo de prueba que agrupa huecos de recursos equivalentes y su lista de espera.
_Evitar_: Lista por máquina; lista global de todos los hospitales y pruebas.

**Lista de espera (Waiting list)**:
Conjunto ordenado de inscripciones de un ámbito para recibir ofertas de sus huecos compatibles.
_Evitar_: Lista específica de un único hueco o de una máquina.

**Inscripción (Waiting list entry)**:
Participación concreta de un paciente en una lista de espera, con antigüedad, situación y exclusiones propias. Una reincorporación tras el cierre es otra inscripción.
_Evitar_: Paciente como sinónimo de su participación en una lista.

**Antigüedad (Admission order)**:
Orden de admisión de una inscripción respecto a las demás de su ámbito. Se conserva al rechazar válidamente una oferta.
_Evitar_: Orden de recepción de avisos o mensajes.

**Exclusión de hueco (Slot exclusion)**:
Incompatibilidad voluntaria entre una inscripción y un hueco que su paciente ya ha rechazado. No impide que esa inscripción reciba ofertas de otros huecos.
_Evitar_: Retirada de toda la lista.

**Aviso de oferta (Offer notification)**:
Comunicación de una oferta ya existente y de su vencimiento. No crea la oferta ni acredita su aceptación.
_Evitar_: Oferta como sinónimo de su comunicación.

**Liberación (Slot release)**:
Fin de la ocupación de un hueco por una reserva. No equivale a disponibilidad para reserva directa cuando existe espera elegible con prioridad.
_Evitar_: Disponibilidad como sinónimo automático de liberación.
