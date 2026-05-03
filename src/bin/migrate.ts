import { migrate } from "../queue/migrate.ts";
import { pool } from "../queue/db.ts";

try {
  await migrate();
} finally {
  await pool.end();
}
