#!/usr/bin/env node
/**
 * Fetch the private enterprise layer into packages/enterprise/ (ADR-0002).
 *
 * Deliberately NOT a git submodule. A submodule would publish the private
 * repository URL in .gitmodules and would break `npm install` for every
 * external contributor who cannot clone it.
 *
 * The private repository's location comes from the environment and appears
 * nowhere in this repository.
 *
 *   NEXUSPUPPET_ENTERPRISE_REPO   git URL (required to do anything)
 *   NEXUSPUPPET_ENTERPRISE_REF    branch/tag/sha (default: main)
 *
 * With no repo configured this exits 0 with a notice — never an error. Public
 * CI runs it and it does nothing, which is the point.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'packages/enterprise');

const repo = process.env.NEXUSPUPPET_ENTERPRISE_REPO;
const ref = process.env.NEXUSPUPPET_ENTERPRISE_REF ?? 'main';

if (!repo) {
  console.log(
    '[enterprise] NEXUSPUPPET_ENTERPRISE_REPO is not set — building core edition.\n' +
      '[enterprise] This is the normal path for the public repository.',
  );
  process.exit(0);
}

const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });

try {
  if (existsSync(target)) {
    console.log(`[enterprise] Updating existing checkout at packages/enterprise (${ref})`);
    run('git', ['-C', target, 'fetch', '--depth', '1', 'origin', ref]);
    run('git', ['-C', target, 'checkout', '--force', 'FETCH_HEAD']);
  } else {
    // Avoid echoing the URL: it is private, and CI logs are often shared.
    console.log(`[enterprise] Cloning enterprise layer (${ref}) into packages/enterprise`);
    run('git', ['clone', '--depth', '1', '--branch', ref, repo, target]);
  }

  console.log(
    '[enterprise] Done. Run `npm install` to link the workspace, then start the API to load it.',
  );
} catch (error) {
  // A configured-but-failing fetch IS an error: an operator who asked for the
  // enterprise layer must not silently get core (ADR-0002 §4).
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.error('[enterprise] Removed the partial checkout to avoid a half-installed layer.');
  }
  console.error(`[enterprise] Failed to fetch the enterprise layer: ${error.message}`);
  process.exit(1);
}
