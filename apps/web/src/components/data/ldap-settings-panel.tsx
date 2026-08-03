'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, Trash2, XCircle } from 'lucide-react';
import type { LdapSettings, ProviderVerification } from '@nexuspuppet/contracts';
import { useLdapSettings, useRoles } from '@/lib/queries';
import { useClearLdapSettings, useSaveLdapSettings, useTestLdapSettings } from '@/lib/mutations';
import { ApiError } from '@/lib/client';
import { useAuth } from '@/providers/auth-provider';
import { absolute } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardHeading,
  CardTitle,
} from '@/components/ui/card';
import { InsetPanel } from '@/components/ui/inset-panel';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { LoadingRows, QueryError } from '@/components/states';

/** An empty form, for a deployment that has never configured a directory. */
const BLANK: LdapSettings = {
  url: '',
  dialect: 'openldap',
  searchBase: '',
  nestedGroups: false,
  roleMappings: [],
  timeoutMs: 10_000,
  tlsRejectUnauthorized: true,
};

/**
 * Configure the directory from the console (ADR-0016).
 *
 * Replaces a read-only panel that could only show what the environment had
 * been given. Two things about this screen are load-bearing rather than
 * decorative:
 *
 * **The bind password is never loaded.** The API does not return it, so the
 * field starts empty even when one is stored, and an empty field on save means
 * "keep it". The alternative — rendering a masked placeholder — leaks its
 * length and tempts the form into sending it back.
 *
 * **Test before Save.** Configuring a directory by trial and error against the
 * login screen is how people lock themselves out; that is not hypothetical
 * here, it is what happened on the first deployment that enabled LDAP.
 */
export function LdapSettingsPanel() {
  const { can } = useAuth();
  const manages = can('settings:manage');

  const stored = useLdapSettings(manages);
  // So a mapping naming a role nobody defined is visible here rather than at
  // somebody's next sign-in.
  const roles = useRoles(manages);
  const knownRoles = (roles.data ?? []).map((role) => role.name);
  const save = useSaveLdapSettings();
  const clear = useClearLdapSettings();
  const test = useTestLdapSettings();

  const [form, setForm] = useState<LdapSettings>(BLANK);
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<ProviderVerification | null>(null);
  const [error, setError] = useState<string | null>(null);

  const view = stored.data;

  useEffect(() => {
    // Load the server's copy once it arrives. The password is deliberately not
    // part of this — there is nothing to load, by design.
    if (view?.config !== null && view?.config !== undefined) setForm({ ...BLANK, ...view.config });
  }, [view?.config]);

  if (!manages) return null;
  if (stored.isError) return <QueryError error={stored.error} />;
  if (stored.isPending) return <LoadingRows rows={5} columns={2} />;

  const field = <K extends keyof LdapSettings>(key: K, value: LdapSettings[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    // Any edit invalidates a previous test: the result described a
    // configuration that is no longer on screen.
    setResult(null);
  };

  const submission = (): LdapSettings =>
    password === '' ? form : { ...form, bindPassword: password };

  const fail = (caught: unknown) =>
    setError(caught instanceof ApiError ? caught.message : String(caught));

  const holdsPassword = view?.secretsHeld.includes('bindPassword') === true;

  /**
   * The form is populated from the environment, which supplies a bind DN but
   * never its password — that value stays in the running provider.
   *
   * So the fields describe an account whose password this screen does not have
   * and cannot carry forward. Saving would store a configuration that binds
   * anonymously, and the first person to notice would be whoever could no longer
   * log in. Blocking Save until the password is retyped is the only honest
   * option: the alternative is a form that looks complete and is not.
   */
  const needsPasswordToAdopt =
    view?.source === 'environment' &&
    (form.bindDn ?? '') !== '' &&
    !holdsPassword &&
    password === '';

  return (
    <Card>
      <CardHeader>
        <CardHeading>
          <CardTitle>Directory (LDAP)</CardTitle>
          <CardDescription>
            Where the console looks people up, and which groups map to which role.
          </CardDescription>
        </CardHeading>
        <div className="flex items-center gap-2">
          <Badge>{sourceLabel(view?.source ?? 'unset', view?.liveReload === true)}</Badge>
          {view?.disabled === true && <Badge>disabled</Badge>}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {(view?.source === 'environment' || (view?.source === 'unset' && view.liveReload)) && (
          <Notice tone="info">
            {'This deployment is configured from its environment. Saving here stores a '}
            {'configuration in the database, which then takes precedence — the environment '}
            {'stays as it is and is used again only if you clear this.'}
          </Notice>
        )}

        {view?.liveReload === false && (
          <Notice tone="warn">
            {'No directory provider is running, so changes saved here will NOT take effect '}
            {'until the API restarts. Registration happens at boot. Set LDAP_URL in the '}
            {'environment and restart once; after that, this screen is enough.'}
          </Notice>
        )}

        {error !== null && (
          <div
            role="alert"
            className="rounded border border-state-failed/40 bg-state-failed/10 p-2"
          >
            <p className="text-xs text-state-failed">{error}</p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Server URL"
            hint="ldaps:// is strongly preferred; ldap:// sends the bind password in clear."
          >
            {(id) => (
              <Input
                value={form.url}
                onChange={(e) => field('url', e.target.value)}
                id={id}
                placeholder="ldaps://directory.example.com:636"
                aria-invalid={form.url !== '' && !/^ldaps?:\/\//i.test(form.url)}
              />
            )}
          </Field>

          <Field label="Directory type">
            {(id) => (
              <Select
                id={id}
                value={form.dialect}
                onChange={(e) => field('dialect', e.target.value as LdapSettings['dialect'])}
              >
                <option value="openldap">OpenLDAP</option>
                <option value="ad">Active Directory</option>
              </Select>
            )}
          </Field>

          <Field label="Bind DN" hint="The service account that searches the directory.">
            {(id) => (
              <Input
                value={form.bindDn ?? ''}
                onChange={(e) => field('bindDn', e.target.value || undefined)}
                id={id}
                placeholder="cn=svc-nexuspuppet,dc=example,dc=com"
              />
            )}
          </Field>

          <Field
            label="Bind password"
            hint={
              needsPasswordToAdopt
                ? 'Required. These settings come from the environment, which does not share the ' +
                  'password with this screen — retype it to save them here.'
                : holdsPassword
                  ? 'A password is stored. Leave blank to keep it; type to replace it.'
                  : 'Stored encrypted. Never shown again once saved.'
            }
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
                placeholder={holdsPassword ? '••••••••  (unchanged)' : ''}
                autoComplete="new-password"
              />
            )}
          </Field>

          <Field label="Search base" hint="Where users are looked up.">
            {(id) => (
              <Input
                value={form.searchBase}
                onChange={(e) => field('searchBase', e.target.value)}
                id={id}
                placeholder="ou=people,dc=example,dc=com"
              />
            )}
          </Field>

          <Field label="Group search base" hint="Defaults to the search base when blank.">
            {(id) => (
              <Input
                value={form.groupSearchBase ?? ''}
                onChange={(e) => field('groupSearchBase', e.target.value || undefined)}
                id={id}
                placeholder="ou=groups,dc=example,dc=com"
              />
            )}
          </Field>
        </div>

        <RoleMappings
          mappings={form.roleMappings}
          onChange={(roleMappings) => field('roleMappings', roleMappings)}
          knownRoles={knownRoles}
        />

        {form.tlsRejectUnauthorized === false && (
          <Notice tone="warn">
            {'Certificate verification is off. Anything on the network path can present itself '}
            {'as your directory and collect the bind password. Acceptable for a test directory, '}
            {'never for one that authenticates administrators.'}
          </Notice>
        )}

        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={form.tlsRejectUnauthorized}
            onChange={(e) => field('tlsRejectUnauthorized', e.target.checked)}
          />
          Verify the directory&rsquo;s TLS certificate
        </label>

        {/*
          Testing lives in its own panel, not in the save row.
          
          Next to Save it read as half of one decision, and the two are not
          alike: this one binds to the directory and writes nothing, and an
          operator who saw a green result beside a Save button could reasonably
          believe the settings were stored.
        */}
        <InsetPanel
          title="Test this configuration"
          description="Binds with the values above without saving them."
          actions={
            <Button
              variant="outline"
              size="sm"
              // Blocked for the same reason as Save: with no password to bind
              // with, a test of these settings would fail and blame the
              // directory rather than the missing field.
              disabled={
                test.isPending || form.url === '' || form.searchBase === '' || needsPasswordToAdopt
              }
              onClick={() => {
                setError(null);
                test.mutate(submission(), { onSuccess: setResult, onError: fail });
              }}
            >
              {test.isPending ? 'Testing…' : 'Test connection'}
            </Button>
          }
        >
          {result !== null && <TestResult result={result} />}
        </InsetPanel>

        <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
          <Button
            variant="primary"
            size="sm"
            disabled={
              save.isPending || form.url === '' || form.searchBase === '' || needsPasswordToAdopt
            }
            onClick={() => {
              setError(null);
              save.mutate(submission(), {
                // Clear the field on success: the value is now stored, and
                // leaving it on screen implies it is still pending.
                onSuccess: () => setPassword(''),
                onError: fail,
              });
            }}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>

          {view?.source === 'database' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={clear.isPending}
              onClick={() => {
                setError(null);
                clear.mutate(undefined, { onError: fail });
              }}
            >
              Discard stored settings
            </Button>
          )}

          {view?.updatedAt !== null && view?.updatedAt !== undefined && (
            <span className="ml-auto text-[11px] text-ink-faint">
              Last changed {absolute(view.updatedAt)}
              {view.updatedByEmail !== null && ` by ${view.updatedByEmail}`}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A labelled control.
 *
 * `id` is required, not optional: without the htmlFor/id pairing a screen
 * reader announces an unlabelled text box. That is also how the omission was
 * noticed — a test reported "Bind password" absent from a screen that plainly
 * showed it, because getByLabel had nothing to match.
 */

function Notice({ tone, children }: { tone: 'info' | 'warn'; children: React.ReactNode }) {
  const warn = tone === 'warn';
  return (
    <div
      className={
        warn
          ? 'rounded border border-state-pending/40 bg-state-pending/10 p-2'
          : 'rounded border border-line bg-panel p-2'
      }
    >
      <div className="flex items-start gap-2">
        {warn && (
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-state-pending" aria-hidden />
        )}
        <p className={warn ? 'text-[11px] text-state-pending' : 'text-[11px] text-ink-muted'}>
          {children}
        </p>
      </div>
    </div>
  );
}

/**
 * What the directory said.
 *
 * Rendered verbatim from the provider. Core does not know what LDAP is, and the
 * provider decides what is safe to show (ADR-0002).
 */
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

/**
 * Which directory groups grant which role.
 *
 * The most consequential thing on this screen: these decide who can reclassify
 * a thousand machines. An empty list is a valid configuration and means every
 * authenticated user is refused, which the hint says rather than leaving to be
 * discovered at a login.
 */
function RoleMappings({
  mappings,
  onChange,
  knownRoles,
}: {
  mappings: LdapSettings['roleMappings'];
  onChange: (next: LdapSettings['roleMappings']) => void;
  knownRoles: string[];
}) {
  /*
   * A mapping naming a role this deployment does not define.
   *
   * It does not fail at save time and it does not fail at start-up. It fails at
   * somebody's next sign-in, by resolving to no permissions — and the only clue
   * is a person reporting they can suddenly do nothing. Here is the cheapest
   * possible moment to notice (ADR-0018 §5).
   *
   * knownRoles empty means the roles could not be read, not that none exist;
   * flagging everything then would be noise, so nothing is flagged.
   */
  const dangling = (role: string) =>
    knownRoles.length > 0 && role !== '' && !knownRoles.includes(role);
  const broken = mappings.filter((mapping) => dangling(mapping.role));

  return (
    <div className="space-y-1.5">
      <Label>Role mappings</Label>

      {broken.length > 0 && (
        <div
          role="alert"
          className="rounded border border-state-pending/40 bg-state-pending/10 p-2"
        >
          <p className="text-[11px] font-semibold text-ink">
            {broken.length === 1
              ? '1 mapping names a role that does not exist'
              : `${broken.length} mappings name roles that do not exist`}
          </p>
          <p className="mt-1 max-w-prose text-[11px] text-ink-muted">
            {'Anybody in '}
            {broken.map((m) => m.groupDn).join(', ')}
            {' signs in successfully and is then denied everything, because the role named here '}
            {'is not one this deployment defines. Point them at a role that exists, or create it '}
            {'under Users & Roles.'}
          </p>
        </div>
      )}
      <p className="text-[11px] text-ink-faint">
        {'Recomputed at every sign-in from group membership. Where someone matches several '}
        {'built-in roles the highest wins; where any custom role is matched, their permissions '}
        {'are combined. With none set, anybody who authenticates is refused for having no '}
        {'mapped group.'}
      </p>

      {mappings.map((mapping, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={mapping.groupDn}
            onChange={(e) =>
              onChange(
                mappings.map((m, i) => (i === index ? { ...m, groupDn: e.target.value } : m)),
              )
            }
            placeholder="cn=puppet-admins,ou=groups,dc=example,dc=com"
            className="font-mono text-[11px]"
          />
          <Select
            value={mapping.role}
            onChange={(e) =>
              onChange(mappings.map((m, i) => (i === index ? { ...m, role: e.target.value } : m)))
            }
            className="h-7 w-40 text-xs"
            aria-invalid={dangling(mapping.role)}
          >
            {/*
              A mapping may name a role that no longer exists. Keeping the value
              as an option means opening the form does not silently rewrite it
              to whatever happened to be first — which would repair the symptom
              and lose the fact.
            */}
            {dangling(mapping.role) && (
              <option value={mapping.role}>{mapping.role} — no such role</option>
            )}
            {knownRoles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onChange(mappings.filter((_, i) => i !== index))}
            aria-label={`Remove mapping for ${mapping.groupDn || 'this group'}`}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}

      <Button
        variant="secondary"
        size="sm"
        onClick={() => onChange([...mappings, { groupDn: '', role: 'VIEWER' }])}
      >
        <Plus aria-hidden />
        Add mapping
      </Button>
    </div>
  );
}

/**
 * What this deployment is actually reading its directory settings from.
 *
 * "unset" needs the provider check. Core cannot parse the enterprise layer's
 * environment variables (ADR-0002), so it reports no stored configuration and
 * no environment baseline it can see — which rendered as "not configured" on a
 * deployment where LDAP was demonstrably running and people were signing in
 * through it. A running provider is proof the environment configured one, even
 * though core cannot read the detail.
 */
function sourceLabel(
  source: 'database' | 'environment' | 'unset',
  providerRunning: boolean,
): string {
  if (source === 'database') return 'stored here';
  if (source === 'environment') return 'from the environment';
  return providerRunning ? 'from the environment' : 'not configured';
}
