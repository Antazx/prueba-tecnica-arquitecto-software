-- No patient or appointment data is loaded during the technical setup.
-- This query makes successful database initialization visible in the logs.
SELECT current_database() AS database_name,
       EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'scheduling') AS scheduling_schema_ready;
