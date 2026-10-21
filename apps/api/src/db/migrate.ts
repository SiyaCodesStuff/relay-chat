import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { z } from "zod";

const target = process.argv[2] === "test" ? "DATABASE_URL_TEST" : "DATABASE_URL";
const databaseUrl = z.string().url().safeParse(process.env[target]);

if (!databaseUrl.success) {
  console.error(`Invalid migration configuration. Check ${target}.`);
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl.data });

try {
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
} catch {
  console.error("Database migration failed.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
