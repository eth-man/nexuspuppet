#!/usr/bin/env node
/**
 * Create a database if it does not already exist.
 *
 *   node scripts/ci/ensure-database.mjs <name> [adminUrl]
 *
 * Prisma does NOT create the shadow database that
 * `migrate diff --from-migrations` needs — it connects to it and fails with
 * P1003 if it is missing. On a developer machine it usually exists already,
 * created as a side effect of `prisma migrate dev`, which is exactly why its
 * absence only ever shows up in CI.
 *
 * Uses `pg` directly rather than psql: pg is already a dependency, so this
 * works on any runner image without assuming client tools are installed.
 */
import { Client } from 'pg';

const name = process.argv[2];
const adminUrl =
  process.argv[3] ??
  process.env.ADMIN_DATABASE_URL ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/postgres';

if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
  console.error('usage: ensure-database.mjs <name> [adminUrl]  (name: identifier characters only)');
  process.exit(1);
}

const client = new Client({ connectionString: adminUrl });

try {
  await client.connect();
  // CREATE DATABASE cannot be parameterised and cannot run inside a
  // transaction. The name is validated against an identifier pattern above.
  await client.query(`CREATE DATABASE "${name}"`);
  console.log(`created database ${name}`);
} catch (error) {
  if (error.code === '42P04') {
    console.log(`database ${name} already exists`);
  } else {
    console.error(`could not create ${name}: ${error.message}`);
    process.exitCode = 1;
  }
} finally {
  await client.end().catch(() => {});
}
