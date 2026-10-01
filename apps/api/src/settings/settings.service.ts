import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_SINK,
  type DirectorySettingsView,
  type IAuditSink,
  type LdapSettings,
  type LdapSettingsView,
  type OidcSettings,
  type ProviderVerification,
} from '@nexuspuppet/contracts';
import type { AuthProviderResolver } from '../auth/auth-provider.resolver';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { CaPemError, parseCaPem, summariseCaPem } from '../directory/ldap/ca-pem';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsStore, SettingsStoreError, type SettingKind } from './settings.store';

/** The source an LDAP configuration is dispatched to, matching IAuthProvider.source. */
const LDAP_SOURCE = 'ldap';

/**
 * Which fields of an LDAP configuration are secret.
 *
 * Named here rather than inferred from the value, so adding a field is a
 * deliberate decision about whether it is sensitive rather than an accident of
 * what it happens to be called. `caPem` is deliberately NOT here: a CA
 * certificate is public by construction (ADR-0029 §5).
 */
const LDAP_SECRET_FIELDS = ['bindPassword'] as const;

/** Same rule for OIDC: named here so adding a field is a deliberate decision. */
const OIDC_SECRET_FIELDS = ['clientSecret'] as const;

/**
 * Directory authentication settings (ADR-0016, ADR-0029).
 *
 * Both directory providers are registered on every deployment, so everything
 * saved here takes effect at the next sign-in — including the FIRST
 * configuration on a deployment that never set `LDAP_*` or `OIDC_*`. There is
 * no restart-required path any more, and `liveReload` is always true.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly store: SettingsStore,
    /**
     * Only to open the transaction that binds a change to its audit record
     * (#103, ADR-0005). Reads and writes of settings still go through the
     * store, which owns the encryption and the env-vs-stored precedence.
     */
    private readonly prisma: PrismaService,
    @Inject(AUDIT_SINK) private readonly audit: IAuditSink,
    /**
     * The environment baseline for LDAP, or null when the environment does not
     * configure one. Supplied by the module so this service never reads
     * process.env directly — a service that reads the environment cannot be
     * tested against a different one.
     */
    private readonly ldapFromEnv: () => LdapSettings | null,
    /** The OIDC baseline, by the same route and for the same reason as LDAP's. */
    private readonly oidcFromEnv: () => OidcSettings | null,
  ) {}

  async describeLdap(): Promise<LdapSettingsView> {
    const resolved = await this.store.describe<LdapSettings>('auth.ldap', this.ldapFromEnv);

    return {
      source: resolved.source,
      config: resolved.config,
      disabled: resolved.disabled,
      secretsHeld: resolved.secretsHeld,
      updatedAt: resolved.updatedAt?.toISOString() ?? null,
      updatedByEmail: resolved.updatedByEmail,
      // Always: the provider is registered whether or not anything is
      // configured, so a save reaches the next login (ADR-0029).
      liveReload: true,
      secretsStorable: this.store.canStoreSecrets,
      caCertificates: summariseCaPem(resolved.config?.caPem),
    };
  }

  /** The OIDC configuration in force, without secrets. */
  async describeOidc(): Promise<DirectorySettingsView<OidcSettings>> {
    const resolved = await this.store.describe<OidcSettings>('auth.oidc', this.oidcFromEnv);

    return {
      source: resolved.source,
      config: resolved.config,
      disabled: resolved.disabled,
      secretsHeld: resolved.secretsHeld,
      updatedAt: resolved.updatedAt?.toISOString() ?? null,
      updatedByEmail: resolved.updatedByEmail,
      liveReload: true,
      secretsStorable: this.store.canStoreSecrets,
    };
  }

  /**
   * Replace the stored OIDC configuration. Takes effect at the next sign-in.
   *
   * A body without `clientSecret` KEEPS the stored one, exactly as the LDAP
   * bind password does: the console never receives the secret, so it cannot
   * send it back, and treating its absence as "clear it" would strip the
   * credential every time somebody corrected a claim name.
   */
  async saveOidc(
    config: OidcSettings,
    request: AuthenticatedRequest,
  ): Promise<DirectorySettingsView<OidcSettings>> {
    this.requireKeyFor(config.clientSecret, 'a client secret');
    await this.saveAudited('auth.oidc', config, OIDC_SECRET_FIELDS, this.oidcFromEnv, request);
    return this.describeOidc();
  }

  /**
   * Discard the stored configuration. The provider falls back to the
   * environment, or — with no environment baseline — becomes dormant, and its
   * accounts are refused at the next sign-in (ADR-0029).
   */
  async clearOidc(request: AuthenticatedRequest): Promise<void> {
    await this.clearAudited('auth.oidc', this.oidcFromEnv, request);
  }

  /**
   * Check a configuration against the identity provider.
   *
   * With no candidate this checks what is in force. With one, it checks what
   * WOULD be saved — the point of testing before committing, and the reason
   * configuring an identity provider by trial and error against the login
   * screen is how people lock themselves out. Works before anything is
   * configured: the provider builds clients for the candidate (ADR-0029).
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
      // Unreachable since ADR-0029 registers the provider everywhere; kept so
      // a wiring mistake reads as an answer rather than a 500.
      return { ok: false, message: 'No OIDC provider is registered in this build.' };
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

  /**
   * Replace the stored LDAP configuration. Takes effect at the next sign-in,
   * including on a deployment that never set LDAP_URL (ADR-0029).
   */
  async saveLdap(config: LdapSettings, request: AuthenticatedRequest): Promise<LdapSettingsView> {
    this.validateCa(config);
    this.requireKeyFor(config.bindPassword, 'a bind password');
    await this.saveAudited('auth.ldap', config, LDAP_SECRET_FIELDS, this.ldapFromEnv, request);
    return this.describeLdap();
  }

  /**
   * Discard the stored configuration. The provider falls back to the
   * environment, or becomes dormant (ADR-0029). Local accounts are never
   * affected — they do not go through this provider at all (ADR-0015).
   */
  async clearLdap(request: AuthenticatedRequest): Promise<void> {
    await this.clearAudited('auth.ldap', this.ldapFromEnv, request);
  }

  /**
   * Test a candidate configuration.
   *
   * Deliberately NOT audited. It changes nothing, and an operator correcting a
   * search base should not fill the audit trail with attempts — the save that
   * follows is the event worth recording.
   *
   * Works with no boot configuration: the provider builds its own client for
   * the candidate, so a fresh deployment can test before its first save.
   */
  async verifyLdap(
    candidate: LdapSettings,
    resolver: AuthProviderResolver,
  ): Promise<ProviderVerification> {
    const provider = resolver.forSource(LDAP_SOURCE);

    if (provider === null) {
      return { ok: false, message: 'No LDAP provider is registered in this build.' };
    }

    if (provider.verifyConfiguration === undefined) {
      return {
        ok: false,
        message: `The "${LDAP_SOURCE}" provider in this build cannot test a configuration.`,
      };
    }

    // A pasted CA that does not parse is answered here, in its own words,
    // rather than as the TLS failure it would otherwise cause.
    const problem = caProblem(candidate);
    if (problem !== null) return { ok: false, message: problem };

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

  /**
   * Store a configuration and its audit record in ONE TRANSACTION (#103,
   * ADR-0005).
   *
   * The change, its audit record, and the delivery the sink enqueues from that
   * record commit together. Written separately the sink receives no
   * transaction, declines to enqueue, and the change reaches the trail but
   * never the SIEM.
   *
   * What blocked this before was the `after` payload: it was built by reading
   * the row back, and a read outside the transaction sees the OLD row. It is
   * built from the submitted configuration instead, minus its secrets — which
   * is exactly what the store keeps in clear, so it matches the read-back
   * without needing one. Audited with REDACTED views on both sides: the trail
   * records that the directory changed and who changed it, never a credential.
   */
  private async saveAudited<T extends object>(
    kind: Extract<SettingKind, 'auth.ldap' | 'auth.oidc'>,
    config: T,
    secretFields: readonly string[],
    fromEnv: () => T | null,
    request: AuthenticatedRequest,
  ): Promise<void> {
    const actor = request.principal;
    const before = await this.store.describe<T>(kind, fromEnv);
    const after = redacted(config, secretFields);

    await this.prisma.$transaction(async (tx) => {
      await this.store.save(
        kind,
        config as unknown as Record<string, unknown>,
        secretFields,
        actor?.email ?? 'unknown',
        tx,
      );

      await this.audit.record(
        {
          actorUserId: actor?.userId ?? null,
          actorEmail: actor?.email ?? null,
          action: `settings.${kind}.update`,
          entityType: 'ProviderSetting',
          entityId: kind,
          before: before.config,
          after,
          ipAddress: request.ip ?? null,
          userAgent: headerOf(request, 'user-agent'),
        },
        tx,
      );
    });
  }

  /**
   * Discard a stored configuration with its audit record, in one transaction.
   *
   * Safe to wrap because `before` was read above and `after` is fixed —
   * nothing re-reads the row inside the transaction.
   */
  private async clearAudited<T>(
    kind: Extract<SettingKind, 'auth.ldap' | 'auth.oidc'>,
    fromEnv: () => T | null,
    request: AuthenticatedRequest,
  ): Promise<void> {
    const actor = request.principal;
    const before = await this.store.describe<T>(kind, fromEnv);

    await this.prisma.$transaction(async (tx) => {
      await this.store.clear(kind, tx);

      await this.audit.record(
        {
          actorUserId: actor?.userId ?? null,
          actorEmail: actor?.email ?? null,
          action: `settings.${kind}.clear`,
          entityType: 'ProviderSetting',
          entityId: kind,
          before: before.config,
          after: null,
          ipAddress: request.ip ?? null,
          userAgent: headerOf(request, 'user-agent'),
        },
        tx,
      );
    });
  }

  /**
   * Refuse to save a secret this deployment cannot encrypt — and say how to
   * fix it, in terms of the thing the operator typed (ADR-0029 §6).
   *
   * The store refuses as well; this exists for the MESSAGE. "This
   * configuration holds a secret" was accurate and left an operator who had
   * just typed a bind password to work out which secret, and what to run.
   */
  private requireKeyFor(secret: string | undefined, what: string): void {
    if (secret === undefined || secret === '' || this.store.canStoreSecrets) return;
    throw new SettingsStoreError(
      `Saving ${what} needs CONFIG_ENCRYPTION_KEY. Re-run scripts/deploy.sh, which generates ` +
        'it, or set it in .env (openssl rand -base64 32) and restart.',
    );
  }

  /**
   * The pasted CA must parse, must not be a private key, and must not sit
   * beside disabled verification, where it would be silently ignored — the
   * same rule `LDAP_CA_PATH` has at boot.
   */
  private validateCa(config: LdapSettings): void {
    const problem = caProblem(config);
    if (problem !== null) throw new BadRequestException({ error: 'INVALID_CA', message: problem });
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

/** What is wrong with a configuration's pasted CA, or null when nothing is. */
function caProblem(config: LdapSettings): string | null {
  if (config.caPem === undefined) return null;

  try {
    parseCaPem(config.caPem);
  } catch (error) {
    return error instanceof CaPemError ? error.message : describe(error);
  }

  if (!config.tlsRejectUnauthorized) {
    return (
      'A CA certificate is set but TLS verification is off, so the CA would be ignored and any ' +
      'certificate accepted. Turn verification on, or remove the CA.'
    );
  }
  return null;
}

/** The configuration as the store keeps it in clear: secrets removed. */
function redacted(config: object, secretFields: readonly string[]): Record<string, unknown> {
  // Through JSON so `undefined` members vanish exactly as they do on the way
  // into the database, and the audit row matches what a read-back would show.
  const plain = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  for (const field of secretFields) delete plain[field];
  return plain;
}

function headerOf(request: AuthenticatedRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value.slice(0, 500) : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
