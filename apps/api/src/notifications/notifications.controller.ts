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
  notificationWebhookSettingsSchema,
  type NotificationWebhookSettings,
} from '@nexuspuppet/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission, type AuthenticatedRequest } from '../auth/auth.guard';
import { SettingsStore, type ResolvedSetting } from '../settings/settings.store';
import { NotificationWebhookTransport } from './notification-webhook.transport';

/**
 * Where operational notifications go (ADR-0021 §4, §5).
 *
 * ONE global destination, not one per user. Estates already solve routing with
 * distribution lists and alert routers that are trusted at 3am, and per-user
 * subscriptions produce the bystander effect: everybody assumes somebody else
 * is subscribed, and nobody finds out until the outage.
 *
 * NOT gated on a capability. Notifications are core — an open-core product
 * whose open half cannot say it is broken is a demo. What keeps that honest is
 * the content constraint, not a licence check: these messages describe the
 * deployment's health and never name a person or an action.
 */
@RequirePermission('settings:manage')
@Controller('settings/notifications')
export class NotificationsController {
  constructor(
    private readonly store: SettingsStore,
    private readonly transport: NotificationWebhookTransport,
  ) {}

  @Get('webhook')
  async describe(): Promise<ResolvedSetting<NotificationWebhookSettings>> {
    // `describe`, not `resolve`: it reports where the configuration came from
    // and which secrets are held, without ever returning the secret itself.
    return this.store.describe<NotificationWebhookSettings>('notifications.webhook', () => null);
  }

  @Put('webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  async save(
    @Body(new ZodValidationPipe(notificationWebhookSettingsSchema))
    body: NotificationWebhookSettings,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    // Who changed it is recorded on the SETTING, which is a configuration
    // audit and not notification content — the §1 boundary is about what
    // leaves in a message, not about who may configure the destination.
    await this.store.save(
      'notifications.webhook',
      body,
      ['token'],
      request.principal?.email ?? 'unknown',
    );
  }

  @Delete('webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clear(): Promise<void> {
    await this.store.clear('notifications.webhook');
  }

  /**
   * Send a real notification to the configured endpoint.
   *
   * Test-before-save, as the audit transports already offer. A destination
   * that is only exercised when something is already wrong is a destination
   * nobody trusts — and the first real delivery must not be the first proof
   * the URL was even correct.
   */
  @Post('webhook/test')
  @HttpCode(HttpStatus.OK)
  async test(
    @Body(new ZodValidationPipe(notificationWebhookSettingsSchema))
    body: NotificationWebhookSettings,
  ): Promise<{ ok: boolean; error: string | null }> {
    return this.transport.deliver(body, {
      transition: 'resolved',
      key: 'test.notification',
      kind: 'test.notification',
      severity: 'warning',
      summary: 'Test notification from NexusPuppet. Nothing is wrong.',
      at: new Date().toISOString(),
    });
  }
}
