import type { IEncFileWriter } from '@nexuspuppet/contracts';
import { ReconcilerService } from './reconciler.service';
import type { MaterializerService, DrainResult } from './materializer.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Revision stamping (ADR-0022 §2).
 *
 * These cover the drain path only — it needs no database, and it is where the
 * decisions worth protecting live: WHEN the tree gets named, and what happens
 * when naming it fails.
 */
describe('ReconcilerService revision stamping', () => {
  const drainResult = (filesChanged: number): DrainResult => ({
    claimed: filesChanged,
    succeeded: filesChanged,
    failed: 0,
    filesChanged,
    ranHere: true,
  });

  function build(options: {
    filesChanged: number;
    revision?: () => Promise<string>;
    onWrite?: (revision: string) => Promise<void>;
  }) {
    const written: string[] = [];

    const writer = {
      writeRevision: async (revision: string) => {
        if (options.onWrite) await options.onWrite(revision);
        written.push(revision);
      },
    } as unknown as IEncFileWriter;

    const materializer = {
      drain: async () => drainResult(options.filesChanged),
    } as unknown as MaterializerService;

    const reconciler = new ReconcilerService(
      {} as unknown as PrismaService,
      materializer,
      writer,
      60_000,
      60_000,
      options.revision ?? (async () => 'rev-abc'),
    );

    return { reconciler, written };
  }

  it('names the tree after a drain that changed files', async () => {
    const { reconciler, written } = build({ filesChanged: 3 });

    await reconciler.tick();

    expect(written).toEqual(['rev-abc']);
  });

  /*
   * The drain runs every two seconds forever. Computing the identity reads
   * every file in the tree, so stamping on an idle tick would turn a no-op into
   * a full tree read on a loop — on a large estate, permanently.
   */
  it('does not touch the tree when a drain changed nothing', async () => {
    const { reconciler, written } = build({ filesChanged: 0 });

    await reconciler.tick();

    expect(written).toEqual([]);
  });

  /*
   * Receipts are droppable (ADR-0022 §5). Classification delivery is not. A
   * tree that materialized correctly must never be reported as failed because
   * it could not be named — and tick() must stay re-entrant afterwards, or one
   * failure would wedge the drain loop for good.
   */
  it('survives a revision that cannot be computed', async () => {
    const { reconciler, written } = build({
      filesChanged: 1,
      revision: async () => {
        throw new Error('tree unreadable');
      },
    });

    await expect(reconciler.tick()).resolves.toBeUndefined();
    expect(written).toEqual([]);

    // Not wedged: the guard was released, so the next tick still runs.
    await expect(reconciler.tick()).resolves.toBeUndefined();
  });

  it('survives a revision that cannot be written', async () => {
    const { reconciler, written } = build({
      filesChanged: 1,
      onWrite: async () => {
        throw new Error('read-only volume');
      },
    });

    await expect(reconciler.tick()).resolves.toBeUndefined();
    expect(written).toEqual([]);
  });

  /*
   * ORDER IS THE POINT. The stamp must land after the files, so the window
   * between them under-claims — a receipt taken mid-drain names the OLDER
   * revision and the node reads as behind. Stamping first would make a node
   * claim a revision it had not received yet, turning a visible lag into an
   * invisible lie.
   */
  it('stamps after the files, never before', async () => {
    const order: string[] = [];

    const writer = {
      writeRevision: async () => {
        order.push('stamp');
      },
    } as unknown as IEncFileWriter;

    const materializer = {
      drain: async () => {
        order.push('files');
        return drainResult(1);
      },
    } as unknown as MaterializerService;

    const reconciler = new ReconcilerService(
      {} as unknown as PrismaService,
      materializer,
      writer,
      60_000,
      60_000,
      async () => 'rev-abc',
    );

    await reconciler.tick();

    expect(order).toEqual(['files', 'stamp']);
  });
});
