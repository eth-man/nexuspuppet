'use client';

import { AuditForwardingPanel } from '@/components/data/audit-forwarding-panel';
import { SettingsGuard } from '@/components/settings-guard';

/** Audit forwarding to a collector (ADR-0016 §5). */
export default function IntegrationsSettingsPage() {
  return (
    <SettingsGuard permission="settings:manage" section="Integrations">
      <AuditForwardingPanel />
    </SettingsGuard>
  );
}
