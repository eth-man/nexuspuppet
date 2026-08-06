import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncReplicationService } from './enc-replication.service';
import type { PrismaService } from '../prisma/prisma.service';

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'enc-'));
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
  return dir;
}

function fakePrisma(): { prisma: PrismaService; upsert: jest.Mock } {
  const upsert = jest.fn().mockResolvedValue(undefined);
  return { prisma: { encReplicationPeer: { upsert } } as unknown as PrismaService, upsert };
}

const service = (dir: string, prisma: PrismaService) => new EncReplicationService(prisma, dir);

describe('EncReplicationService.readTree', () => {
  it('packs default.yaml and every node file', async () => {
    const dir = tree({
      'default.yaml': 'classes: {}\n',
      'nodes/a.example.com.yaml': 'classes:\n  base: {}\n',
      'nodes/b.example.com.yaml': 'classes: {}\n',
    });

    const result = await service(dir, fakePrisma().prisma).readTree();

    expect(result.fileCount).toBe(3);
    expect(result.etag).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls, so an unchanged tree stays a 304', async () => {
    const dir = tree({ 'default.yaml': 'classes: {}\n', 'nodes/a.yaml': 'x: 1\n' });
    const svc = service(dir, fakePrisma().prisma);

    expect((await svc.readTree()).etag).toBe((await svc.readTree()).etag);
  });

  it('changes the etag when a node file changes', async () => {
    const dir = tree({ 'default.yaml': 'classes: {}\n', 'nodes/a.yaml': 'x: 1\n' });
    const svc = service(dir, fakePrisma().prisma);
    const before = (await svc.readTree()).etag;

    writeFileSync(join(dir, 'nodes/a.yaml'), 'x: 2\n');

    expect((await svc.readTree()).etag).not.toBe(before);
  });

  /*
   * readdir order is not guaranteed, so without an explicit sort two origins
   * holding identical content could serve different etags — and a puller
   * switched between them would resync the whole tree for no reason.
   */
  it('does not depend on directory listing order', async () => {
    const first = tree({ 'default.yaml': 'd\n', 'nodes/a.yaml': 'a\n', 'nodes/b.yaml': 'b\n' });
    const second = tree({ 'default.yaml': 'd\n', 'nodes/b.yaml': 'b\n', 'nodes/a.yaml': 'a\n' });

    expect((await service(first, fakePrisma().prisma).readTree()).etag).toBe(
      (await service(second, fakePrisma().prisma).readTree()).etag,
    );
  });

  it('ignores anything that is not a .yaml file', async () => {
    const dir = tree({ 'default.yaml': 'd\n', 'nodes/a.yaml': 'a\n', 'nodes/notes.txt': 'x\n' });

    expect((await service(dir, fakePrisma().prisma).readTree()).fileCount).toBe(2);
  });

  it('serves an empty tree rather than failing when nothing is materialized yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'enc-bare-'));

    const result = await service(dir, fakePrisma().prisma).readTree();

    expect(result.fileCount).toBe(0);
    expect(result.etag).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('EncReplicationService.recordFetch', () => {
  it('advances lastChangedAt only when data actually moved', async () => {
    const { prisma, upsert } = fakePrisma();
    const svc = service(tree({ 'default.yaml': 'd\n' }), prisma);

    await svc.recordFetch('puppet.corp.local', 'abc', 200);
    await svc.recordFetch('puppet.corp.local', 'abc', 304);

    expect((upsert.mock.calls[0]?.[0] as { update: object }).update).toHaveProperty('lastChangedAt');
    expect((upsert.mock.calls[1]?.[0] as { update: object }).update).not.toHaveProperty(
      'lastChangedAt',
    );
  });

  /*
   * A Puppet server converging on stale classification is worse than a console
   * that cannot report on it, so bookkeeping must never fail the fetch.
   */
  it('does not throw when the database is unreachable', async () => {
    const upsert = jest.fn().mockRejectedValue(new Error('connection refused'));
    const prisma = { encReplicationPeer: { upsert } } as unknown as PrismaService;

    await expect(
      service(tree({ 'default.yaml': 'd\n' }), prisma).recordFetch('p', 'abc', 200),
    ).resolves.toBeUndefined();
  });
});
