// ADR-0002 §6: this is the SINGLE file permitted to reference the enterprise
// package. It does so only through a dynamic import() with a runtime-built
// specifier, which is expected to fail in core builds.

import { Logger } from '@nestjs/common';
import {
  CONTRACTS_VERSION,
  EnterpriseLoadError,
  type DeploymentCapabilities,
  type EnterpriseEntrypoint,
  type EnterpriseModuleDescriptor,
} from '@nexuspuppet/contracts';

/**
 * Runtime discovery of the optional enterprise layer (ADR-0002).
 *
 * The specifier below is built at runtime so that no bundler, and no
 * TypeScript resolution pass, ever tries to resolve it statically. In a core
 * build the package genuinely does not exist and the import is expected to
 * fail — that is the normal path, not an error.
 *
 * Two failure modes, deliberately treated differently:
 *
 *   ABSENT  -> core edition. Logged once at info. Not an error.
 *   PRESENT BUT BROKEN -> fatal. An operator who installed the enterprise layer
 *                         must never silently get core behaviour instead. A
 *                         deployment that paid for SSO must not quietly fall
 *                         back to local auth at 3am.
 */

const ENTERPRISE_PACKAGE = '@nexuspuppet/enterprise';

const MODULE_NOT_FOUND = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);

export interface LoadedEnterprise {
  descriptor: EnterpriseModuleDescriptor;
}

export class EnterpriseLoader {
  private static readonly logger = new Logger(EnterpriseLoader.name);

  /**
   * @returns the descriptor when an enterprise layer is installed, or null for
   *          a core deployment.
   * @throws EnterpriseLoadError when a package is present but unusable.
   */
  static async load(): Promise<LoadedEnterprise | null> {
    let entrypoint: EnterpriseEntrypoint;

    try {
      // Indirection through a variable keeps this un-analysable statically.
      const specifier = ENTERPRISE_PACKAGE;
      const imported: unknown = await import(/* webpackIgnore: true */ specifier);
      entrypoint = resolveEntrypoint(imported);
    } catch (error) {
      if (isModuleNotFound(error)) {
        this.logger.log('No enterprise layer installed — running core edition.');
        return null;
      }
      throw new EnterpriseLoadError(
        `The enterprise package is present but could not be imported. Refusing to start rather than silently downgrading to core edition. Cause: ${describe(error)}`,
        { cause: error },
      );
    }

    let descriptor: EnterpriseModuleDescriptor;
    try {
      descriptor = await entrypoint.register();
    } catch (error) {
      throw new EnterpriseLoadError(
        `The enterprise layer failed during register(): ${describe(error)}`,
        { cause: error },
      );
    }

    assertUsable(descriptor);

    this.logger.log(
      `Enterprise layer loaded: ${descriptor.name}@${descriptor.version} ` +
        `(capabilities: ${descriptor.capabilities.join(', ') || 'none'})`,
    );

    return { descriptor };
  }

  static describeDeployment(loaded: LoadedEnterprise | null): DeploymentCapabilities {
    if (loaded === null) {
      return { edition: 'core', enterpriseVersion: null, capabilities: [] };
    }
    return {
      edition: 'enterprise',
      enterpriseVersion: loaded.descriptor.version,
      capabilities: loaded.descriptor.capabilities,
    };
  }
}

function resolveEntrypoint(imported: unknown): EnterpriseEntrypoint {
  if (imported === null || typeof imported !== 'object') {
    throw new EnterpriseLoadError('Enterprise package did not export a module object.');
  }

  const mod = imported as Record<string, unknown>;
  // Tolerate both `export default { register }` and `export function register()`,
  // and the CommonJS interop shape.
  const candidate = (mod['default'] as Record<string, unknown> | undefined) ?? mod;

  if (typeof (candidate as { register?: unknown }).register !== 'function') {
    throw new EnterpriseLoadError(
      'Enterprise package must export a `register()` function (see EnterpriseEntrypoint in @nexuspuppet/contracts).',
    );
  }

  return candidate as unknown as EnterpriseEntrypoint;
}

/**
 * A contracts-version mismatch is fatal rather than best-effort. The enterprise
 * build compiles against a published contracts version; running it against a
 * different one risks silently wrong behaviour in authorization code, which is
 * the worst place to be approximately correct.
 */
function assertUsable(descriptor: EnterpriseModuleDescriptor): void {
  if (typeof descriptor?.name !== 'string' || typeof descriptor?.version !== 'string') {
    throw new EnterpriseLoadError('Enterprise register() returned a malformed descriptor.');
  }

  const expected = major(CONTRACTS_VERSION);
  const actual = major(descriptor.contractsVersion ?? '');

  if (actual === null || actual !== expected) {
    throw new EnterpriseLoadError(
      `Enterprise layer targets contracts ${descriptor.contractsVersion ?? '<missing>'} ` +
        `but this build provides ${CONTRACTS_VERSION}. Rebuild the enterprise layer against the matching contracts version.`,
    );
  }

  if (!Array.isArray(descriptor.registrations)) {
    throw new EnterpriseLoadError('Enterprise descriptor.registrations must be an array.');
  }

  for (const registration of descriptor.registrations) {
    if (typeof registration?.token !== 'symbol') {
      throw new EnterpriseLoadError(
        'Every enterprise registration must name a capability token from @nexuspuppet/contracts.',
      );
    }
  }
}

/** Pre-1.0, the minor is treated as the breaking-change axis. */
function major(version: string): string | null {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (match === null) return null;
  return match[1] === '0' ? `0.${match[2]}` : (match[1] as string);
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && MODULE_NOT_FOUND.has(code)) return true;
  // Some loaders surface this only in the message.
  const message = (error as Error | null)?.message ?? '';
  return message.includes(ENTERPRISE_PACKAGE) && /cannot find|not found/i.test(message);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
