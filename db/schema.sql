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

CREATE TABLE IF NOT EXISTS scheduling.reservations (
    id uuid PRIMARY KEY,
    slot_id text NOT NULL REFERENCES scheduling.slots(id),
    patient_id text NOT NULL REFERENCES scheduling.patients(id),
    state text NOT NULL CHECK (state IN ('HELD', 'OFFERED', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
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
