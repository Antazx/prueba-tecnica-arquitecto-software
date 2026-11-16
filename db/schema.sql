CREATE SCHEMA IF NOT EXISTS scheduling;
COMMENT ON SCHEMA scheduling IS 'Diagnostic appointment scheduling';

CREATE TABLE IF NOT EXISTS scheduling.hospitals (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS scheduling.test_types (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS scheduling.patients (id text PRIMARY KEY);

CREATE TABLE IF NOT EXISTS scheduling.waiting_list_scopes (
    hospital_id text NOT NULL REFERENCES scheduling.hospitals(id),
    test_type_id text NOT NULL REFERENCES scheduling.test_types(id),
    PRIMARY KEY (hospital_id, test_type_id)
);
CREATE INDEX IF NOT EXISTS scopes_test_type_idx ON scheduling.waiting_list_scopes(test_type_id);

CREATE TABLE IF NOT EXISTS scheduling.diagnostic_resources (
    id text PRIMARY KEY,
    hospital_id text NOT NULL,
    test_type_id text NOT NULL,
    UNIQUE (id, hospital_id, test_type_id),
    FOREIGN KEY (hospital_id, test_type_id)
        REFERENCES scheduling.waiting_list_scopes(hospital_id, test_type_id)
);
CREATE INDEX IF NOT EXISTS resources_scope_idx ON scheduling.diagnostic_resources(hospital_id, test_type_id);

CREATE TABLE IF NOT EXISTS scheduling.slots (
    id text PRIMARY KEY,
    resource_id text NOT NULL,
    hospital_id text NOT NULL,
    test_type_id text NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    CHECK (starts_at < ends_at),
    CHECK (starts_at = date_trunc('milliseconds', starts_at)),
    CHECK (ends_at = date_trunc('milliseconds', ends_at)),
    FOREIGN KEY (resource_id, hospital_id, test_type_id)
        REFERENCES scheduling.diagnostic_resources(id, hospital_id, test_type_id)
);
CREATE INDEX IF NOT EXISTS slots_scope_start_idx ON scheduling.slots(hospital_id, test_type_id, starts_at, id);
CREATE INDEX IF NOT EXISTS slots_resource_idx ON scheduling.slots(resource_id);

-- The persisted anchor prevents normal restarts from moving the demo agenda.
CREATE TABLE IF NOT EXISTS scheduling.demo_seed (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    agenda_starts_at timestamptz NOT NULL,
    validated boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS scheduling.waiting_list_entries (
    id uuid PRIMARY KEY,
    patient_id text NOT NULL REFERENCES scheduling.patients(id),
    hospital_id text NOT NULL,
    test_type_id text NOT NULL,
    admission_order bigint NOT NULL CHECK (admission_order > 0),
    state text NOT NULL CHECK (state IN ('WAITING', 'OFFERED', 'CLOSED')),
    closure_reason text CHECK (closure_reason IN ('ACCEPTED', 'EXPIRED', 'WITHDRAWN')),
    created_at timestamptz NOT NULL,
    CHECK (created_at = date_trunc('milliseconds', created_at)),
    CHECK ((state = 'CLOSED') = (closure_reason IS NOT NULL)),
    FOREIGN KEY (hospital_id, test_type_id) REFERENCES scheduling.waiting_list_scopes(hospital_id, test_type_id),
    UNIQUE (hospital_id, test_type_id, admission_order)
);
CREATE UNIQUE INDEX IF NOT EXISTS entries_one_active_patient_scope_idx
    ON scheduling.waiting_list_entries(patient_id, hospital_id, test_type_id) WHERE state IN ('WAITING', 'OFFERED');
CREATE INDEX IF NOT EXISTS entries_waiting_scope_order_idx
    ON scheduling.waiting_list_entries(hospital_id, test_type_id, admission_order) WHERE state = 'WAITING';
CREATE INDEX IF NOT EXISTS entries_test_type_idx ON scheduling.waiting_list_entries(test_type_id);

CREATE TABLE IF NOT EXISTS scheduling.waiting_list_slot_exclusions (
    entry_id uuid NOT NULL REFERENCES scheduling.waiting_list_entries(id),
    slot_id text NOT NULL REFERENCES scheduling.slots(id),
    PRIMARY KEY (entry_id, slot_id)
);
CREATE INDEX IF NOT EXISTS exclusions_slot_idx ON scheduling.waiting_list_slot_exclusions(slot_id);

CREATE TABLE IF NOT EXISTS scheduling.reservations (
    id uuid PRIMARY KEY,
    slot_id text NOT NULL REFERENCES scheduling.slots(id),
    patient_id text NOT NULL REFERENCES scheduling.patients(id),
    state text NOT NULL CHECK (state IN ('HELD', 'OFFERED', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
    waiting_list_entry_id uuid REFERENCES scheduling.waiting_list_entries(id),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    CHECK (created_at < expires_at),
    CHECK (created_at = date_trunc('milliseconds', created_at)),
    CHECK (expires_at = date_trunc('milliseconds', expires_at))
);
-- Expiry alone does not release occupancy; a writer must persist the closure.
CREATE UNIQUE INDEX IF NOT EXISTS reservations_one_occupant_idx ON scheduling.reservations(slot_id)
    WHERE state IN ('HELD', 'OFFERED', 'CONFIRMED');
CREATE INDEX IF NOT EXISTS reservations_patient_idx ON scheduling.reservations(patient_id);
CREATE INDEX IF NOT EXISTS reservations_entry_idx ON scheduling.reservations(waiting_list_entry_id);
CREATE UNIQUE INDEX IF NOT EXISTS reservations_one_offer_entry_idx ON scheduling.reservations(waiting_list_entry_id)
    WHERE state = 'OFFERED';

CREATE TABLE IF NOT EXISTS scheduling.http_creation_results (
    patient_id text NOT NULL REFERENCES scheduling.patients(id),
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    fingerprint text,
    status_code integer,
    response_body jsonb,
    PRIMARY KEY (patient_id, operation, idempotency_key),
    CHECK ((fingerprint IS NULL AND status_code IS NULL AND response_body IS NULL) OR
           (fingerprint IS NOT NULL AND status_code IS NOT NULL AND status_code IN (200, 201) AND response_body IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS reservations_due_temporaries_idx ON scheduling.reservations(expires_at, id) WHERE state IN ('HELD', 'OFFERED');

-- A logical event survives every publication and delivery of that same work.
CREATE TABLE IF NOT EXISTS scheduling.events (
    id uuid PRIMARY KEY,
    type text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    occurred_at timestamptz NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS scheduling.reservation_closures (
    reservation_id uuid PRIMARY KEY REFERENCES scheduling.reservations(id),
    reason text NOT NULL CHECK (reason IN ('CANCELLED', 'EXPIRED', 'OFFER_REJECTED', 'WITHDRAWN')),
    closed_at timestamptz NOT NULL,
    event_id uuid NOT NULL UNIQUE REFERENCES scheduling.events(id)
);

-- Publication identity is independent of logical event, consumer, cycle and attempt.
CREATE TABLE IF NOT EXISTS scheduling.outbox_publications (
    id uuid PRIMARY KEY,
    event_id uuid NOT NULL REFERENCES scheduling.events(id),
    consumer text NOT NULL,
    cycle integer NOT NULL CHECK (cycle >= 0),
    attempt integer NOT NULL CHECK (attempt BETWEEN 0 AND 3),
    available_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    send_count integer NOT NULL DEFAULT 0 CHECK (send_count >= 0),
    last_attempt_at timestamptz,
    last_error text,
    next_attempt_at timestamptz,
    published_at timestamptz,
    destination text NOT NULL DEFAULT 'work' CHECK (destination IN ('work', 'dead'))
);
CREATE INDEX IF NOT EXISTS outbox_ready_idx ON scheduling.outbox_publications(GREATEST(available_at, next_attempt_at), created_at, id)
    WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_event_idx ON scheduling.outbox_publications(event_id);

-- Terminal work is scoped to a logical consumer, independently of physical deliveries.
CREATE TABLE IF NOT EXISTS scheduling.consumer_results (
    event_id uuid NOT NULL REFERENCES scheduling.events(id),
    consumer text NOT NULL,
    current_cycle integer NOT NULL DEFAULT 0 CHECK (current_cycle >= 0),
    outcome text CHECK (outcome IN ('succeeded', 'discarded')),
    completed_at timestamptz,
    PRIMARY KEY (event_id, consumer),
    CHECK ((outcome IS NULL) = (completed_at IS NULL))
);
CREATE TABLE IF NOT EXISTS scheduling.consumer_cycles (
    event_id uuid NOT NULL,
    consumer text NOT NULL,
    cycle integer NOT NULL CHECK (cycle >= 0),
    state text NOT NULL CHECK (state IN ('active', 'completed', 'parked')),
    parked_at timestamptz,
    park_reason text CHECK (park_reason IN ('permanent', 'exhausted', 'physical', 'operator')),
    PRIMARY KEY (event_id, consumer, cycle),
    FOREIGN KEY (event_id, consumer) REFERENCES scheduling.consumer_results(event_id, consumer)
);
CREATE TABLE IF NOT EXISTS scheduling.consumer_attempts (
    event_id uuid NOT NULL,
    consumer text NOT NULL,
    cycle integer NOT NULL,
    attempt integer NOT NULL CHECK (attempt BETWEEN 0 AND 3),
    not_before timestamptz NOT NULL,
    outcome text CHECK (outcome IN ('succeeded', 'discarded', 'failed')),
    completed_at timestamptz,
    last_error text,
    failure_kind text CHECK (failure_kind IN ('transient', 'permanent')),
    PRIMARY KEY (event_id, consumer, cycle, attempt),
    FOREIGN KEY (event_id, consumer, cycle) REFERENCES scheduling.consumer_cycles(event_id, consumer, cycle),
    CHECK ((outcome IS NULL) = (completed_at IS NULL))
);

-- Explicit operator decisions survive DLQ acknowledgements and broker loss.
CREATE TABLE IF NOT EXISTS scheduling.consumer_recoveries (
    id uuid PRIMARY KEY,
    event_id uuid NOT NULL,
    consumer text NOT NULL,
    source_cycle integer NOT NULL,
    source_attempt integer NOT NULL CHECK (source_attempt BETWEEN 0 AND 3),
    source_publication_id uuid NOT NULL UNIQUE REFERENCES scheduling.outbox_publications(id),
    source text NOT NULL CHECK (source IN ('application_dlq', 'broker_dlq', 'persisted')),
    operator text NOT NULL CHECK (length(trim(operator)) BETWEEN 1 AND 100),
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
    outcome text NOT NULL CHECK (outcome IN ('recovered', 'already_completed', 'superseded')),
    new_cycle integer NOT NULL CHECK (new_cycle >= 0),
    next_publication_id uuid REFERENCES scheduling.outbox_publications(id),
    recorded_at timestamptz NOT NULL,
    FOREIGN KEY (event_id,consumer,source_cycle) REFERENCES scheduling.consumer_cycles(event_id,consumer,cycle),
    CHECK ((outcome = 'recovered') = (next_publication_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS recoveries_one_new_cycle_idx
    ON scheduling.consumer_recoveries(event_id,consumer,source_cycle) WHERE outcome='recovered';
CREATE INDEX IF NOT EXISTS recoveries_next_publication_idx ON scheduling.consumer_recoveries(next_publication_id);
