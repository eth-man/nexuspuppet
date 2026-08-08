import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncDocumentReader } from './enc-document-reader';

function tree(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'enc-read-'));
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
  return dir;
}

const YAML = '---\nclasses:\n  profile::base: {}\nparameters: {}\n';

describe('EncDocumentReader', () => {
  it('returns the bytes on disk, unchanged', async () => {
    const dir = tree({ 'nodes/web01.example.com.yaml': YAML });

    expect(await new EncDocumentReader(dir).readNode('web01.example.com')).toBe(YAML);
  });

  /*
   * Null is "this node has no file", which means it receives default.yaml — a
   * valid classification (ADR-0003), not an error. The caller says so.
   */
  it('returns null for a node with no file of its own', async () => {
    expect(await new EncDocumentReader(tree()).readNode('never-seen.example.com')).toBeNull();
  });

  it('reads the default document', async () => {
    const dir = tree({ 'default.yaml': 'classes: {}\n' });

    expect(await new EncDocumentReader(dir).readDefault()).toBe('classes: {}\n');
  });

  /*
   * The certname arrives from a URL and is turned into a filesystem path. A
   * "cleaned" certname would read the wrong node's classification, so anything
   * suspicious is refused outright rather than sanitised — the same guard the
   * writer applies.
   */
  it.each([['../../etc/passwd'], ['..'], ['nodes/../../secret'], [''], ['has space']])(
    'refuses to build a path from %p',
    async (certname) => {
      const dir = tree({ 'nodes/web01.example.com.yaml': YAML });

      expect(await new EncDocumentReader(dir).readNode(certname)).toBeNull();
    },
  );

  it('does not escape the nodes directory even when the file exists', async () => {
    const dir = tree({ 'default.yaml': 'secret\n' });

    // `../default.yaml` resolves to a real file; the guard must still refuse.
    expect(await new EncDocumentReader(dir).readNode('../default')).toBeNull();
  });

  /*
   * A permission error is NOT absence. Reporting it as null would show an
   * empty document for a node whose classification is perfectly good, and send
   * somebody looking for a classification bug instead of a mount problem.
   */
  it('throws rather than reporting absence when the file cannot be read', async () => {
    const dir = tree({ 'nodes/locked.example.com.yaml': YAML });
    chmodSync(join(dir, 'nodes/locked.example.com.yaml'), 0o000);

    const reader = new EncDocumentReader(dir);
    let threw = false;
    try {
      await reader.readNode('locked.example.com');
    } catch {
      threw = true;
    } finally {
      chmodSync(join(dir, 'nodes/locked.example.com.yaml'), 0o644);
    }

    // Running as root defeats the permission bit, so the assertion is
    // conditional rather than flaky — root reads it and gets the contents.
    if (process.getuid?.() !== 0) expect(threw).toBe(true);
  });
});
