import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildTar, tarChunks, TarNameTooLongError } from './ustar';

const entry = (name: string, body: string) => ({ name, content: Buffer.from(body, 'utf8') });

describe('buildTar', () => {
  it('produces byte-identical output for identical input', () => {
    const input = [entry('default.yaml', 'classes: {}\n'), entry('nodes/a.yaml', 'x: 1\n')];

    expect(buildTar(input).equals(buildTar(input))).toBe(true);
  });

  /*
   * The reason determinism matters, stated as a test rather than a comment:
   * the ETag is the hash of these bytes. If the archive varied — because a tar
   * implementation stamped the current time, say — every poll would look like
   * a change, transfer the whole tree, and rewrite it on the Puppet server.
   * "Replication is working" and estate-wide file churn look identical from
   * the outside.
   */
  it('does not vary with the clock', async () => {
    const input = [entry('default.yaml', 'classes: {}\n')];
    const first = buildTar(input);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(buildTar(input).equals(first)).toBe(true);
  });

  it('changes when content changes', () => {
    const a = buildTar([entry('nodes/a.yaml', 'x: 1\n')]);
    const b = buildTar([entry('nodes/a.yaml', 'x: 2\n')]);

    expect(a.equals(b)).toBe(false);
  });

  it('carries no uid, gid or owner name from the building host', () => {
    const tar = buildTar([entry('default.yaml', 'x\n')]);

    // uid at 108, gid at 116, uname at 265, gname at 297 — all fixed.
    expect(tar.subarray(108, 116).toString('ascii')).toBe('0000000\0');
    expect(tar.subarray(116, 124).toString('ascii')).toBe('0000000\0');
    expect(tar[265]).toBe(0);
    expect(tar[297]).toBe(0);
  });

  it('rejects a name too long for USTAR rather than truncating it', () => {
    expect(() => buildTar([entry(`nodes/${'x'.repeat(120)}.yaml`, 'x')])).toThrow(
      TarNameTooLongError,
    );
  });

  /**
   * The archive is consumed by whatever `tar` the Puppet server ships, so the
   * only assertion that really counts is that a real tar can read it. Hand-
   * verifying header arithmetic proves the bytes match my belief about the
   * format, not that the format is right.
   */
  it('is readable by the system tar, with the expected contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ustar-'));
    const archive = join(dir, 'tree.tar');

    writeFileSync(
      archive,
      buildTar([
        entry('default.yaml', 'classes: {}\n'),
        entry('nodes/web01.example.com.yaml', 'classes:\n  base: {}\n'),
      ]),
    );

    execFileSync('tar', ['-xf', archive, '-C', dir]);

    expect(readdirSync(dir).sort()).toEqual(['default.yaml', 'nodes', 'tree.tar']);
    expect(readFileSync(join(dir, 'default.yaml'), 'utf8')).toBe('classes: {}\n');
    expect(readFileSync(join(dir, 'nodes/web01.example.com.yaml'), 'utf8')).toBe(
      'classes:\n  base: {}\n',
    );
  });

  it('handles a file whose length is an exact block multiple', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ustar-block-'));
    const archive = join(dir, 'tree.tar');
    const exact = 'y'.repeat(512);

    writeFileSync(archive, buildTar([entry('default.yaml', exact)]));
    execFileSync('tar', ['-xf', archive, '-C', dir]);

    expect(readFileSync(join(dir, 'default.yaml'), 'utf8')).toBe(exact);
  });

  it('writes an empty archive that tar accepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ustar-empty-'));
    const archive = join(dir, 'tree.tar');

    writeFileSync(archive, buildTar([]));

    expect(() => execFileSync('tar', ['-tf', archive])).not.toThrow();
  });

  /*
   * PINNED BYTES, not just "equal to itself".
   *
   * These hashes were taken from the writer BEFORE it grew `tarChunks` and the
   * `mtime` option for the support bundle (ADR-0028). Replication's ETag is the
   * hash of this output, so a refactor that changed a single byte would make
   * every Puppet server re-download and rewrite the whole tree once, on
   * upgrade, and nothing else would notice. Self-consistency tests cannot see
   * that; a fixed hash can.
   */
  it.each([
    ['an empty archive', [], '84ff92691f909a05b224e1c56abb4864f01b4f8e3c854e4bb4c7baf1d3f6d652'],
    [
      'two small files',
      [
        entry('default.yaml', 'classes: {}\n'),
        entry('nodes/web01.example.com.yaml', 'classes:\n  base: {}\n'),
      ],
      '235b4dccb8151225a87932cab5225ae6b02c73e4e8ad868e2a9683a049c71503',
    ],
    [
      'a file spanning a record',
      [entry('nodes/a.yaml', 'x'.repeat(10_000))],
      '89e7b15e32898d2b03c006d033fe1c95e410b113b481ff6cc1b424a0860b4471',
    ],
  ])('still emits the exact bytes replication has always served: %s', (_label, input, sha) => {
    expect(createHash('sha256').update(buildTar(input)).digest('hex')).toBe(sha);
  });

  it('streams the same bytes it builds', () => {
    const input = [entry('a.json', '{}'), entry('logs/b.log', 'z'.repeat(1_234))];

    expect(Buffer.concat([...tarChunks(input)]).equals(buildTar(input))).toBe(true);
    expect(
      Buffer.concat([...tarChunks(input, { mtime: 42 })]).equals(buildTar(input, { mtime: 42 })),
    ).toBe(true);
  });

  it('stamps a caller-supplied mtime that the system tar reads back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ustar-mtime-'));
    const archive = join(dir, 'bundle.tar');
    // 2026-09-30T12:00:00Z
    const mtime = Date.UTC(2026, 8, 30, 12, 0, 0) / 1000;

    writeFileSync(archive, buildTar([entry('manifest.json', '{}')], { mtime }));
    const listing = execFileSync('tar', ['-tvf', archive], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC' },
    });

    expect(listing).toContain('2026-09-30 12:00');
  });
});
