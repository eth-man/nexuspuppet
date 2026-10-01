/**
 * A minimal, deterministic USTAR writer.
 *
 * Written here rather than pulled in as a dependency for the same reason
 * scrypt is used over argon2 (ADR-0006): an on-prem operator may have no build
 * toolchain, and the format needed is a few hundred bytes of header arithmetic.
 * `tar` on the receiving side is the standard one — nothing custom is required
 * of the puller.
 *
 * DETERMINISM IS THE POINT, not a nicety. The ETag is the hash of these bytes,
 * so identical content must produce an identical archive on every call, on
 * every host, forever. A tar library that stamps the current time — which is
 * the default behaviour of most — would change the ETag on every poll, and
 * every poll would then transfer the whole tree and rewrite it on the Puppet
 * server. The failure would look like "replication is working" while producing
 * continuous estate-wide file churn, which is the same hazard ADR-0003 §4
 * describes for the materializer.
 *
 * So every field that could vary is fixed: mtime 0, uid/gid 0, owner/group
 * empty, mode 0644, and entries written in the caller's order (the caller
 * sorts). Nothing here reads the clock or the filesystem.
 */

const BLOCK = 512;
const NAME_MAX = 100;

export class TarNameTooLongError extends Error {
  constructor(name: string) {
    super(
      `"${name}" exceeds ${String(NAME_MAX)} bytes and USTAR prefix splitting is not implemented. ` +
        'ENC paths are nodes/<certname>.yaml, so this means a certname long enough to need it.',
    );
    this.name = 'TarNameTooLongError';
  }
}

export interface TarEntry {
  /** Path inside the archive, e.g. `nodes/web01.example.com.yaml`. */
  name: string;
  content: Buffer;
}

export interface TarOptions {
  /**
   * Modification time stamped on every entry, in whole seconds since the epoch.
   *
   * DEFAULTS TO 0, and replication must never pass it: the ETag is the hash of
   * these bytes (see above). It exists for the support bundle (ADR-0028), a
   * one-off archive a person extracts and reads, where every file dated
   * 1 January 1970 is noise and the generation time is information. The value
   * is the CALLER'S — this module still never reads the clock.
   */
  mtime?: number;
}

/** Left-aligned NUL-padded string field. */
function writeString(header: Buffer, value: string, offset: number, size: number): void {
  header.write(value, offset, size, 'utf8');
}

/**
 * Octal numeric field: zero-padded, NUL-terminated, `size - 1` digits.
 * GNU accepts a trailing space instead; NUL is the portable choice.
 */
function writeOctal(header: Buffer, value: number, offset: number, size: number): void {
  header.write(value.toString(8).padStart(size - 1, '0'), offset, size - 1, 'ascii');
}

function buildHeader(entry: TarEntry, mtime: number): Buffer {
  const nameBytes = Buffer.byteLength(entry.name, 'utf8');
  if (nameBytes > NAME_MAX) throw new TarNameTooLongError(entry.name);

  const header = Buffer.alloc(BLOCK);

  writeString(header, entry.name, 0, NAME_MAX);
  writeOctal(header, 0o644, 100, 8); // mode
  writeOctal(header, 0, 108, 8); // uid — always root, never the running user
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, entry.content.length, 124, 12); // size
  writeOctal(header, mtime, 136, 12); // mtime — epoch unless the caller says otherwise, never now()
  writeString(header, '0', 156, 1); // typeflag: regular file
  writeString(header, 'ustar', 257, 6);
  writeString(header, '00', 263, 2);
  // owner/group names left empty so the archive does not carry this host's
  // account names into someone else's filesystem.

  /*
   * The checksum is computed with its own field treated as eight spaces, then
   * written back into that field. Getting this wrong produces an archive that
   * every tar implementation rejects with an unhelpful message.
   */
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  writeOctal(header, sum, 148, 7);
  header.writeUInt8(0x20, 155);

  return header;
}

function pad(length: number): Buffer {
  const remainder = length % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

/**
 * The archive as a sequence of chunks, in the order given.
 *
 * A generator so a large archive can be streamed into gzip and out to a socket
 * without first being concatenated into one buffer — the support bundle can
 * carry up to 100 MiB of logs, and holding that twice to build a Buffer that is
 * immediately compressed is waste. `buildTar` is this, concatenated, and emits
 * exactly the bytes it always has.
 *
 * The caller sorts. Sorting here would hide a caller that produced entries in
 * filesystem order — which `readdir` does not guarantee to be stable — and the
 * resulting ETag flapping would be extremely hard to attribute.
 */
export function* tarChunks(
  entries: readonly TarEntry[],
  options: TarOptions = {},
): Generator<Buffer, void, undefined> {
  const mtime = options.mtime ?? 0;
  let length = 0;

  for (const entry of entries) {
    const header = buildHeader(entry, mtime);
    const padding = pad(entry.content.length);
    yield header;
    yield entry.content;
    if (padding.length > 0) yield padding;
    length += header.length + entry.content.length + padding.length;
  }

  // Two zero blocks terminate the archive, then it is padded to a 10240-byte
  // record. GNU tar accepts a short trailer but warns; other implementations
  // are less forgiving, and the padding costs nothing.
  length += BLOCK * 2;
  const recordRemainder = length % (BLOCK * 20);
  yield Buffer.alloc(BLOCK * 2 + (recordRemainder === 0 ? 0 : BLOCK * 20 - recordRemainder));
}

/** Build a USTAR archive from entries, in the order given. See `tarChunks`. */
export function buildTar(entries: readonly TarEntry[], options: TarOptions = {}): Buffer {
  return Buffer.concat([...tarChunks(entries, options)]);
}
