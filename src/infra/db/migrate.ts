import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";

export async function runMigrations(): Promise<void> {
  const { db, close } = createDb();
  try {
    await migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  } finally {
    await close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations();
  console.log("migrations applied");
}
