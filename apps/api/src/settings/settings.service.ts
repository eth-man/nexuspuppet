import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_SINK,
  type IAuditSink,
  type LdapSettings,
  type OidcSettings,
  type ProviderVerification,
  type SettingsView,
} from '@nexuspuppet/contracts';
import type { AuthProviderResolver } from '../auth/auth-provider.resolver';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { SettingsStore } from './settings.store';

/** The source an LDAP configuration is dispatched to, matching IAuthProvider.source. */
const LDAP_SOURCE = 'ldap';

/**
 * Which fields of an LDAP configuration are secret.
 *
 * Named here rather than inferred from the value, so adding a field is a
 * deliberate decision about whether it is sensitive rather than an accident of
 * what it happens to be called.
 */
const LDAP_SECRET_FIELDS = ['bindPassword'] as const;

/** Same rule for OIDC: named here so adding a field is a deliberate decision. */
const OIDC_SECRET_FIELDS = ['clientSecret'] as const;

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly store: SettingsStore,
    @Inject(AUDIT_SINK) private readonly audit: IAuditSink,
    /**
     * The environment baseline for LDAP, or null when the environment does not
     * configure one. Supplied by the module so this service never reads
     * process.env directly — a service that reads the environment cannot be
     * tested against a different one.
     */
    private readonly ldapFromEnv: () => LdapSettings | null,
    /** Whether an LDAP provider is registered, i.e. whether edits take effect live. */
    private readonly ldapRegistered: () => boolean,
    /** The OIDC baseline, by the same route and for the same reason as LDAP's. */
    private readonly oidcFromEnv: () => OidcSettings | null,
    /** Whether an OIDC provider is registered, i.e. whether edits take effect live. */
    private readonly oidcRegistered: () => boolean,
  ) {}

  async describeLdap(): Promise<SettingsView<LdapSettings>> {
    const resolved = await this.store.describe<LdapSettings>('auth.ldap', this.ldapFromEnv);

    return {
      source: resolved.source,
      config: resolved.config,
      disabled: resolved.disabled,
      secretsHeld: resolved.secretsHeld,
      updatedAt: resolved.updatedAt?.toISOString() ?? null,
      updatedByEmail: resolved.updatedByEmail,
      liveReload: this.ldapRegistered(),
    };
  }

  /**
   * The OIDC configuration in force, without secrets. READ-ONLY (#106).
   *
   * There is no save counterpart on purpose: a provider snapshots its
   * configuration at construction, so a stored row would be shown here and
   * never applied. Reporting what IS running is worth having on its own — an
   * administrator can check the issuer and the role mappings without shell
   * access — and it is what lets the role-deletion guard see which roles OIDC
   * depends on (ADR-0018 §5).
   */
  async describeOidc(): Promise<SettingsView<OidcSettings>> {
    const resolved = await this.store.describe<OidcSettings>('auth.oidc', this.oidcFromEnv);

    return {
      source: resolved.source,
      config: resolved.config,
      disabled: resolved.disabled,
      secretsHeld: resolved.secretsHeld,
      updatedAt: resolved.updatedAt?.toISOString() ?? null,
      updatedByEmail: resolved.updatedByEmail,
      // True once a provider is registered, exactly as for LDAP: a saved
      // configuration reaches it on the next login through the settings seam
      // (#113). False means no OIDC provider exists yet, so turning SSO on for
      // the first time still needs one restart (ADR-0016 §4).
      liveReload: this.oidcRegistered(),
    };
  }

  /**
   * Replace the stored OIDC configuration.
   *
   * A body without `clientSecret` KEEPS the stored one, exactly as the LDAP
   * bind password does: the console never receives the secret, so it cannot
   * send it back, and treating its absence as "clear it" would strip the
   * credential every time somebody corrected a claim name.
   */
  async saveOidc(
    config: OidcSettings,
    request: AuthenticatedRequest,
  ): Promise<SettingsView<OidcSettings>> {
    const actor = request.principal;
    const before = await this.store.describe<OidcSettings>('auth.oidc', this.oidcFromEnv);

    await this.store.save(
      'auth.oidc',
      config as unknown as Record<string, unknown>,
      OIDC_SECRET_FIELDS,
      actor?.email ?? 'unknown',
    );

    const after = await this.describeOidc();

    // Audited with the REDACTED views on both sides: the trail records that the
    // identity provider changed and who changed it, never a client secret.
    await this.audit.record({
      actorUserId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      action: 'settings.auth.oidc.update',
      entityType: 'ProviderSetting',
      entityId: 'auth.oidc',
      before: before.config,
      after: after.config,
      ipAddress: request.ip ?? null,
      userAgent: headerOf(request, 'user-agent'),
    });

    if (!after.liveReload) {
      this.logger.warn(
        'OIDC settings saved, but no OIDC provider is registered — a restart is required ' +
          'before they take effect. Registration happens at boot (ADR-0016 §4).',
      );
    }

    return after;
  }

  /** Discard the stored configuration and fall back to the environment. */
  async clearOidc(request: AuthenticatedRequest): Promise<void> {
    const actor = request.principal;
    const before = await this.store.describe<OidcSettings>('auth.oidc', this.oidcFromEnv);

    await this.store.clear('auth.oidc');

    await this.audit.record({
      actorUserId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      action: 'settings.auth.oidc.clear',
      entityType: 'ProviderSetting',
      entityId: 'auth.oidc',
      before: before.config,
      after: null,
      ipAddress: request.ip ?? null,
      userAgent: headerOf(request, 'user-agent'),
    });
  }

  /**
   * Check a configuration against the identity provider.
   *
   * With no candidate this checks what is in force. With one, it checks what
   * WOULD be saved — the point of testing before committing, and the reason
   * configuring an identity provider by trial and error against the login
   * screen is how people lock themselves out.
   *
   * What it can establish is bounded and the UI must say so: a login happens
   * in a browser at another origin, so this proves the issuer answers, its
   * discovery document describes the issuer asked for, and its keys parse.
   */
  async verifyOidc(
    resolver: AuthProviderResolver,
    candidate?: OidcSettings,
  ): Promise<ProviderVerification> {
    const provider = resolver.forSource('oidc');

    if (provider === null) {
      return {
        ok: false,
        message: 'No OIDC provider is running in this deployment, so there is nothing to check.',
      };
    }
    if (provider.verifyConfiguration === undefined) {
      return { ok: false, message: 'The OIDC provider in this build cannot check itself.' };
    }

    try {
      // A candidate arriving without its secret is tested with the STORED one,
      // so "Test" does not fail for an operator who only changed a claim name.
      const withSecret = candidate === undefined ? undefined : await this.fillOidcSecret(candidate);
      return await provider.verifyConfiguration(withSecret);
    } catch (error) {
      this.logger.error(`OIDC verification threw: ${describe(error)}`);
      return {
        ok: false,
        message: 'The identity provider could not be reached. See the server log.',
      };
    }
  }

  async saveLdap(
    config: LdapSettings,
    request: AuthenticatedRequest,
  ): Promise<SettingsView<LdapSettings>> {
    const actor = request.principal;
    const before = await this.store.describe<LdapSettings>('auth.ldap', this.ldapFromEnv);

    await this.store.save(
      'auth.ldap',
      config as unknown as Record<string, unknown>,
      LDAP_SECRET_FIELDS,
      actor?.email ?? 'unknown',
    );

    const after = await this.describeLdap();

    // Audited with the REDACTED views on both sides. The audit trail records
    // that the directory changed and who changed it; it must not become the one
    // place a bind password is stored in clear.
    await this.audit.record({
      actorUserId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      action: 'settings.auth.ldap.update',
      entityType: 'ProviderSetting',
      entityId: 'auth.ldap',
      before: before.config,
      after: after.config,
      ipAddress: request.ip ?? null,
      userAgent: headerOf(request, 'user-agent'),
    });

    if (!after.liveReload) {
      this.logger.warn(
        'LDAP settings saved, but no LDAP provider is registered — a restart is required before ' +
          'they take effect. Registration happens at boot (ADR-0016 §4).',
      );
    }

    return after;
  }

  async clearLdap(request: AuthenticatedRequest): Promise<void> {
    const actor = request.principal;
    const before = await this.store.describe<LdapSettings>('auth.ldap', this.ldapFromEnv);

    await this.store.clear('auth.ldap');

    await this.audit.record({
      actorUserId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      action: 'settings.auth.ldap.clear',
      entityType: 'ProviderSetting',
      entityId: 'auth.ldap',
      before: before.config,
      after: null,
      ipAddress: request.ip ?? null,
      userAgent: headerOf(request, 'user-agent'),
    });
  }

  /**
   * Test a candidate configuration.
   *
   * Deliberately NOT audited. It changes nothing, and an operator correcting a
   * search base should not fill the audit trail with attempts — the save that
   * follows is the event worth recording.
   */
  async verifyLdap(
    candidate: LdapSettings,
    resolver: AuthProviderResolver,
  ): Promise<ProviderVerification> {
    const provider = resolver.forSource(LDAP_SOURCE);

    if (provider === null) {
      return {
        ok: false,
        message:
          'No LDAP provider is running in this deployment, so a configuration cannot be tested. ' +
          'Set LDAP_URL and restart once; after that, settings are editable here.',
      };
    }

    if (provider.verifyConfiguration === undefined) {
      return {
        ok: false,
        message: `The "${LDAP_SOURCE}" provider in this build cannot test a configuration.`,
      };
    }

    // A candidate arriving without a bind password should be tested with the
    // STORED one — otherwise "Test" fails for an operator who is only changing
    // a search base, and they learn nothing about the change they actually made.
    const withStoredSecrets = await this.fillSecrets(candidate);

    try {
      return await provider.verifyConfiguration(withStoredSecrets);
    } catch (error) {
      // A provider that throws is a bug in the provider, not an answer. Report
      // it as a failed test rather than a 500, because the operator's question
      // — "does this configuration work" — has been answered either way.
      this.logger.error(`LDAP verification threw: ${describe(error)}`);
      return { ok: false, message: 'The directory could not be reached. See the server log.' };
    }
  }

  private async fillOidcSecret(candidate: OidcSettings): Promise<OidcSettings> {
    if (candidate.clientSecret !== undefined) return candidate;

    const stored = await this.store.resolve<OidcSettings>('auth.oidc', this.oidcFromEnv);
    if (stored.config?.clientSecret === undefined) return candidate;

    return { ...candidate, clientSecret: stored.config.clientSecret };
  }

  private async fillSecrets(candidate: LdapSettings): Promise<LdapSettings> {
    if (candidate.bindPassword !== undefined) return candidate;

    const stored = await this.store.resolve<LdapSettings>('auth.ldap', this.ldapFromEnv);
    if (stored.config?.bindPassword === undefined) return candidate;

    return { ...candidate, bindPassword: stored.config.bindPassword };
  }
}

function headerOf(request: AuthenticatedRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value.slice(0, 500) : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
