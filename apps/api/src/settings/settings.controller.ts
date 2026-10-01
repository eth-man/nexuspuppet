import { UseFilters } from '@nestjs/common';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  type DirectorySettingsView,
  type LdapSettings,
  type LdapSettingsView,
  type OidcSettings,
  type ProviderVerification,
  ldapSettingsSchema,
  oidcSettingsSchema,
} from '@nexuspuppet/contracts';
import { RequirePermission, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuthProviderResolver } from '../auth/auth-provider.resolver';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SettingsService } from './settings.service';
import { SettingsErrorFilter } from './settings-error.filter';

/**
 * Configuration an operator changes from the console (ADR-0016).
 *
 * Everything here requires `settings:manage`. These routes decide which
 * directory authenticates the estate's administrators, so read access is not
 * the same as read access to the inventory — a VIEWER who could read this would
 * learn the deployment's directory topology and service account DN.
 */
@RequirePermission('settings:manage')
@UseFilters(SettingsErrorFilter)
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly resolver: AuthProviderResolver,
  ) {}

  /**
   * The LDAP configuration in force, without its secrets, with any pasted CA
   * certificates parsed for the operator to check.
   *
   * Answers even when nothing is configured — `source: 'unset'` — so the
   * console renders an empty form rather than handling an error.
   */
  @Get('auth/ldap')
  async readLdap(): Promise<LdapSettingsView> {
    return this.settings.describeLdap();
  }

  /**
   * Replace the stored LDAP configuration.
   *
   * A body without `bindPassword` KEEPS the stored one. The console never
   * receives the password, so it cannot send it back, and treating its absence
   * as "clear it" would wipe the credential every time somebody corrected a
   * search base.
   *
   * Takes effect at the next sign-in, on any deployment — this is how a
   * directory is ENABLED, not only edited (ADR-0029).
   */
  @Put('auth/ldap')
  async writeLdap(
    @Body(new ZodValidationPipe(ldapSettingsSchema)) body: LdapSettings,
    @Req() request: AuthenticatedRequest,
  ): Promise<LdapSettingsView> {
    return this.settings.saveLdap(body, request);
  }

  /**
   * Discard the stored configuration and fall back to the environment.
   *
   * Distinct from disabling: this removes the row, so whatever the environment
   * says becomes authoritative again — and with nothing in the environment the
   * directory goes dormant and its accounts are refused (ADR-0029).
   */
  @Delete('auth/ldap')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearLdap(@Req() request: AuthenticatedRequest): Promise<void> {
    await this.settings.clearLdap(request);
  }

  /**
   * The OIDC configuration in force, without secrets.
   *
   * Answers even when OIDC is not configured — `source: 'unset'` — so the
   * console renders an empty form rather than handling an error.
   */
  @Get('auth/oidc')
  async readOidc(): Promise<DirectorySettingsView<OidcSettings>> {
    return this.settings.describeOidc();
  }

  /**
   * Replace the stored OIDC configuration.
   *
   * A body without `clientSecret` KEEPS the stored one. The console never
   * receives the secret, so it cannot send it back, and treating its absence as
   * "clear it" would strip the credential whenever somebody corrected a claim.
   */
  @Put('auth/oidc')
  async writeOidc(
    @Body(new ZodValidationPipe(oidcSettingsSchema)) body: OidcSettings,
    @Req() request: AuthenticatedRequest,
  ): Promise<DirectorySettingsView<OidcSettings>> {
    return this.settings.saveOidc(body, request);
  }

  /**
   * Discard the stored configuration and fall back to the environment.
   *
   * Distinct from turning SSO off: this removes the row, so whatever the
   * environment says becomes authoritative again — which is the recovery path
   * when a saved configuration turns out to be wrong. With nothing in the
   * environment, SSO goes dormant and leaves the login page (ADR-0029).
   */
  @Delete('auth/oidc')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearOidc(@Req() request: AuthenticatedRequest): Promise<void> {
    await this.settings.clearOidc(request);
  }

  /**
   * Check a configuration against the identity provider.
   *
   * An empty body checks what is in force; a candidate checks what would be
   * saved. Bounded on purpose, and the UI must not overstate it: a login
   * happens in a browser at another origin, so this establishes that the
   * issuer answers, that its discovery document describes the issuer asked
   * for rather than a substituted one, and that its signing keys parse.
   */
  @Post('auth/oidc/test')
  @HttpCode(HttpStatus.OK)
  async testOidc(
    @Body(new ZodValidationPipe(oidcSettingsSchema.optional())) body: OidcSettings | undefined,
  ): Promise<ProviderVerification> {
    return this.settings.verifyOidc(this.resolver, body);
  }

  /**
   * Try a candidate configuration without saving it.
   *
   * The reason this endpoint exists: configuring a directory by trial and error
   * against the login screen is how people lock themselves out. Testing first
   * costs one bind. The provider is always registered (ADR-0029), so this works
   * before anything has ever been saved.
   */
  @Post('auth/ldap/test')
  @HttpCode(HttpStatus.OK)
  async testLdap(
    @Body(new ZodValidationPipe(ldapSettingsSchema)) body: LdapSettings,
  ): Promise<ProviderVerification> {
    return this.settings.verifyLdap(body, this.resolver);
  }
}
