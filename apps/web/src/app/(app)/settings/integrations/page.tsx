'use client';

import { AuditForwardingPanel } from '@/components/data/audit-forwarding-panel';
import { NotificationWebhookPanel } from '@/components/data/notification-webhook-panel';
import { SettingsGuard } from '@/components/settings-guard';

/** Audit forwarding to a collector (ADR-0016 §5). */
export default function IntegrationsSettingsPage() {
  return (
    <SettingsGuard permission="settings:manage" section="Integrations">
      <div className="space-y-4">
        <AuditForwardingPanel />
        {/*
          Below audit forwarding, and separate from it. Two destinations that
          look similar and are not: that one carries audit records under
          `audit.export`, this one carries conditions and is core (ADR-0021).
        */}
        <NotificationWebhookPanel />
      </div>
    </SettingsGuard>
  );
}
