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
  type LdapSettings,
  type ProviderVerification,
  type SettingsView,
  ldapSettingsSchema,
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
   * The stored LDAP configuration, without its secrets.
   *
   * Answers even when nothing is configured — `source: 'unset'` — so the
   * console renders an empty form rather than handling an error.
   */
  @Get('auth/ldap')
  async readLdap(): Promise<SettingsView<LdapSettings>> {
    return this.settings.describeLdap();
  }

  /**
   * Replace the stored LDAP configuration.
   *
   * A body without `bindPassword` KEEPS the stored one. The console never
   * receives the password, so it cannot send it back, and treating its absence
   * as "clear it" would wipe the credential every time somebody corrected a
   * search base.
   */
  @Put('auth/ldap')
  async writeLdap(
    @Body(new ZodValidationPipe(ldapSettingsSchema)) body: LdapSettings,
    @Req() request: AuthenticatedRequest,
  ): Promise<SettingsView<LdapSettings>> {
    return this.settings.saveLdap(body, request);
  }

  /**
   * Discard the stored configuration and fall back to the environment.
   *
   * Distinct from disabling: this removes the row, so whatever the environment
   * says becomes authoritative again.
   */
  @Delete('auth/ldap')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearLdap(@Req() request: AuthenticatedRequest): Promise<void> {
    await this.settings.clearLdap(request);
  }

  /**
   * Try a candidate configuration without saving it.
   *
   * The reason this endpoint exists: configuring a directory by trial and error
   * against the login screen is how people lock themselves out. Testing first
   * costs one bind.
   *
   * Core cannot do the work — the LDAP client lives in the enterprise layer,
   * which core may not import (ADR-0002) — so it asks the registered provider
   * through `verifyConfiguration`. When no provider can answer, that is
   * reported plainly rather than pretended to succeed.
   */
  @Post('auth/ldap/test')
  @HttpCode(HttpStatus.OK)
  async testLdap(
    @Body(new ZodValidationPipe(ldapSettingsSchema)) body: LdapSettings,
  ): Promise<ProviderVerification> {
    return this.settings.verifyLdap(body, this.resolver);
  }
}
