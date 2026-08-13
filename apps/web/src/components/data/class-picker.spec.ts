import type { ClassIndex } from '@nexuspuppet/contracts';
import { findClass, paramsToJson, suggestionNotice } from './class-picker';

/*
 * THE RULE THIS FILE PROTECTS.
 *
 * A blank field means "let the class decide", and must produce NO key at all.
 * Sending the class's own default back as an override would pin it into every
 * document the group produces — and, worse, that value would stop tracking the
 * module when its default later changed. The form shows defaults as
 * PLACEHOLDERS for exactly this reason, and this is the half of that decision
 * that can be tested.
 */
describe('paramsToJson', () => {
  it('omits blank fields rather than sending null', () => {
    const { json } = paramsToJson({ pubkey: '"ssh-rsa AAA"', users: '', target: '   ' });

    expect(JSON.parse(json)).toEqual({ pubkey: 'ssh-rsa AAA' });
  });

  it('produces an empty object when nothing was filled in', () => {
    expect(JSON.parse(paramsToJson({}).json)).toEqual({});
    expect(JSON.parse(paramsToJson({ a: '', b: '  ' }).json)).toEqual({});
  });

  it('keeps JSON types when the operator writes JSON', () => {
    const { json } = paramsToJson({
      count: '42',
      enabled: 'true',
      list: '["a","b"]',
      nested: '{"k":1}',
      quoted: '"text"',
    });

    expect(JSON.parse(json)).toEqual({
      count: 42,
      enabled: true,
      list: ['a', 'b'],
      nested: { k: 1 },
      quoted: 'text',
    });
  });

  /*
   * Bare text is the common intent — an operator typing a hostname should not
   * have to quote it. Refusing would make the form worse than the textarea it
   * replaces.
   */
  it('treats unquoted text as a string rather than refusing it', () => {
    const { json } = paramsToJson({ host: 'db01.example.com', note: 'two words' });

    expect(JSON.parse(json)).toEqual({ host: 'db01.example.com', note: 'two words' });
  });

  it('does not mistake a false or zero value for a blank field', () => {
    // `false` and `0` are real values an operator meant to set. Dropping them
    // as "empty" would silently fall back to the class default.
    const { json } = paramsToJson({ enabled: 'false', retries: '0' });

    expect(JSON.parse(json)).toEqual({ enabled: false, retries: 0 });
  });
});

describe('findClass', () => {
  const index: ClassIndex = {
    status: 'ok',
    environment: 'production',
    classes: [
      { name: 'jump_access', path: '/m.pp', params: [] },
      { name: 'profile::base', path: '/p.pp', params: [] },
    ],
    fileErrors: [],
    fetchedAt: '2026-08-13T00:00:00.000Z',
    cached: false,
  };

  it('finds a class by exact name', () => {
    expect(findClass(index, 'profile::base')?.path).toBe('/p.pp');
  });

  it('returns null for a class not in the list, rather than guessing', () => {
    // The caller marks this as unknown and still allows the write. A fuzzy
    // match here would silently attach the wrong signature to the form.
    expect(findClass(index, 'profile::bass')).toBeNull();
  });

  it('returns null when suggestions are unavailable', () => {
    expect(findClass(undefined, 'jump_access')).toBeNull();
  });
});

/*
 * THE REPORT THIS EXISTS FOR.
 *
 * An operator upgraded specifically to get the class picker, opened the dialog,
 * and saw an empty field with no explanation. ADR-0024 §4 had made an unset
 * PUPPETSERVER_URL render NOTHING, so that nobody who did not want the feature
 * would be nagged — but silence chosen to avoid nagging is indistinguishable
 * from breakage, and cost them an evening.
 */
describe('suggestionNotice', () => {
  const index = (over: Partial<ClassIndex>): ClassIndex => ({
    status: 'ok',
    environment: 'production',
    classes: [],
    fileErrors: [],
    fetchedAt: null,
    cached: false,
    ...over,
  });

  it('says the feature exists when it is unconfigured', () => {
    expect(suggestionNotice(index({ status: 'disabled' }))).toBe('unconfigured');
  });

  /*
   * Still loading, or the request itself failed. A message here would flicker
   * on every dialog open, which is the nagging §4 was right to avoid.
   */
  it('says nothing while there is no answer yet', () => {
    expect(suggestionNotice(undefined)).toBe('nothing');
  });

  it.each([
    ['ok', 'ok'],
    ['forbidden', 'forbidden'],
    ['unavailable', 'unavailable'],
  ])('shows the full status line for %s', (_label, status) => {
    // These already carry their own operator-facing message — a 403 names the
    // auth.conf rule to add — so they must not be replaced by the generic hint.
    expect(suggestionNotice(index({ status: status as ClassIndex['status'] }))).toBe('status');
  });
});
