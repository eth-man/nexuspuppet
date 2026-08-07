'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { NotificationEmailSettings } from '@nexuspuppet/contracts';
import { useNotificationEmail } from '@/lib/queries';
import {
  useClearNotificationEmail,
  useSaveNotificationEmail,
  useTestNotificationEmail,
} from '@/lib/mutations';
import { ApiError } from '@/lib/client';
import { useAuth } from '@/providers/auth-provider';
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
import { Select } from '@/components/ui/select';
import { LoadingRows, QueryError } from '@/components/states';

type Form = {
  host: string;
  port: string;
  encryption: NotificationEmailSettings['encryption'];
  username: string;
  from: string;
  to: string;
};

const BLANK: Form = {
  host: '',
  port: '587',
  encryption: 'starttls',
  username: '',
  from: '',
  to: '',
};

/**
 * Mail relay for operational notifications (ADR-0021 §4).
 *
 * ONE recipient — a NOC or team distribution list. Per-user subscriptions
 * produce the bystander effect: everybody assumes somebody else is subscribed,
 * and nobody finds out until the outage.
 */
export function NotificationEmailPanel() {
  const { can } = useAuth();
  const manages = can('settings:manage');

  const stored = useNotificationEmail(manages);
  const save = useSaveNotificationEmail();
  const clear = useClearNotificationEmail();
  const test = useTestNotificationEmail();

  const [form, setForm] = useState<Form>(BLANK);
  const [password, setPassword] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; error: string | null } | null>(null);

  const config = stored.data?.config ?? null;
  useEffect(() => {
    setForm(
      config === null
        ? BLANK
        : {
            host: config.host,
            port: String(config.port),
            encryption: config.encryption,
            username: config.username ?? '',
            from: config.from,
            to: config.to,
          },
    );
  }, [config]);

  if (!manages) return null;
  if (stored.isError) return <QueryError error={stored.error} />;
  if (stored.isPending) return <LoadingRows rows={3} columns={2} />;

  const port = Number(form.port);
  const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;
  const blocked = form.host === '' || form.from === '' || form.to === '' || !portValid;
  const configured = stored.data.config !== null;
  const holdsPassword = stored.data.secretsHeld.includes('password');

  const field = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setResult(null);
  };

  const submission = (): NotificationEmailSettings => ({
    host: form.host,
    port,
    encryption: form.encryption,
    from: form.from,
    to: form.to,
    rejectUnauthorized: stored.data.config?.rejectUnauthorized ?? true,
    timeoutMs: stored.data.config?.timeoutMs ?? 10_000,
    ...(form.username === '' ? {} : { username: form.username }),
    ...(password === '' ? {} : { password }),
  });

  const fail = (caught: unknown) =>
    setError(caught instanceof ApiError ? caught.message : String(caught));

  return (
    <div className="space-y-3">
      {error !== null && (
        <div role="alert" className="rounded border border-state-failed/40 bg-state-failed/10 p-2">
          <p className="text-xs text-state-failed">{error}</p>
        </div>
      )}

      <fieldset disabled={!editing} className="min-w-0">
        <Card>
          <CardHeader>
            <CardHeading>
              <CardTitle>Notification email</CardTitle>
              <CardDescription>
                Mailed when an operational condition opens and when it resolves. One team address —
                your relay routes from there.
              </CardDescription>
            </CardHeading>
          </CardHeader>

          <CardContent className="space-y-3">
            <FieldRow>
              <Field className="min-w-64 flex-[3]" required label="Relay host">
                {(id) => (
                  <Input
                    id={id}
                    value={form.host}
                    onChange={(e) => field('host', e.target.value)}
                    placeholder="smtp.example.com"
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>

              <Field className="w-28" required label="Relay port">
                {(id) => (
                  <Input
                    id={id}
                    value={form.port}
                    inputMode="numeric"
                    aria-invalid={!portValid}
                    onChange={(e) => field('port', e.target.value)}
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>

              <Field
                className="w-40"
                label="Encryption"
                hint={
                  <InfoHint
                    label="About encryption"
                    text="TLS is implicit from the first byte, normally port 465. STARTTLS upgrades a plaintext connection, normally 587. Choosing the wrong one is the most common relay misconfiguration, and only a real connection reveals it — use Send test."
                  />
                }
              >
                {(id) => (
                  <Select
                    id={id}
                    value={form.encryption}
                    onChange={(e) => field('encryption', e.target.value as Form['encryption'])}
                  >
                    <option value="starttls">STARTTLS</option>
                    <option value="tls">TLS</option>
                    <option value="none">None</option>
                  </Select>
                )}
              </Field>
            </FieldRow>

            <FieldRow>
              <Field className="min-w-52 flex-1" required label="From address">
                {(id) => (
                  <Input
                    id={id}
                    value={form.from}
                    onChange={(e) => field('from', e.target.value)}
                    placeholder="nexuspuppet@example.com"
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>

              <Field className="min-w-52 flex-1" required label="Send to">
                {(id) => (
                  <Input
                    id={id}
                    value={form.to}
                    onChange={(e) => field('to', e.target.value)}
                    placeholder="noc@example.com"
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>
            </FieldRow>

            <FieldRow>
              <Field
                className="min-w-52 flex-1"
                label="Relay username"
                hint="Optional. Many internal relays accept by network instead."
              >
                {(id) => (
                  <Input
                    id={id}
                    value={form.username}
                    onChange={(e) => field('username', e.target.value)}
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>

              <Field
                className="min-w-52 flex-1"
                label="Relay password"
                hint={holdsPassword ? 'Stored. Leave blank to keep it.' : undefined}
              >
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setResult(null);
                    }}
                    placeholder={holdsPassword ? '••••••••' : ''}
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>
            </FieldRow>
          </CardContent>
        </Card>
      </fieldset>

      {result !== null && (
        <p
          role="status"
          className={
            result.ok
              ? 'flex items-start gap-1.5 text-[11px] text-state-unchanged'
              : 'flex items-start gap-1.5 text-[11px] text-state-failed'
          }
        >
          {result.ok ? (
            <>
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {/* Precise on purpose: acceptance is not arrival, and a bounce
                  happens minutes later where this deployment cannot see it. */}
              <span>The relay accepted the message. That is not proof it arrived.</span>
            </>
          ) : (
            <>
              <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{result.error ?? 'The relay did not accept it.'}</span>
            </>
          )}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {editing ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setPassword('');
                setResult(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={blocked || test.isPending}
              onClick={() => {
                setError(null);
                test.mutate(submission(), { onSuccess: setResult, onError: fail });
              }}
            >
              Send test mail
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={blocked || save.isPending}
              onClick={() => {
                setError(null);
                save.mutate(submission(), {
                  onSuccess: () => {
                    setEditing(false);
                    setPassword('');
                  },
                  onError: fail,
                });
              }}
            >
              Save
            </Button>
          </>
        ) : (
          <>
            {configured && (
              <Button
                variant="ghost"
                size="sm"
                disabled={clear.isPending}
                onClick={() => {
                  setError(null);
                  clear.mutate(undefined, { onError: fail });
                }}
              >
                Stop mailing
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={() => setEditing(true)}>
              Edit email
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
