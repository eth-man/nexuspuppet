'use client';

import { AuditForwardingPanel } from '@/components/data/audit-forwarding-panel';
import { SettingsGuard } from '@/components/settings-guard';

/**
 * Audit forwarding to a collector (ADR-0016 §5).
 *
 * Audit records only. Notification delivery moved to the Notifications tab,
 * which is where somebody looking for "where do alerts go" reads first — and
 * keeping the two apart is also the clearest way to state that they are
 * different things: records under `audit.export` here, conditions there.
 */
export default function IntegrationsSettingsPage() {
  return (
    <SettingsGuard permission="settings:manage" section="Integrations">
      <AuditForwardingPanel />
    </SettingsGuard>
  );
}
