'use client';

import { NotificationEmailPanel } from '@/components/data/notification-email-panel';
import { NotificationWebhookPanel } from '@/components/data/notification-webhook-panel';
import { SettingsGuard } from '@/components/settings-guard';

/**
 * Where operational conditions are routed (ADR-0021).
 *
 * These panels used to sit under Integrations while this tab said the product
 * raised no notifications at all — copy written before ADR-0021 and left
 * standing after it shipped. So the one tab named after the feature was the one
 * place that denied it existed, next to a dashboard reporting open conditions.
 *
 * Audit forwarding stays on Integrations, deliberately. The two destinations
 * look alike and are not: that one carries audit RECORDS and is gated on
 * `audit.export`, this one carries CONDITIONS and is core. Splitting them
 * across tabs makes that boundary structural rather than a comment somebody has
 * to notice.
 */
export default function NotificationsSettingsPage() {
  return (
    <SettingsGuard permission="settings:manage" section="Notifications">
      <div className="space-y-4">
        <NotificationWebhookPanel />
        <NotificationEmailPanel />
      </div>
    </SettingsGuard>
  );
}
