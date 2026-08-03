'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Network, Plus, Trash2, XCircle } from 'lucide-react';
import type { LdapSettings, ProviderVerification } from '@nexuspuppet/contracts';
import { useCapabilities, useLdapSettings, useRoles } from '@/lib/queries';
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
import { Field, FieldRow } from '@/components/ui/field';
import { InfoHint } from '@/components/ui/info-hint';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { LoadingRows, QueryError } from '@/components/states';
import { DirectoryUnavailable } from '@/components/data/directory-unavailable';

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
 * Two things about this screen are load-bearing rather than decorative:
 *
 * **The bind password is never loaded.** The API does not return it, so the
 * field starts empty even when one is stored, and an empty field on save means
 * "keep it". The alternative — rendering a masked placeholder — leaks its
 * length and tempts the form into sending it back.
 *
 * **Test before Save.** Configuring a directory by trial and error against the
 * login screen is how people lock themselves out; that is not hypothetical
 * here, it is what happened on the first deployment that enabled LDAP.
 *
 * The layout groups fields by the DECISION they belong to — how to reach the
 * directory, where to look inside it, who gets what — rather than in schema
 * order. Six inputs in one column with a paragraph under each read as a debug
 * form, and somebody arriving to change one group mapping had to scan all of it.
 */
export function LdapSettingsPanel() {
  const { can } = useAuth();
  const manages = can('settings:manage');

  /*
   * Entitlement is the CAPABILITY, not a licence.
   *
   * `directory.ldap` is advertised only when the enterprise layer is installed
   * and a provider can actually run. Core used to render this whole form, store
   * what was typed, and explain in a warning box that none of it would take
   * effect — which reads as a broken product rather than an unavailable
   * feature.
   */
  const capabilities = useCapabilities();
  const licensed = capabilities.data?.capabilities.includes('directory.ldap') === true;

  // Not fetched when the feature cannot run: a request whose answer is only
  // used to populate a form nobody will see.
  const stored = useLdapSettings(manages && licensed);
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
  /** Set by the empty state's CTA. */
  const [revealed, setRevealed] = useState(false);

  const view = stored.data;

  useEffect(() => {
    // Load the server's copy once it arrives. The password is deliberately not
    // part of this — there is nothing to load, by design.
    if (view?.config !== null && view?.config !== undefined) setForm({ ...BLANK, ...view.config });
  }, [view?.config]);

  if (!manages) return null;

  /*
   * Before the loading states, so core never flashes a skeleton of a form it
   * is not going to render.
   */
  if (capabilities.isSuccess && !licensed) return <DirectoryUnavailable />;

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
   * anonymously, and the first person to notice would be whoever could no
   * longer sign in.
   */
  const needsPasswordToAdopt =
    view?.source === 'environment' &&
    (view.config?.bindDn ?? '') !== '' &&
    !holdsPassword &&
    password === '';

  /*
   * Configured means SOMETHING is in force: stored settings, an environment
   * baseline, or a provider that is demonstrably running. The last matters
   * because core cannot read the enterprise layer's environment (ADR-0002) and
   * would otherwise call a working LDAP deployment "not configured".
   */
  const configured =
    view?.source === 'database' || view?.source === 'environment' || view?.liveReload === true;

  if (!configured && !revealed) return <NotConfigured onConfigure={() => setRevealed(true)} />;

  const blocked = form.url === '' || form.searchBase === '' || needsPasswordToAdopt;

  return (
    <div className="space-y-4">
      <StatusNotices source={view?.source} liveReload={view?.liveReload === true} />

      {error !== null && (
        <div role="alert" className="rounded border border-state-failed/40 bg-state-failed/10 p-2">
          <p className="text-xs text-state-failed">{error}</p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardHeading>
            <CardTitle>Connection &amp; authentication</CardTitle>
            <CardDescription>
              Where the directory is, and the account used to read it.
            </CardDescription>
          </CardHeading>
          {view !== undefined && (
            <div className="flex shrink-0 items-center gap-2">
              <Badge>{sourceLabel(view.source, view.liveReload)}</Badge>
              {view.disabled && <Badge>disabled</Badge>}
            </div>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          <FieldRow>
            <Field
              className="min-w-64 flex-[3]"
              required
              label="Server URL"
              tooltip={
                <InfoHint
                  label="About the server URL"
                  text="ldaps:// is strongly preferred. ldap:// sends the bind password across the network in clear text, where anything on the path can read it."
                />
              }
            >
              {(id) => (
                <Input
                  id={id}
                  value={form.url}
                  onChange={(e) => field('url', e.target.value)}
                  placeholder="ldaps://directory.example.com:636"
                  aria-invalid={form.url !== '' && !/^ldaps?:\/\//i.test(form.url)}
                />
              )}
            </Field>

            <Field className="w-44" label="Directory type">
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
          </FieldRow>

          <FieldRow>
            <Field
              className="min-w-64 flex-1"
              label="Bind DN"
              tooltip={
                <InfoHint
                  label="About the bind DN"
                  text="The service account that searches the directory. It needs read access to the user and group subtrees — nothing more."
                />
              }
            >
              {(id) => (
                <Input
                  id={id}
                  value={form.bindDn ?? ''}
                  onChange={(e) => field('bindDn', e.target.value)}
                  placeholder="cn=svc-nexuspuppet,dc=example,dc=com"
                  className="font-mono text-[11px]"
                />
              )}
            </Field>

            <Field
              className="min-w-64 flex-1"
              hint={holdsPassword ? 'A password is stored. Leave blank to keep it.' : undefined}
              error={
                needsPasswordToAdopt
                  ? 'Required: the environment supplied this account but not its password, which cannot be carried forward.'
                  : null
              }
              label="Bind password"
              tooltip={
                <InfoHint
                  label="About the bind password"
                  text="Never sent back to the browser, so this field is empty even when one is stored. Leaving it blank keeps the existing value; typing replaces it."
                />
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
                  placeholder={holdsPassword ? '•••••••• (unchanged)' : ''}
                  aria-invalid={needsPasswordToAdopt}
                />
              )}
            </Field>
          </FieldRow>

          <div className="space-y-2 border-t border-line-soft pt-3">
            <Switch
              checked={form.tlsRejectUnauthorized}
              onCheckedChange={(next) => field('tlsRejectUnauthorized', next)}
              // A real ’, not &rsquo;. Entities are only decoded in JSX TEXT;
              // in a string prop this would render the six characters.
              label={'Verify the directory\u2019s TLS certificate'}
              description="Turn this off only for a test directory with a self-signed certificate."
            />

            {form.tlsRejectUnauthorized === false && (
              <Notice tone="warn">
                {'Verification is off. Anything on the network path can present itself as your '}
                {'directory and collect the bind password. Never acceptable for a directory that '}
                {'authenticates administrators.'}
              </Notice>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardHeading>
            <CardTitle>Search parameters</CardTitle>
            <CardDescription>Which parts of the tree hold your people and groups.</CardDescription>
          </CardHeading>
        </CardHeader>

        <CardContent>
          <FieldRow>
            <Field
              className="min-w-64 flex-1"
              required
              label="Search base"
              tooltip={
                <InfoHint
                  label="About the search base"
                  text="The subtree searched when somebody signs in. Narrower is better: it bounds what the service account can see."
                />
              }
            >
              {(id) => (
                <Input
                  id={id}
                  value={form.searchBase}
                  onChange={(e) => field('searchBase', e.target.value)}
                  placeholder="ou=people,dc=example,dc=com"
                  className="font-mono text-[11px]"
                />
              )}
            </Field>

            <Field
              className="min-w-64 flex-1"
              hint="Defaults to the search base when blank."
              label="Group search base"
              tooltip={
                <InfoHint
                  label="About the group search base"
                  text="Where group entries live, when they are not under the same subtree as people."
                />
              }
            >
              {(id) => (
                <Input
                  id={id}
                  value={form.groupSearchBase ?? ''}
                  onChange={(e) => field('groupSearchBase', e.target.value)}
                  placeholder="ou=groups,dc=example,dc=com"
                  className="font-mono text-[11px]"
                />
              )}
            </Field>
          </FieldRow>
        </CardContent>
      </Card>

      <RoleMappings
        mappings={form.roleMappings}
        onChange={(roleMappings) => field('roleMappings', roleMappings)}
        knownRoles={knownRoles}
      />

      {/*
        Testing keeps its own panel, above the action bar.

        The RESULT is the thing that must not be mistaken for a save: a green
        tick in the same strip as Save reads as confirmation that saving
        happened. Keeping the outcome here, and giving Test the quieter of the
        two button weights below, is what says which one wrote something.
      */}
      <InsetPanel
        title="Test this configuration"
        description="Binds with the values above without saving them."
      >
        {result !== null && <TestResult result={result} />}
      </InsetPanel>

      <ActionBar
        busy={save.isPending || test.isPending || clear.isPending}
        blocked={blocked}
        testing={test.isPending}
        saving={save.isPending}
        onTest={() => {
          setError(null);
          test.mutate(submission(), { onSuccess: setResult, onError: fail });
        }}
        onSave={() => {
          setError(null);
          save.mutate(submission(), {
            // Clear the field on success: the value is now stored, and leaving
            // it on screen implies it is still pending.
            onSuccess: () => setPassword(''),
            onError: fail,
          });
        }}
        onDiscard={
          view?.source === 'database'
            ? () => {
                setError(null);
                clear.mutate(undefined, { onError: fail });
              }
            : undefined
        }
        updatedAt={view?.updatedAt ?? null}
        updatedByEmail={view?.updatedByEmail ?? null}
      />
    </div>
  );
}

/**
 * Nothing is configured yet.
 *
 * The form used to render regardless — every field blank, with a warning box
 * above it explaining that none of it was in force. That is a lot of screen
 * saying "not yet", and it left an operator unable to tell an unconfigured
 * directory from a broken one, because both look like an empty form.
 */
function NotConfigured({ onConfigure }: { onConfigure: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span className="rounded-full border border-line-soft bg-panel-raised p-3">
          <Network className="size-6 text-ink-faint" aria-hidden />
        </span>

        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-ink">No directory connected</h2>
          <p className="mx-auto max-w-sm text-xs text-ink-muted">
            {'Connect your organisation’s directory to sign people in with the accounts they '}
            {'already have, and to decide what they can do from the groups they are already in.'}
          </p>
        </div>

        <Button variant="primary" size="sm" onClick={onConfigure}>
          Configure directory
        </Button>

        <p className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          <Info className="size-3 shrink-0" aria-hidden />
          Local accounts keep working either way.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * What is in force, and what is not — as compact strips above the form.
 *
 * These were full-width boxes carrying three sentences each. Both are worth
 * saying and neither is worth the top third of the screen, so the sentence
 * stays on the strip and the paragraph moves into the hint beside it.
 */
function StatusNotices({
  source,
  liveReload,
}: {
  source: 'database' | 'environment' | 'unset' | undefined;
  liveReload: boolean;
}) {
  if (source === undefined) return null;

  const fromEnvironment = source === 'environment' || (source === 'unset' && liveReload);

  return (
    <>
      {fromEnvironment && (
        <Notice tone="info">
          {'Configured from the environment. Saving here stores a configuration in the database, '}
          {'which then takes precedence. '}
          <InfoHint
            label="About environment precedence"
            text="The environment is left as it is, and is used again only if you discard the stored settings."
          />
        </Notice>
      )}

      {!liveReload && (
        <Notice tone="warn">
          {'No directory provider is running, so changes saved here will not take effect until '}
          {'the API restarts. '}
          <InfoHint
            label="Why a restart is needed"
            text="Providers register at boot. Set LDAP_URL in the environment and restart once; after that this screen is enough."
          />
        </Notice>
      )}
    </>
  );
}

/**
 * Test and Save in one bar, with the weights doing the talking.
 *
 * Save is the only filled button on the screen and Test is an outline beside
 * it. They sit together because that is where somebody finishing a form looks
 * for them; they are told apart by weight, and by the test result appearing in
 * its own panel above rather than in this strip.
 */
function ActionBar({
  busy,
  blocked,
  testing,
  saving,
  onTest,
  onSave,
  onDiscard,
  updatedAt,
  updatedByEmail,
}: {
  busy: boolean;
  blocked: boolean;
  testing: boolean;
  saving: boolean;
  onTest: () => void;
  onSave: () => void;
  onDiscard?: (() => void) | undefined;
  updatedAt: string | null;
  updatedByEmail: string | null;
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
        {onDiscard !== undefined && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onDiscard}>
            Discard stored settings
          </Button>
        )}
        {/*
          Blocked for the same reason as Save: with no password to bind with, a
          test would fail and blame the directory rather than the missing field.
        */}
        <Button variant="outline" size="sm" disabled={busy || blocked} onClick={onTest}>
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        <Button variant="primary" size="sm" disabled={busy || blocked} onClick={onSave}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
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
 * a thousand machines. Its own card, and a real table rather than a stack of
 * rows, because it is read far more often than the connection settings — and
 * somebody arriving to add one group should not have to read a form to find it.
 *
 * An empty list is a valid configuration and means every authenticated user is
 * refused, which the empty row says outright rather than leaving to be
 * discovered at somebody's login.
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
    <Card>
      <CardHeader>
        <CardHeading>
          <CardTitle>Role mappings</CardTitle>
          <CardDescription>
            Which directory groups grant which role, recomputed at every sign-in.
          </CardDescription>
        </CardHeading>
        <div className="shrink-0">
          <InfoHint
            label="How several matches are resolved"
            text="Where somebody matches several built-in roles the highest wins. Where any custom role is matched, their permissions are combined. With none set, anybody who authenticates is refused for having no mapped group."
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
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
              {'is not one this deployment defines. Point them at a role that exists, or create '}
              {'it under Users & Roles.'}
            </p>
          </div>
        )}

        {mappings.length === 0 ? (
          <p className="rounded border border-dashed border-line-soft px-3 py-4 text-center text-[11px] text-ink-muted">
            No mappings yet. Anybody who authenticates will be refused for having no mapped group.
          </p>
        ) : (
          <div className="scroll-x">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line-soft text-left text-ink-faint">
                  <th className="py-1 pr-3 font-medium">Directory group</th>
                  <th className="w-44 py-1 pr-3 font-medium">Role</th>
                  <th className="w-9 py-1" />
                </tr>
              </thead>
              <tbody>
                {mappings.map((mapping, index) => (
                  <tr key={index} className="border-b border-line-soft/60">
                    <td className="py-1.5 pr-3">
                      <Input
                        value={mapping.groupDn}
                        onChange={(e) =>
                          onChange(
                            mappings.map((m, i) =>
                              i === index ? { ...m, groupDn: e.target.value } : m,
                            ),
                          )
                        }
                        placeholder="cn=puppet-admins,ou=groups,dc=example,dc=com"
                        className="h-7 font-mono text-[11px]"
                        aria-label={`Directory group for mapping ${index + 1}`}
                      />
                    </td>
                    <td className="py-1.5 pr-3">
                      <Select
                        value={mapping.role}
                        onChange={(e) =>
                          onChange(
                            mappings.map((m, i) =>
                              i === index ? { ...m, role: e.target.value } : m,
                            ),
                          )
                        }
                        className="h-7 w-full text-xs"
                        aria-invalid={dangling(mapping.role)}
                        aria-label={`Role for mapping ${index + 1}`}
                      >
                        {/*
                          A mapping may name a role that no longer exists.
                          Keeping the value as an option means opening the form
                          does not silently rewrite it to whatever happened to
                          be first — which would repair the symptom and lose the
                          fact.
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
                    </td>
                    <td className="py-1.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onChange(mappings.filter((_, i) => i !== index))}
                        aria-label={`Remove mapping for ${mapping.groupDn || 'this group'}`}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange([...mappings, { groupDn: '', role: 'VIEWER' }])}
        >
          <Plus aria-hidden />
          Add mapping
        </Button>
      </CardContent>
    </Card>
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
