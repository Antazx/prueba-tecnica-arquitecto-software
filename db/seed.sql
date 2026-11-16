INSERT INTO scheduling.hospitals(id) VALUES ('hospital-north'), ('hospital-south') ON CONFLICT DO NOTHING;
INSERT INTO scheduling.test_types(id) VALUES ('mri'), ('ultrasound') ON CONFLICT DO NOTHING;
INSERT INTO scheduling.patients(id) VALUES ('patient-ana'), ('patient-bruno'), ('patient-carlos') ON CONFLICT DO NOTHING;
INSERT INTO scheduling.waiting_list_scopes(hospital_id, test_type_id)
VALUES ('hospital-north', 'mri'), ('hospital-north', 'ultrasound'), ('hospital-south', 'mri')
ON CONFLICT DO NOTHING;
INSERT INTO scheduling.diagnostic_resources(id, hospital_id, test_type_id)
VALUES ('scanner-north-1', 'hospital-north', 'mri'),
       ('scanner-north-2', 'hospital-north', 'mri'),
       ('ultrasound-north-1', 'hospital-north', 'ultrasound'),
       ('scanner-south-1', 'hospital-south', 'mri')
ON CONFLICT DO NOTHING;

INSERT INTO scheduling.demo_seed(singleton, agenda_starts_at)
VALUES (true, (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + interval '1 day 9 hours')
ON CONFLICT DO NOTHING;

INSERT INTO scheduling.slots(id, resource_id, hospital_id, test_type_id, starts_at, ends_at)
SELECT s.id, s.resource_id, r.hospital_id, r.test_type_id,
       d.agenda_starts_at + s.offset_minutes * interval '1 minute',
       d.agenda_starts_at + (s.offset_minutes + 30) * interval '1 minute'
FROM (VALUES
    ('slot-north-mri-1', 'scanner-north-1', 0),
    ('slot-north-mri-2', 'scanner-north-1', 30),
    ('slot-north-mri-3', 'scanner-north-2', 0),
    ('slot-north-ultrasound-1', 'ultrasound-north-1', 0),
    ('slot-south-mri-1', 'scanner-south-1', 0)
) AS s(id, resource_id, offset_minutes)
JOIN scheduling.diagnostic_resources r ON r.id = s.resource_id
CROSS JOIN scheduling.demo_seed d
ON CONFLICT DO NOTHING;
