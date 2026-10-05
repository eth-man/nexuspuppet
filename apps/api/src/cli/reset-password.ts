import 'reflect-metadata';
import { hashPassword } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';
import {
  EXIT,
  actorFor,
  buildAuditSink,
  cliSettings,
  reportOutcome,
  readPassword,
  redact,
  resetLocalPassword,
} from './admin-reset';

/**
 * Entry point for `scripts/deploy.sh --reset-admin <email>`:
 *
 *   printf '%s\n' "$pw" | docker compose run --rm --no-deps -T api \
 *     node dist/cli/reset-password.js <email>
 *
 * The password arrives on STDIN only (see readPassword). Exit codes: 0 reset,
 * 1 other failure, 2 no such account, 3 not a local account, 4 password refused
 * by the policy. Nothing printed contains the password or its hash.
 *
 * Runs in a one-off container of the api service, so it has the API's
 * DATABASE_URL and settings without starting the API (admin-reset.ts).
 */

export interface CliIo {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdin: AsyncIterable<Buffer | string> & { isTTY?: boolean };
  out: (line: string) => void;
  err: (line: string) => void;
  /** Injected so a test can run without a database. */
  connect?: (databaseUrl: string) => Promise<PrismaService>;
  hash?: (plaintext: string) => Promise<string>;
}

export async function run(io: CliIo): Promise<number> {
  const email = (io.argv[2] ?? '').trim();
  if (email === '' || io.argv.length > 3) {
    io.err('Usage: node dist/cli/reset-password.js <email>   (new password on stdin)');
    return EXIT.failed;
  }

  // A terminal would echo what is typed. deploy.sh prompts without echo and
  // pipes the result in; refusing here keeps anyone from typing it visibly.
  if (io.stdin.isTTY === true) {
    io.err(
      'Refusing to read a password from a terminal, which would echo it. ' +
        'Use: sudo ./scripts/deploy.sh --reset-admin <email>',
    );
    return EXIT.failed;
  }

  const password = await readPassword(io.stdin);
  const hash = io.hash ?? hashPassword;
  let passwordHash = '';
  const hashing = async (plaintext: string): Promise<string> => {
    passwordHash = await hash(plaintext);
    return passwordHash;
  };

  let prisma: PrismaService | null = null;
  try {
    const settings = cliSettings(io.env);
    prisma = await (io.connect ?? connect)(settings.DATABASE_URL);
    const audit = await buildAuditSink(prisma, io.env, io.err);

    const outcome = await resetLocalPassword(
      { db: prisma, audit, hash: hashing, actor: actorFor(io.env['NEXUSPUPPET_RESET_HOST']) },
      { email, password },
    );

    const report = reportOutcome(outcome);
    report.stdout.forEach(io.out);
    report.stderr.forEach(io.err);
    return report.code;
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    io.err(`Password reset failed; nothing was changed. ${redact(text, [password, passwordHash])}`);
    return EXIT.failed;
  } finally {
    if (prisma !== null) await prisma.$disconnect().catch(() => undefined);
  }
}

async function connect(databaseUrl: string): Promise<PrismaService> {
  // $connect, not onModuleInit: the latter logs through Nest, and this
  // command's output is read by a person at a prompt.
  const prisma = new PrismaService(databaseUrl);
  await prisma.$connect();
  return prisma;
}

if (require.main === module) {
  void run({
    argv: process.argv,
    env: process.env,
    stdin: process.stdin,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }).then((code) => {
    // Explicit: a pool or a stray handle must not keep a one-off container
    // alive after the work is done.
    process.exit(code);
  });
}
