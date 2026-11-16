import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { postgresScheduling } from "../../src/scheduling/adapters/postgres/scheduling.ts";
import { schedulingUseCases } from "../../src/scheduling/application/reservations.ts";

const pool = createDatabasePool(process.env.DATABASE_URL!);
try {
  const expired = await schedulingUseCases(postgresScheduling(pool)).expireTemporaryReservations();
  process.send?.({ expired });
} finally { await pool.end(); process.disconnect?.(); }
