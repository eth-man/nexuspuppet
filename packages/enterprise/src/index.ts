import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_DELIVERY_OUTBOX,
  AUDIT_FORWARDING_SETTINGS,
  AUDIT_SINK,
  AUTH_PROVIDER_SETTINGS,
  AUDIT_TRANSPORT,
  CAPABILITIES,
  CORE_AUDIT_SINK,
  USER_DIRECTORY,
  type CapabilityName,
  type CapabilityRegistration,
  type EnterpriseEntrypoint,
  type EnterpriseModuleDescriptor,
  type IAuditDeliveryOutbox,
  type IAuditForwardingSettings,
  type IAuditSink,
  type IAuthProviderSettings,
  type IAuditTransport,
  type IUserDirectory,
} from '@nexuspuppet/contracts';
import { LdapAuthProvider, LdaptsDirectory, ldapConfigFromEnv } from './ldap';
import {
  HttpTokenExchange,
  NodeOidcHttp,
  OidcAuthProvider,
  OidcDirectory,
  oidcConfigFromEnv,
  type OidcConfig,
} from './oidc';
import { ForwardingAuditSink, SettingsAuditTransport, auditExportConfigFromEnv } from './audit';

/**
 * The enterprise layer entrypoint (ADR-0002).
 *
 * Core discovers this package at boot through a dynamic import in
 * apps/api/src/enterprise/enterprise.loader.ts — the single file permitted to
 * reference it. Registration is ONE-WAY: this package implements interfaces
 * declared in @nexuspuppet/contracts and returns a descriptor. It never imports
 * core internals, and core never imports it at compile time.
 *
 * A throw from register() is FATAL by design. An operator who installed the
 * enterprise layer must never silently get core behaviour instead — a
 * deployment that paid for SSO must not quietly fall back to local password
 * auth at 3am.
 */

const PACKAGE_VERSION = '0.1.0';

/**
 * The contracts version this build TARGETS, as a literal.
 *
 * Deliberately not `CONTRACTS_VERSION` imported from the package: TypeScript
 * emits a runtime property lookup, so the descriptor would always report
 * whatever core happens to provide, and the loader's mismatch check could never
 * fire. Hardcoding it is what makes that check mean anything — this value moves
 * only when the package is rebuilt and retested against a new contract.
 */
const TARGET_CONTRACTS_VERSION = '0.5.2';

/**
 * Nest-injectable wrapper.
 *
 * CapabilityRegistry applies enterprise registrations with `useClass`, so what
 * crosses the boundary must be a class Nest can construct. The authentication
 * logic itself lives in LdapAuthProvider, which takes plain dependencies and is
 * unit-tested without Nest, without a directory, and without a database.
 */
@Injectable()
export class LdapAuthProviderModule extends LdapAuthProvider {
  constructor(
    @Inject(USER_DIRECTORY) directory: IUserDirectory,
    @Inject(AUTH_PROVIDER_SETTINGS) settings: IAuthProviderSettings,
  ) {
    const config = ldapConfigFromEnv();
    super({
      config,
      directory: new LdaptsDirectory(config),
      identities: directory,
      logger: new Logger('LdapAuthProvider'),
      // What makes a saved configuration take effect on the next login rather
      // than the next restart (ADR-0016 §4, #113). The environment above stays
      // the bootstrap baseline; this only overrides once something is stored.
      settings,
    });
  }
}

/**
 * Nest-injectable wrapper for the forwarding sink.
 *
 * Takes CORE_AUDIT_SINK and AUDIT_DELIVERY_OUTBOX by token because neither
 * class may be named from here (ADR-0002). The logic lives in
 * ForwardingAuditSink, which takes plain dependencies and is unit-tested
 * without Nest and without a database.
 *
 * The AUDIT_TRANSPORT injection resolves to SettingsAuditTransportModule
 * below — the sink asks ITS cached view whether anything can send before
 * enqueueing, so "forwarding off" does not quietly fill the audit table with
 * jobs that retention may never sweep.
 */
@Injectable()
export class ForwardingAuditSinkModule extends ForwardingAuditSink {
  constructor(
    @Inject(CORE_AUDIT_SINK) core: IAuditSink,
    @Inject(AUDIT_DELIVERY_OUTBOX) outbox: IAuditDeliveryOutbox,
    @Inject(AUDIT_TRANSPORT) transport: IAuditTransport,
  ) {
    super(core, outbox, auditExportConfigFromEnv(), () => transport.configured);
  }
}

/**
 * Nest-injectable wrapper for the OIDC provider.
 *
 * A REDIRECT-mode provider: it never sees a password, and core drives it
 * through /auth/redirect and /auth/callback. The directory and the token
 * exchange are constructed here so the provider itself stays testable without a
 * network.
 */
@Injectable()
export class OidcAuthProviderModule extends OidcAuthProvider {
  constructor(
    @Inject(USER_DIRECTORY) directory: IUserDirectory,
    @Inject(AUTH_PROVIDER_SETTINGS) settings: IAuthProviderSettings,
  ) {
    const config = requireOidcConfig();
    const http = new NodeOidcHttp();
    super({
      config,
      directory: new OidcDirectory(config.issuer, http, config.timeoutMs),
      identities: directory,
      logger: new Logger('OidcAuthProvider'),
      exchange: new HttpTokenExchange(config, http),
      // A saved configuration takes effect on the next login (ADR-0016 §4).
      settings,
      // A different issuer gets its own discovery cache, JWKS and token
      // credentials — none of the boot ones survive a change of provider.
      directoryFor: (next) => new OidcDirectory(next.issuer, http, next.timeoutMs),
      exchangeFor: (next) => new HttpTokenExchange(next, http),
    });
  }
}

function requireOidcConfig(): OidcConfig {
  const config = oidcConfigFromEnv();
  if (config === null) {
    throw new Error(
      'OIDC was registered but OIDC_ISSUER is no longer set. ' +
        'The environment changed between registration and injection.',
    );
  }
  return config;
}

/**
 * Nest-injectable wrapper for the transport.
 *
 * Settings-driven (ADR-0016 §4): the operator's stored choice — syslog,
 * webhook, or off — is resolved through core's AUDIT_FORWARDING_SETTINGS seam
 * on every delivery, with the environment's webhook configuration as the
 * bootstrap baseline when nothing was ever stored. AUDIT_EXPORT_URL is
 * therefore OPTIONAL now: a deployment may configure forwarding entirely from
 * the console.
 */
@Injectable()
export class SettingsAuditTransportModule extends SettingsAuditTransport {
  constructor(@Inject(AUDIT_FORWARDING_SETTINGS) settings: IAuditForwardingSettings) {
    super(settings, auditExportConfigFromEnv());
  }
}


export const entrypoint: EnterpriseEntrypoint = {
  register(): EnterpriseModuleDescriptor {
    const oidc = oidcConfigFromEnv();
    const ldapConfigured = (process.env['LDAP_URL'] ?? '').trim() !== '';

    /*
     * BOTH is now a valid state (ADR-0023).
     *
     * This used to throw, on the grounds that "exactly one authentication
     * provider may own AUTH_PROVIDER" — true under ADR-0006, and untrue since
     * ADR-0015 replaced that token with a collection and gave core a
     * `source -> provider` resolver. Core has dispatched by the account's
     * `authSource` ever since. The guard outlived its reason by two ADRs, and
     * the visible cost was an enterprise deployment being told to buy
     * Enterprise to unlock OIDC it was already licensed for.
     *
     * What core still refuses, and should, is two providers claiming the SAME
     * source — that would dispatch by Map insertion order, which is nobody's
     * intent. One LDAP and one OIDC claim different sources.
     */
    // Neither configured is now a VALID state, not a fatal one (ADR-0015).
    //
    // This used to throw, and a throw here is fatal in the loader — so an
    // operator who enabled LDAP, locked themselves out, and tried to back the
    // change out by unsetting LDAP_URL found the API would no longer boot at
    // all. There was no way back short of writing to the database by hand.
    //
    // With authentication additive, an enterprise layer contributing no
    // directory provider is simply a deployment where core's local accounts
    // serve everybody. That is a working product, so it starts.
    // Validate NOW rather than at first login. It throws with a readable
    // message, and the loader makes that fatal — a deployment that believes it
    // has a directory must never quietly fall back to local password auth.
    //
    // Keyed on `ldapConfigured` alone. It used to read
    // `directoryConfigured && oidc === null`, which was equivalent while the
    // two were mutually exclusive and silently WRONG the moment they were not:
    // with both set, a malformed LDAP_URL would sail past boot and surface as a
    // failed login. OIDC validates itself through `oidcConfigFromEnv()` above.
    if (ldapConfigured) ldapConfigFromEnv();

    // Validated at boot even though it is now only the BASELINE: a URL that is
    // present but malformed throws, and the loader makes that fatal — a
    // deployment that believes it is forwarding to a SIEM must never quietly
    // not be. Absence stopped being meaningful for registration (see below);
    // it only means the console is the sole way to configure forwarding.
    auditExportConfigFromEnv();

    /*
     * INDEPENDENT, not alternatives (ADR-0023 §1).
     *
     * These used to be an either/or ternary, which made a *licence* token
     * stand in for a *configuration* choice: a deployment running LDAP did not
     * advertise `sso.oidc`, so the console showed OIDC locked behind a padlock
     * reading "Enterprise" — to an operator already running Enterprise.
     *
     * Each is now advertised when, and only when, that provider is configured.
     */
    const capabilities: CapabilityName[] = [];
    if (ldapConfigured) capabilities.push(CAPABILITIES.DIRECTORY_LDAP);
    if (oidc !== null) capabilities.push(CAPABILITIES.SSO_OIDC);

    /*
     * Role editing (ADR-0018 §6).
     *
     * Declared unconditionally, unlike the directory capabilities: it needs no
     * configuration of its own. The roles table, per-request resolution and the
     * lockout rules are all core and run everywhere; what this licenses is
     * being able to define a role rather than only use the built-in three.
     *
     * It registers NOTHING. There is no provider to swap in — core owns the
     * whole implementation and only asks whether the capability is present
     * (ADR-0002). A capability with no registration is unusual enough to be
     * worth saying out loud.
     */
    capabilities.push(CAPABILITIES.RBAC_CUSTOM);

    const registrations: CapabilityRegistration[] = [];

    // ADDITIVE, not an override of AUTH_PROVIDER (ADR-0015).
    //
    // Overriding that token removed core's local provider rather than shadowing
    // it, so enabling a directory locked every local account out. Core refuses
    // the override now; this list sits alongside local authentication and is
    // dispatched to by the account's authSource.
    const authProviders: unknown[] = [];
    if (ldapConfigured) authProviders.push(LdapAuthProviderModule);
    if (oidc !== null) authProviders.push(OidcAuthProviderModule);

    /*
     * UNCONDITIONAL now, where this used to be gated on AUDIT_EXPORT_URL
     * (ADR-0016 §4). Registration fixes which providers exist at boot;
     * CONFIGURATION lives in the settings store and changes while the process
     * runs. Gating registration on an environment variable would mean the
     * console's Integrations screen stays greyed out until an operator sets a
     * variable whose entire purpose the screen replaces.
     *
     * Both halves, together. Registering the sink without the transport would
     * queue records with nowhere to go; the transport without the sink would
     * leave nothing enqueuing them. The sink gates its enqueue on the
     * transport's live view, so an unconfigured deployment queues nothing.
     */
    capabilities.push(CAPABILITIES.AUDIT_EXPORT);
    registrations.push(
      { token: AUDIT_SINK, provider: ForwardingAuditSinkModule },
      { token: AUDIT_TRANSPORT, provider: SettingsAuditTransportModule },
    );

    return {
      name: '@nexuspuppet/enterprise',
      version: PACKAGE_VERSION,
      // Must match what core provides or the loader refuses to start: running
      // authorization code against a different contract risks being silently
      // wrong in the worst possible place.
      contractsVersion: TARGET_CONTRACTS_VERSION,
      capabilities,
      registrations,
      authProviders,
    };
  },
};

/** Named export as well as default: the loader tolerates either shape. */
export function register(): EnterpriseModuleDescriptor {
  return entrypoint.register() as EnterpriseModuleDescriptor;
}

export default entrypoint;
export * from './ldap';
export * from './audit';
export * from './oidc';
