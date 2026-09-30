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
  UseFilters,
} from '@nestjs/common';
import {
  auditForwardingSelectionSchema,
  syslogSettingsSchema,
  webhookSettingsSchema,
  type AuditForwardingSelection,
  type AuditForwardingView,
  type ProviderVerification,
  type SyslogSettings,
  type WebhookSettings,
} from '@nexuspuppet/contracts';
import { RequirePermission, type AuthenticatedRequest } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuditForwardingService } from './audit-forwarding.service';
import { SettingsErrorFilter } from './settings-error.filter';

/**
 * Audit forwarding configuration (ADR-0016 §5).
 *
 * Every deployment can forward (ADR-0027). Until then, writes answered 501
 * without the `audit.export` capability; that gate is gone.
 */
@RequirePermission('settings:manage')
@UseFilters(SettingsErrorFilter)
@Controller('settings/audit')
export class AuditForwardingController {
  constructor(private readonly forwarding: AuditForwardingService) {}

  /**
   * Both transport configurations and which one is active, without secrets.
   * Answers even when nothing is configured, so the console renders empty
   * cards rather than handling an error.
   */
  @Get('forwarding')
  async read(): Promise<AuditForwardingView> {
    return this.forwarding.describe();
  }

  /**
   * Switch the active transport. Refused with 409 when the target has no
   * stored configuration — activating nothing is not a state.
   */
  @Put('forwarding')
  async setActive(
    @Body(new ZodValidationPipe(auditForwardingSelectionSchema)) body: AuditForwardingSelection,
    @Req() request: AuthenticatedRequest,
  ): Promise<AuditForwardingView> {
    return this.forwarding.setActive(body.active, request);
  }

  /**
   * Replace the stored syslog configuration. A body without `clientKey` KEEPS
   * the stored one. Saving never changes which transport is active.
   */
  @Put('syslog')
  async writeSyslog(
    @Body(new ZodValidationPipe(syslogSettingsSchema)) body: SyslogSettings,
    @Req() request: AuthenticatedRequest,
  ): Promise<AuditForwardingView> {
    return this.forwarding.save('syslog', body, request);
  }

  /** Discard the stored syslog configuration. Refused while it is active. */
  @Delete('syslog')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearSyslog(@Req() request: AuthenticatedRequest): Promise<void> {
    await this.forwarding.clear('syslog', request);
  }

  /**
   * Try a candidate syslog configuration without saving it. Available while
   * the card is locked — checking whether the collector is reachable must not
   * require unlocking the configuration (ADR-0016 §7).
   */
  @Post('syslog/test')
  @HttpCode(HttpStatus.OK)
  async testSyslog(
    @Body(new ZodValidationPipe(syslogSettingsSchema)) body: SyslogSettings,
  ): Promise<ProviderVerification> {
    return this.forwarding.verify('syslog', body);
  }

  /**
   * Replace the stored webhook configuration. A body without `token` KEEPS the
   * stored one. Saving never changes which transport is active.
   */
  @Put('webhook')
  async writeWebhook(
    @Body(new ZodValidationPipe(webhookSettingsSchema)) body: WebhookSettings,
    @Req() request: AuthenticatedRequest,
  ): Promise<AuditForwardingView> {
    return this.forwarding.save('webhook', body, request);
  }

  /** Discard the stored webhook configuration. Refused while it is active. */
  @Delete('webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearWebhook(@Req() request: AuthenticatedRequest): Promise<void> {
    await this.forwarding.clear('webhook', request);
  }

  /** Try a candidate webhook configuration without saving it. */
  @Post('webhook/test')
  @HttpCode(HttpStatus.OK)
  async testWebhook(
    @Body(new ZodValidationPipe(webhookSettingsSchema)) body: WebhookSettings,
  ): Promise<ProviderVerification> {
    return this.forwarding.verify('webhook', body);
  }
}
