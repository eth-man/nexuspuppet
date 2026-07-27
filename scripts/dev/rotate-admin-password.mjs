#!/usr/bin/env node
/**
 * Rotate a local account's password without the new value ever being visible.
 *
 *   node scripts/dev/rotate-admin-password.mjs [email]
 *
 * The password is generated in-process, sent straight to the API, and written
 * to a 0600 file. It is never printed, never passed as an argument, and never
 * placed in an environment variable — all three are readable by any other
 * process on the box (`ps`, /proc, shell history).
 *
 * The current password is read from .env (BOOTSTRAP_ADMIN_PASSWORD) or from the
 * store file, so a second rotation needs no input at all.
 *
 * This goes through POST /account/password rather than writing a hash into
 * Postgres directly: that path verifies the current password, writes the audit
 * row, and revokes every other session in one transaction. A direct database
 * write would skip all three and leave stolen sessions alive.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envPath = join(repo, '.env');
const storeDir = join(homedir(), '.nexuspuppet');
const storePath = join(storeDir, 'admin-password');

const email = process.argv[2] ?? readEnv('BOOTSTRAP_ADMIN_EMAIL') ?? 'admin@example.com';
const apiUrl = process.env.API_URL ?? `http://127.0.0.1:${readEnv('API_PORT') ?? '3001'}`;

/** Read a key from .env without importing it into this process's environment. */
function readEnv(key) {
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] === key) return match[2].trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

/** Set or replace a key in .env, preserving everything else and the file mode. */
function writeEnv(updates) {
  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n') : [];
  for (const [key, value] of Object.entries(updates)) {
    const index = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    const rendered = `${key}=${value}`;
    if (index === -1) lines.push(rendered);
    else lines[index] = rendered;
  }
  writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
  chmodSync(envPath, 0o600);
}

/** Read the current password from stdin when it is piped in. */
async function readStdin() {
  if (process.stdin.isTTY) return undefined;
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim() === '' ? undefined : data.trim();
}

async function currentPassword() {
  // stdin first: it is the only source that leaves no trace on disk, and it is
  // how you bootstrap when .env has no value. Never take it from argv — command
  // lines are world-readable via ps and land in shell history.
  const piped = await readStdin();
  if (piped !== undefined) return piped;

  if (existsSync(storePath)) {
    const stored = readFileSync(storePath, 'utf8').trim();
    if (stored !== '') return stored;
  }
  const fromEnv = readEnv('BOOTSTRAP_ADMIN_PASSWORD');
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  throw new Error(
    'Cannot determine the current password. Pipe it in:\n' +
      '  read -rs CUR && printf %s "$CUR" | node scripts/dev/rotate-admin-password.mjs\n' +
      `or set BOOTSTRAP_ADMIN_PASSWORD in .env, or write it to ${storePath}.`,
  );
}

/**
 * 32 bytes of CSPRNG output, base64url. ~192 bits of entropy in 43 characters —
 * well past anything a human would choose, and safe to paste anywhere.
 */
function generate() {
  return randomBytes(32).toString('base64url');
}

/** Collect Set-Cookie headers into a single request Cookie header. */
function cookiesFrom(response) {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';', 1)[0])
    .join('; ');
}

async function main() {
  const oldPassword = await currentPassword();
  const newPassword = generate();

  const loginResponse = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: oldPassword }),
  });
  if (!loginResponse.ok) {
    throw new Error(
      `Could not sign in as ${email} (HTTP ${loginResponse.status}). ` +
        'The stored current password is wrong, or the API is not running.',
    );
  }

  const changeResponse = await fetch(`${apiUrl}/account/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookiesFrom(loginResponse) },
    body: JSON.stringify({ currentPassword: oldPassword, newPassword }),
  });
  if (changeResponse.status !== 204) {
    throw new Error(
      `Password change refused (HTTP ${changeResponse.status}): ${await changeResponse.text()}`,
    );
  }

  // Verify before storing. Storing a password the API did not accept would lock
  // the account out with no way back.
  const verify = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: newPassword }),
  });
  if (!verify.ok) {
    throw new Error(
      `The new password was accepted but does not work (HTTP ${verify.status}). ` +
        'NOT storing it. Investigate before rotating again.',
    );
  }

  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  writeFileSync(storePath, `${newPassword}\n`, { mode: 0o600 });
  chmodSync(storePath, 0o600);

  // Keep the dev stack and the E2E suite working. BOOTSTRAP_ADMIN_PASSWORD only
  // seeds an empty users table, but leaving a stale value there is a trap for
  // whoever next resets the database.
  writeEnv({ BOOTSTRAP_ADMIN_PASSWORD: newPassword, E2E_ADMIN_PASSWORD: newPassword });

  console.log(`Rotated the password for ${email}.`);
  console.log(`Stored (0600): ${storePath}`);
  console.log('Updated .env: BOOTSTRAP_ADMIN_PASSWORD, E2E_ADMIN_PASSWORD');
  console.log('Every other session for this account has been revoked.');
  console.log(`\nRead it with:  cat ${storePath}`);
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exit(1);
});
