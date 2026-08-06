'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Pencil, XCircle } from 'lucide-react';
import type {
  AuditForwardingView,
  ProviderVerification,
  SettingsView,
  SyslogSettings,
  WebhookSettings,
} from '@nexuspuppet/contracts';
import { useAuditForwarding, useCapabilities } from '@/lib/queries';
import {
  useClearAuditTransport,
  useSaveAuditTransport,
  useSetActiveAuditTransport,
  useTestAuditTransport,
} from '@/lib/mutations';
import { ApiError } from '@/lib/client';
import { useAuth } from '@/providers/auth-provider';
import { absolute } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { CapabilityCard } from '@/components/ui/capability-card';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardHeading,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldRow } from '@/components/ui/field';
import { InfoHint } from '@/components/ui/info-hint';
import { Input } from '@/components/ui/input';
import { InsetPanel } from '@/components/ui/inset-panel';
import { PemInput } from '@/components/ui/pem-input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { LoadingRows, QueryError } from '@/components/states';

/**
 * Audit forwarding to a collector (ADR-0016 §5).
 *
 * The shape that matters: TWO stored configurations, ONE active transport, and
 * the two acts kept apart. Saving a card never changes which transport
 * delivers; "Make active" is its own explicit, audited act, and the API
 * refuses it for a transport with nothing stored. This is the same
 * look-freely-change-deliberately grammar as the directory card, applied
 * twice, with a switch between the copies.
 *
 * UDP is presented in the ADR's own words — "unconfirmable delivery" — at the
 * moment of choosing it and again while it is in force. Over UDP, "sent"
 * means the kernel accepted a datagram, not that the collector has the
 * record, and the operator deciding to accept that should read it here rather
 * than in a post-incident review.
 */
export function AuditForwardingPanel() {
  const { can } = useAuth();
  const manages = can('settings:manage');

  /*
   * Entitlement is the capability, not a licence flag. `audit.export` is
   * advertised only when a transport that can actually send is registered.
   *
   * Without it each card renders as a header alone (see CapabilityCard). This
   * used to render the whole form with every input disabled, so an open-core
   * operator could see what the enterprise layer offers — the discoverability
   * survives in the header; the screen of unfillable fields does not.
   */
  const capabilities = useCapabilities();
  const licensed = capabilities.data?.capabilities.includes('audit.export') === true;

  // Fetched in every edition — core owns the endpoint, and a disabled query
  // pends forever (learned on the directory card).
  const stored = useAuditForwarding(manages);
  const setActive = useSetActiveAuditTransport();

  const [error, setError] = useState<string | null>(null);

  if (!manages) return null;
  if (stored.isError) return <QueryError error={stored.error} />;
  if (stored.isPending) return <LoadingRows rows={4} columns={2} />;

  const view = stored.data;
  const fail = (caught: unknown) =>
    setError(caught instanceof ApiError ? caught.message : String(caught));

  return (
    <div className="space-y-4">
      <ForwardingStatus view={view} />

      {error !== null && (
        <div role="alert" className="rounded border border-state-failed/40 bg-state-failed/10 p-2">
          <p className="text-xs text-state-failed">{error}</p>
        </div>
      )}

      <SyslogCard
        view={view.syslog}
        active={view.active === 'syslog'}
        licensed={licensed}
        onError={setError}
        onMakeActive={() => {
          setError(null);
          setActive.mutate('syslog', { onError: fail });
        }}
        switching={setActive.isPending}
      />

      <WebhookCard
        view={view.webhook}
        active={view.active === 'webhook'}
        licensed={licensed}
        onError={setError}
        onMakeActive={() => {
          setError(null);
          setActive.mutate('webhook', { onError: fail });
        }}
        switching={setActive.isPending}
      />

      {licensed && view.active !== 'none' && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            disabled={setActive.isPending}
            onClick={() => {
              setError(null);
              setActive.mutate('none', { onError: fail });
            }}
          >
            Turn forwarding off
          </Button>
        </div>
      )}

      {/*
        No trailing explanation here any more. Each card carries its own now,
        and repeating it a third time under two cards that both already say it
        was the clutter this change is about.
      */}
    </div>
  );
}

/**
 * What forwarding is doing right now, before any card is read.
 *
 * The strip answers the operator's first question — "do my audit records
 * leave this box?" — and carries the unconfirmable-delivery warning while UDP
 * is the transport in force, not only at the moment it was chosen.
 */
function ForwardingStatus({ view }: { view: AuditForwardingView }) {
  const activeUdp = view.active === 'syslog' && view.syslog.config?.protocol === 'udp';

  return (
    <>
      {view.active === 'none' ? (
        <Notice tone="info">
          {'Audit forwarding is off. Records are written to this deployment’s database and '}
          {'stay there.'}
        </Notice>
      ) : (
        <Notice tone="info">
          {`Audit records forward via ${view.active}.`}{' '}
          <InfoHint
            label="How delivery works"
            text="Records queue in this deployment's database and a worker delivers them in batches. A collector outage queues records rather than losing them."
          />
        </Notice>
      )}

      {activeUdp && (
        <Notice tone="warn">
          {'UDP is in force: unconfirmable delivery. A send clears the queue without proof the '}
          {'collector received anything. This deployment cannot show its audit records arrived.'}
        </Notice>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ syslog */

interface SyslogForm {
  host: string;
  port: string;
  protocol: SyslogSettings['protocol'];
  caCert: string;
  clientCert: string;
  facility: string;
  appName: string;
  tlsRejectUnauthorized: boolean;
}

const BLANK_SYSLOG: SyslogForm = {
  host: '',
  port: '',
  protocol: 'tcp',
  caCert: '',
  clientCert: '',
  facility: '13',
  appName: 'nexuspuppet',
  tlsRejectUnauthorized: true,
};

function syslogFormFrom(config: SyslogSettings | null): SyslogForm {
  if (config === null) return BLANK_SYSLOG;
  return {
    host: config.host,
    port: String(config.port),
    protocol: config.protocol,
    caCert: config.caCert ?? '',
    clientCert: config.clientCert ?? '',
    facility: String(config.facility),
    appName: config.appName,
    tlsRejectUnauthorized: config.tlsRejectUnauthorized,
  };
}

function SyslogCard({
  view,
  active,
  licensed,
  onError,
  onMakeActive,
  switching,
}: {
  view: SettingsView<SyslogSettings>;
  active: boolean;
  licensed: boolean;
  onError: (message: string | null) => void;
  onMakeActive: () => void;
  switching: boolean;
}) {
  const save = useSaveAuditTransport();
  const clear = useClearAuditTransport();
  const test = useTestAuditTransport();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<SyslogForm>(BLANK_SYSLOG);
  /** The TLS client key. Never loaded — empty means "keep the stored one". */
  const [secret, setSecret] = useState('');
  const [result, setResult] = useState<ProviderVerification | null>(null);

  useEffect(() => {
    setForm(syslogFormFrom(view.config));
  }, [view.config]);

  const field = <K extends keyof SyslogForm>(key: K, value: SyslogForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    // An edit invalidates a previous test: the result described a
    // configuration that is no longer on screen.
    setResult(null);
  };

  const port = Number(form.port);
  const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;
  const blocked = form.host === '' || !portValid;

  const submission = (): SyslogSettings => {
    const config: SyslogSettings = {
      host: form.host,
      port,
      protocol: form.protocol,
      facility: Number(form.facility) || 13,
      appName: form.appName === '' ? 'nexuspuppet' : form.appName,
      timeoutMs: view.config?.timeoutMs ?? 10_000,
      tlsRejectUnauthorized: form.tlsRejectUnauthorized,
    };
    if (form.caCert !== '') config.caCert = form.caCert;
    if (form.clientCert !== '') config.clientCert = form.clientCert;
    if (secret !== '') config.clientKey = secret;
    return config;
  };

  const holdsKey = view.secretsHeld.includes('clientKey');
  const changes = describeSyslogChanges(view.config, form, secret !== '');
  const fail = (caught: unknown) =>
    onError(caught instanceof ApiError ? caught.message : String(caught));

  /*
   * Without the capability, the header and nothing else. Every field below is
   * unreachable — the API answers 501 whatever is typed into them — so drawing
   * a dozen greyed-out inputs only pushes the settings this deployment CAN use
   * off the screen.
   *
   * Returned before the hooks' work is used, never before the hooks themselves:
   * they all run above this line, so the order is identical in both editions.
   */
  if (!licensed) {
    return (
      <CapabilityCard
        title="Syslog"
        description="Forward audit records to a syslog collector (RFC 5424)."
        capability="audit.export"
        note="Audit records are still written and retained locally."
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Licensed past this point — the unlicensed case returned above. */}
      <fieldset disabled={!editing} className="min-w-0">
        <Card>
          <CardHeader>
            <CardHeading>
              <CardTitle>Syslog</CardTitle>
              <CardDescription>
                Forward audit records to a syslog collector (RFC 5424).
              </CardDescription>
            </CardHeading>
            <div className="flex shrink-0 items-center gap-2">
              {active && <Badge>active</Badge>}
              <Badge>{sourceLabel(view.source)}</Badge>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            <FieldRow>
              <Field className="min-w-64 flex-[3]" required label="Collector host">
                {(id) => (
                  <Input
                    id={id}
                    value={form.host}
                    onChange={(e) => field('host', e.target.value)}
                    placeholder="siem.example.com"
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>

              <Field
                className="w-28"
                required
                label="Port"
                error={form.port !== '' && !portValid ? '1–65535' : null}
              >
                {(id) => (
                  <Input
                    id={id}
                    value={form.port}
                    onChange={(e) => field('port', e.target.value)}
                    placeholder="6514"
                    inputMode="numeric"
                    className="font-mono text-[11px]"
                    aria-invalid={form.port !== '' && !portValid}
                  />
                )}
              </Field>

              <Field
                className="w-56"
                label="Transport"
                tooltip={
                  <InfoHint
                    label="About the transport"
                    text="TCP confirms delivery to the collector's socket; TLS additionally encrypts and authenticates it. UDP cannot confirm anything — a send is recorded as unconfirmed."
                  />
                }
              >
                {(id) => (
                  <Select
                    id={id}
                    value={form.protocol}
                    onChange={(e) =>
                      field('protocol', e.target.value as SyslogSettings['protocol'])
                    }
                  >
                    <option value="tcp">TCP</option>
                    <option value="tls">TLS (recommended)</option>
                    <option value="udp">UDP — unconfirmable delivery</option>
                  </Select>
                )}
              </Field>
            </FieldRow>

            {form.protocol === 'udp' && (
              <Notice tone="warn">
                {'Unconfirmable delivery: over UDP a send clears the queue without proof the '}
                {'collector received anything. Choose it only where the network makes TCP '}
                {'impossible.'}
              </Notice>
            )}

            {form.protocol === 'tls' && (
              <div className="space-y-3 border-t border-line-soft pt-3">
                <PemInput
                  label="Collector CA certificate"
                  accept=".pem,.crt,.ca"
                  value={form.caCert}
                  onChange={(next) => field('caCert', next)}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  constraints={['PEM. The authority that signs the collector’s certificate.']}
                />

                <PemInput
                  label="Client certificate (mutual TLS only)"
                  accept=".pem,.crt"
                  value={form.clientCert}
                  onChange={(next) => field('clientCert', next)}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  constraints={['PEM. Only when the collector requires client authentication.']}
                />

                <PemInput
                  label="Client key"
                  accept=".pem,.key"
                  value={secret}
                  onChange={(next) => {
                    setSecret(next);
                    setResult(null);
                  }}
                  placeholder={
                    holdsKey
                      ? '(a key is stored — leave empty to keep it)'
                      : // Prose, not a PEM marker: CI greps the tree for
                        // private-key blocks and cannot tell a placeholder
                        // from a leak — nor should it have to.
                        '(paste the key, or choose its file)'
                  }
                  constraints={[
                    'Never sent back to the browser. Empty keeps the stored key; pasting replaces it.',
                  ]}
                />

                <Switch
                  checked={form.tlsRejectUnauthorized}
                  onCheckedChange={(next) => field('tlsRejectUnauthorized', next)}
                  label={'Verify the collector’s TLS certificate'}
                  description="Turn this off only for a test collector with a self-signed certificate."
                />
              </div>
            )}

            <FieldRow className="border-t border-line-soft pt-3">
              <Field
                className="w-28"
                label="Facility"
                tooltip={
                  <InfoHint
                    label="About the facility"
                    text="RFC 5424 facility number, 0–23. The default, 13, is 'log audit' — which is what these records are."
                  />
                }
              >
                {(id) => (
                  <Input
                    id={id}
                    value={form.facility}
                    onChange={(e) => field('facility', e.target.value)}
                    inputMode="numeric"
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>

              <Field className="w-56" label="App name" hint="How records identify themselves.">
                {(id) => (
                  <Input
                    id={id}
                    value={form.appName}
                    onChange={(e) => field('appName', e.target.value)}
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>
            </FieldRow>

            <InsetPanel
              title="Test this configuration"
              description="Connects to the collector with the values above without saving them."
            >
              {result !== null && <TestResult result={result} />}
            </InsetPanel>
          </CardContent>
        </Card>
      </fieldset>

      {editing && changes.length > 0 && <PendingChanges lines={changes} />}

      {licensed && (
        <TransportActions
          editing={editing}
          active={active}
          configured={view.source === 'database'}
          busy={save.isPending || clear.isPending || test.isPending || switching}
          blocked={blocked}
          testing={test.isPending}
          saving={save.isPending}
          updatedAt={view.updatedAt}
          updatedByEmail={view.updatedByEmail}
          onEdit={() => setEditing(true)}
          onCancel={() => {
            // Back to what is stored, not to what was typed.
            setForm(syslogFormFrom(view.config));
            setSecret('');
            setResult(null);
            onError(null);
            setEditing(false);
          }}
          onTest={() => {
            onError(null);
            test.mutate(
              { kind: 'syslog', config: submission() },
              { onSuccess: setResult, onError: fail },
            );
          }}
          onSave={() => {
            onError(null);
            save.mutate(
              { kind: 'syslog', config: submission() },
              {
                onSuccess: () => {
                  setSecret('');
                  setEditing(false);
                },
                onError: fail,
              },
            );
          }}
          onMakeActive={onMakeActive}
          onDiscard={
            view.source === 'database' && !active
              ? () => {
                  onError(null);
                  clear.mutate('syslog', { onError: fail });
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- webhook */

function WebhookCard({
  view,
  active,
  licensed,
  onError,
  onMakeActive,
  switching,
}: {
  view: SettingsView<WebhookSettings>;
  active: boolean;
  licensed: boolean;
  onError: (message: string | null) => void;
  onMakeActive: () => void;
  switching: boolean;
}) {
  const save = useSaveAuditTransport();
  const clear = useClearAuditTransport();
  const test = useTestAuditTransport();

  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  /** The bearer token. Never loaded — empty means "keep the stored one". */
  const [secret, setSecret] = useState('');
  const [result, setResult] = useState<ProviderVerification | null>(null);

  useEffect(() => {
    setUrl(view.config?.url ?? '');
  }, [view.config]);

  const urlValid =
    /^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(url);
  const blocked = url === '' || !urlValid;

  const submission = (): WebhookSettings => {
    const config: WebhookSettings = { url, timeoutMs: view.config?.timeoutMs ?? 10_000 };
    if (secret !== '') config.token = secret;
    return config;
  };

  const holdsToken = view.secretsHeld.includes('token');
  const changes = describeWebhookChanges(view.config, url, secret !== '');
  const fail = (caught: unknown) =>
    onError(caught instanceof ApiError ? caught.message : String(caught));

  // See SyslogCard: header only, no unreachable form.
  if (!licensed) {
    return (
      <CapabilityCard
        title="Webhook"
        description="POST audit records to an HTTP endpoint."
        capability="audit.export"
        note="Audit records are still written and retained locally."
      />
    );
  }

  return (
    <div className="space-y-3">
      <fieldset disabled={!editing} className="min-w-0">
        <Card>
          <CardHeader>
            <CardHeading>
              <CardTitle>Webhook</CardTitle>
              <CardDescription>
                POST batches of audit records to an HTTPS endpoint. Any 2xx confirms delivery.
              </CardDescription>
            </CardHeading>
            <div className="flex shrink-0 items-center gap-2">
              {active && <Badge>active</Badge>}
              <Badge>{sourceLabel(view.source)}</Badge>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            <FieldRow>
              <Field
                className="min-w-64 flex-[3]"
                required
                label="Endpoint URL"
                error={url !== '' && !urlValid ? 'https://, or http:// to localhost only' : null}
                tooltip={
                  <InfoHint
                    label="About the endpoint"
                    text="Audit records do not travel a network in clear: https://, or http:// to localhost only."
                  />
                }
              >
                {(id) => (
                  <Input
                    id={id}
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setResult(null);
                    }}
                    placeholder="https://collector.example.com/ingest"
                    className="font-mono text-[11px]"
                    aria-invalid={url !== '' && !urlValid}
                  />
                )}
              </Field>

              <Field
                className="min-w-64 flex-1"
                hint={holdsToken ? 'A token is stored. Leave blank to keep it.' : undefined}
                label="Bearer token"
                tooltip={
                  <InfoHint
                    label="About the token"
                    text="Never sent back to the browser, so this field is empty even when one is stored. Leaving it blank keeps the existing value; typing replaces it."
                  />
                }
              >
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={secret}
                    onChange={(e) => {
                      setSecret(e.target.value);
                      setResult(null);
                    }}
                    placeholder={holdsToken ? '•••••••• (unchanged)' : ''}
                  />
                )}
              </Field>
            </FieldRow>

            <InsetPanel
              title="Test this configuration"
              description="Sends a test request to the endpoint without saving anything."
            >
              {result !== null && <TestResult result={result} />}
            </InsetPanel>
          </CardContent>
        </Card>
      </fieldset>

      {editing && changes.length > 0 && <PendingChanges lines={changes} />}

      {licensed && (
        <TransportActions
          editing={editing}
          active={active}
          configured={view.source === 'database'}
          busy={save.isPending || clear.isPending || test.isPending || switching}
          blocked={blocked}
          testing={test.isPending}
          saving={save.isPending}
          updatedAt={view.updatedAt}
          updatedByEmail={view.updatedByEmail}
          onEdit={() => setEditing(true)}
          onCancel={() => {
            setUrl(view.config?.url ?? '');
            setSecret('');
            setResult(null);
            onError(null);
            setEditing(false);
          }}
          onTest={() => {
            onError(null);
            test.mutate(
              { kind: 'webhook', config: submission() },
              { onSuccess: setResult, onError: fail },
            );
          }}
          onSave={() => {
            onError(null);
            save.mutate(
              { kind: 'webhook', config: submission() },
              {
                onSuccess: () => {
                  setSecret('');
                  setEditing(false);
                },
                onError: fail,
              },
            );
          }}
          onMakeActive={onMakeActive}
          onDiscard={
            view.source === 'database' && !active
              ? () => {
                  onError(null);
                  clear.mutate('webhook', { onError: fail });
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ shared */

/**
 * One action bar per card, outside its fieldset (a fieldset disables the Edit
 * button that would end its own disablement — learned on the directory card).
 *
 * "Make active" sits with the read-state actions: switching is not an edit of
 * the configuration, it is a decision about which stored configuration
 * delivers, and it stays available without unlocking anything.
 */
function TransportActions({
  editing,
  active,
  configured,
  busy,
  blocked,
  testing,
  saving,
  updatedAt,
  updatedByEmail,
  onEdit,
  onCancel,
  onTest,
  onSave,
  onMakeActive,
  onDiscard,
}: {
  editing: boolean;
  active: boolean;
  configured: boolean;
  busy: boolean;
  blocked: boolean;
  testing: boolean;
  saving: boolean;
  updatedAt: string | null;
  updatedByEmail: string | null;
  onEdit: () => void;
  onCancel: () => void;
  onTest: () => void;
  onSave: () => void;
  onMakeActive: () => void;
  onDiscard?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-line-soft bg-panel-raised px-3 py-2">
      {updatedAt !== null && (
        <span className="text-[11px] text-ink-faint">
          Last changed {absolute(updatedAt)}
          {updatedByEmail !== null && ` by ${updatedByEmail}`}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {!editing ? (
          <>
            {onDiscard !== undefined && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={onDiscard}>
                Discard stored settings
              </Button>
            )}
            {/* Test stays available while locked — checking the collector is
                reachable must not require unlocking the configuration. */}
            <Button variant="outline" size="sm" disabled={busy || blocked} onClick={onTest}>
              {testing ? 'Testing…' : 'Test'}
            </Button>
            {configured && !active && (
              <Button variant="outline" size="sm" disabled={busy} onClick={onMakeActive}>
                Make active
              </Button>
            )}
            <Button variant="primary" size="sm" disabled={busy} onClick={onEdit}>
              <Pencil className="mr-1 size-3.5" aria-hidden />
              Edit settings
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="outline" size="sm" disabled={busy || blocked} onClick={onTest}>
              {testing ? 'Testing…' : 'Test'}
            </Button>
            <Button variant="primary" size="sm" disabled={busy || blocked} onClick={onSave}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What Save is about to change, against what is stored — the delta the
 * operator is accountable for, not the resulting form (ADR-0016 §7).
 */
function PendingChanges({ lines }: { lines: string[] }) {
  return (
    <div className="rounded border border-accent/40 bg-accent/10 px-2.5 py-2">
      <p className="text-[11px] font-semibold text-ink">Pending changes</p>
      <ul className="mt-1 space-y-0.5">
        {lines.map((line) => (
          <li key={line} className="text-[11px] text-ink-muted">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

function describeSyslogChanges(
  before: SyslogSettings | null,
  form: SyslogForm,
  keyPasted: boolean,
): string[] {
  if (before === null) return ['This will store a syslog configuration for the first time.'];

  const lines: string[] = [];
  const changed = (label: string, a: string, b: string) => {
    if (a !== b) lines.push(`${label}: ${a || '(none)'} → ${b || '(none)'}`);
  };

  changed('Collector host', before.host, form.host);
  changed('Port', String(before.port), form.port);
  if (before.protocol !== form.protocol) {
    lines.push(
      form.protocol === 'udp'
        ? `Transport: ${before.protocol} → UDP — delivery becomes unconfirmable`
        : `Transport: ${before.protocol} → ${form.protocol}`,
    );
  }
  changed('Facility', String(before.facility), form.facility);
  changed('App name', before.appName, form.appName);

  const pem = (label: string, a: string | undefined, b: string) => {
    if ((a ?? '') === b) return;
    if ((a ?? '') === '') lines.push(`${label}: added`);
    else if (b === '') lines.push(`${label}: removed`);
    else lines.push(`${label}: replaced`);
  };
  pem('Collector CA certificate', before.caCert, form.caCert);
  pem('Client certificate', before.clientCert, form.clientCert);

  if (before.tlsRejectUnauthorized !== form.tlsRejectUnauthorized) {
    lines.push(
      form.tlsRejectUnauthorized
        ? 'TLS verification: off → on'
        : 'TLS verification: on → OFF — anything on the path can pose as the collector',
    );
  }

  if (keyPasted) lines.push('Client key: replaced');

  return lines;
}

function describeWebhookChanges(
  before: WebhookSettings | null,
  url: string,
  tokenTyped: boolean,
): string[] {
  if (before === null) return ['This will store a webhook configuration for the first time.'];

  const lines: string[] = [];
  if (before.url !== url)
    lines.push(`Endpoint URL: ${before.url || '(none)'} → ${url || '(none)'}`);
  if (tokenTyped) lines.push('Bearer token: replaced');
  return lines;
}

function Notice({ tone, children }: { tone: 'info' | 'warn'; children: React.ReactNode }) {
  const warn = tone === 'warn';
  return (
    <div
      className={
        warn
          ? 'flex items-start gap-2 rounded border border-state-pending/40 bg-state-pending/10 px-2.5 py-2'
          : 'flex items-start gap-2 rounded border border-line-soft bg-panel-raised px-2.5 py-2'
      }
    >
      {warn ? (
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-state-pending" aria-hidden />
      ) : (
        <Info className="mt-px size-3.5 shrink-0 text-ink-faint" aria-hidden />
      )}
      <p className={warn ? 'text-[11px] text-state-pending' : 'text-[11px] text-ink-muted'}>
        {children}
      </p>
    </div>
  );
}

/** What the transport said. Rendered verbatim — the transport decides what is safe to show. */
function TestResult({ result }: { result: ProviderVerification }) {
  return (
    <div
      role="status"
      className={
        result.ok
          ? 'rounded border border-state-unchanged/40 bg-state-unchanged/10 p-2'
          : 'rounded border border-state-failed/40 bg-state-failed/10 p-2'
      }
    >
      <div className="flex items-start gap-2">
        {result.ok ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-state-unchanged" aria-hidden />
        ) : (
          <XCircle className="mt-0.5 size-4 shrink-0 text-state-failed" aria-hidden />
        )}
        <div className="min-w-0">
          <p className={result.ok ? 'text-xs text-state-unchanged' : 'text-xs text-state-failed'}>
            {result.message}
          </p>
          {result.details !== undefined && result.details.length > 0 && (
            <dl className="mt-1 space-y-0.5">
              {result.details.map((detail) => (
                <div key={detail.label} className="flex gap-2 text-[11px]">
                  <dt className="text-ink-faint">{detail.label}</dt>
                  <dd className="min-w-0 truncate font-mono text-ink-muted">{detail.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}

function sourceLabel(source: 'database' | 'environment' | 'unset'): string {
  if (source === 'database') return 'stored here';
  if (source === 'environment') return 'from the environment';
  return 'not configured';
}
