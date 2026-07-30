import { Injectable } from '@nestjs/common';
import type { ClassificationConflict, ConflictReport } from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { aggregateConflicts, type NodeConflicts } from './pure/aggregate-conflicts';

/**
 * The estate-wide conflict report ADR-0009 promised and never shipped.
 *
 * Every conflict here was already computed and stored when the node was
 * materialized, so this adds no interpretation — it reads and folds.
 *
 * NO RAW SQL. Aggregating in Postgres with `jsonb_array_elements` would be
 * tidier arithmetic, but `PrismaService` states that raw SQL exists there for
 * advisory locks and nowhere else, and quietly widening that for a reporting
 * convenience is how such rules stop meaning anything. The filter below still
 * runs in Postgres; only the fold happens here, over rows that are a small
 * fraction of the estate.
 */
@Injectable()
export class ConflictReportService {
  /** Rows per round trip. Bounds memory without making the scan chatty. */
  private static readonly CHUNK = 500;

  constructor(private readonly prisma: PrismaService) {}

  async report(): Promise<ConflictReport> {
    const nodesMaterialized = await this.prisma.encMaterialization.count();

    const rows: NodeConflicts[] = [];
    let cursor: string | undefined;

    // Keyset paging on certname, which is the primary key — no OFFSET, so cost
    // does not climb as the scan advances.
    for (;;) {
      const page = await this.prisma.encMaterialization.findMany({
        // Pushed down to Postgres. On a healthy estate most nodes have no
        // conflicts at all, so this is the difference between reading a handful
        // of rows and reading every node in the estate.
        where: { conflicts: { not: [] } },
        select: { certname: true, conflicts: true },
        orderBy: { certname: 'asc' },
        take: ConflictReportService.CHUNK,
        ...(cursor === undefined ? {} : { cursor: { certname: cursor }, skip: 1 }),
      });

      if (page.length === 0) break;

      for (const row of page) {
        rows.push({
          certname: row.certname,
          // Stored as JSON, written by the merger. A row that is not an array
          // is a corrupted write rather than something to reason about, and
          // treating it as "no conflicts" keeps one bad row from failing the
          // whole report.
          conflicts: Array.isArray(row.conflicts)
            ? (row.conflicts as unknown as ClassificationConflict[])
            : [],
        });
      }

      if (page.length < ConflictReportService.CHUNK) break;
      cursor = page[page.length - 1]?.certname;
    }

    return {
      conflicts: aggregateConflicts(rows),
      nodesAffected: rows.filter((r) => r.conflicts.length > 0).length,
      nodesMaterialized,
    };
  }
}
