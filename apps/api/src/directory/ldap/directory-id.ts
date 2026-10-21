/**
 * The stable id of a directory entry, as the string an account is linked by
 * (ADR-0031).
 *
 * Both directories give every entry a UUID that survives renames, moves and a
 * changed mail or UPN — which is the point: the account follows the PERSON,
 * not whichever address they happen to have today.
 *
 * - **Active Directory: `objectGUID`**, 16 raw bytes. NOT in the textual
 *   order: the first three fields are little-endian (Microsoft's GUID struct —
 *   Data1 uint32, Data2 uint16, Data3 uint16, then Data4 as 8 bytes in order).
 *   `{00112233-4455-6677-8899-aabbccddeeff}` is stored as
 *   `33 22 11 00 55 44 77 66 88 99 aa bb cc dd ee ff`. Reading the bytes
 *   straight through as hex gives a different, equally plausible-looking UUID
 *   — one no AD tool would ever show an operator.
 * - **OpenLDAP: `entryUUID`**, already text (RFC 4530).
 *
 * Either way the result is the canonical lower-case 8-4-4-4-12 form, so the
 * id an operator sees in `Get-ADUser` or `ldapsearch` is the one stored.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** AD's objectGUID bytes as the GUID string AD's own tools print, lower-cased. */
export function guidFromObjectGuid(bytes: Uint8Array): string | null {
  if (bytes.length !== 16) return null;

  const hex = (indices: number[]): string =>
    indices.map((i) => (bytes[i] ?? 0).toString(16).padStart(2, '0')).join('');

  return [
    hex([3, 2, 1, 0]),
    hex([5, 4]),
    hex([7, 6]),
    hex([8, 9]),
    hex([10, 11, 12, 13, 14, 15]),
  ].join('-');
}

/**
 * The directory id from whatever the client returned for the attribute, or
 * null when there is none usable.
 *
 * Null is an ordinary answer — a directory whose ACLs hide entryUUID from the
 * account that searched, say — and the caller degrades rather than failing
 * the sign-in: see LdapAuthProvider.
 */
export function directoryIdFrom(value: unknown, binary: boolean): string | null {
  const first = Array.isArray(value) ? (value as unknown[])[0] : value;

  if (binary) {
    return first instanceof Uint8Array ? guidFromObjectGuid(first) : null;
  }

  if (typeof first !== 'string') return null;
  const text = first.trim().toLowerCase();
  return UUID.test(text) ? text : null;
}
