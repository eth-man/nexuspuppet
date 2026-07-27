import type { CapabilityToken, CapabilityName } from './tokens';

/**
 * The enterprise boundary contract (ADR-0002).
 *
 * Registration is ONE-WAY. The enterprise package implements interfaces
 * declared in this package and returns a descriptor. It never imports core
 * internals, and core never imports it at compile time — the only permitted
 * reference is a dynamic import() inside apps/api/src/enterprise/enterprise.loader.ts,
 * which is the single file exempted from the ESLint boundary rule.
 *
 * This file is the entire surface area of the open-core seam. If something
 * needs to cross the boundary and cannot be expressed here, that is a design
 * signal, not a reason to widen the exemption.
 */

/** Minimum contracts version the enterprise build was compiled against. */
export const CONTRACTS_VERSION = '0.1.0';

export interface CapabilityRegistration {
  token: CapabilityToken;
  /**
   * A NestJS provider class implementing the token's interface. Typed as
   * unknown because contracts must not depend on @nestjs/common — the API
   * narrows it at registration time.
   */
  provider: unknown;
}

export interface EnterpriseModuleDescriptor {
  name: string;
  version: string;
  /** Contracts version this build targets. Mismatch is a hard boot failure. */
  contractsVersion: string;
  /** Capabilities this build provides, subject to licence validation. */
  capabilities: CapabilityName[];
  /** Token overrides applied over core defaults. */
  registrations: CapabilityRegistration[];
  /** Optional NestJS module classes to import wholesale. */
  modules?: unknown[];
}

/** The shape `packages/enterprise` must default-export. */
export interface EnterpriseEntrypoint {
  register(): Promise<EnterpriseModuleDescriptor> | EnterpriseModuleDescriptor;
}

/**
 * Thrown when an enterprise package is present but unusable — version mismatch,
 * malformed descriptor, or a failing registration.
 *
 * This is deliberately fatal. A present-but-broken enterprise package must NOT
 * silently downgrade a paying deployment to core behaviour; an operator who
 * installed SSO must never discover at 3am that local auth quietly took over.
 * An ABSENT package is not an error — that is just core.
 */
export class EnterpriseLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EnterpriseLoadError';
  }
}

/** Returned by GET /capabilities so the UI can hide or disable unavailable features. */
export interface DeploymentCapabilities {
  edition: 'core' | 'enterprise';
  enterpriseVersion: string | null;
  capabilities: CapabilityName[];
}
