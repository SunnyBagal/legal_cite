import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "../../config.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
/** Arbitrary constant: serialises concurrent `citecheck run`s migrating a fresh database. */
const MIGRATION_LOCK = 727_001;

export async function runMigrations(): Promise<void> {
  // One connection, so the session-level advisory lock covers the migration.
  const sql = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK})`;
  } finally {
    await sql.end();
  }
}
