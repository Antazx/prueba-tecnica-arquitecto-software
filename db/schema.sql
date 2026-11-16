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
