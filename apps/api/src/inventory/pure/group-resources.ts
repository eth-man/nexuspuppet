import type { ResourceGroup, ResourceSummary, ResourceVariant } from '@nexuspuppet/contracts';

/**
 * Turn a flat resource list into the consistency view (ADR-0025 §7, §8).
 *
 * PURE: no I/O, no clock, no randomness. The ordering below is fully determined
 * by the input, which is what makes it testable and what stops the same estate
 * rendering in a different order on each refresh.
 *
 * THE WHOLE IDEA. PuppetDB's `resource` field is a SHA-1 over type, title AND
 * parameters, so two nodes sharing it have byte-identical parameters. Counting
 * distinct hashes therefore establishes agreement WITHOUT a single parameter
 * crossing the wire — which is what lets ADR-0025 §4 (never fetch parameters
 * into a list) and the consistency view coexist. Without that property they are
 * directly opposed.
 */

/**
 * How many certnames a variant carries.
 *
 * The point of the list is naming the odd ones out — "which three nodes
 * disagree" — and a variant covering four hundred nodes answers that with its
 * count, not by listing four hundred names into the browser.
 */
export const MAX_CERTNAMES_PER_VARIANT = 25;

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Group by type, title and environment.
 *
 * ENVIRONMENT IS PART OF THE KEY, and that is the load-bearing detail. A node
 * in `development` and a node in `production` legitimately carry different
 * parameters, and folding them into one group would report variance on
 * essentially every resource in a two-environment estate. ADR-0021 already
 * records where that leads: the channel gets muted, and takes the alert that
 * mattered with it.
 */
function keyOf(resource: ResourceSummary): string {
  // Tab-separated: a tab cannot appear in a resource type or an environment
  // name, so no title can forge a collision with a different group.
  return `${resource.type}\t${resource.title}\t${resource.environment}`;
}

export function groupResources(resources: readonly ResourceSummary[]): ResourceGroup[] {
  const groups = new Map<string, ResourceSummary[]>();

  for (const resource of resources) {
    const key = keyOf(resource);
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [resource]);
    } else {
      bucket.push(resource);
    }
  }

  const result: ResourceGroup[] = [];

  for (const members of groups.values()) {
    // Safe: a bucket only exists because something was pushed into it.
    const first = members[0] as ResourceSummary;

    const byHash = new Map<string, ResourceSummary[]>();
    for (const member of members) {
      const bucket = byHash.get(member.resourceHash);
      if (bucket === undefined) {
        byHash.set(member.resourceHash, [member]);
      } else {
        bucket.push(member);
      }
    }

    const variants: ResourceVariant[] = [...byHash.entries()]
      .map(([resourceHash, carriers]) => {
        const certnames = carriers.map((c) => c.certname).sort(compareStrings);
        return {
          resourceHash,
          nodeCount: carriers.length,
          // The FIRST certname alphabetically, not an arbitrary one. Expanding
          // the same variant twice must fetch the same node's parameters, or
          // two operators comparing notes see different values for what the
          // console told them was one variant.
          sampleCertname: certnames[0] as string,
          certnames: certnames.slice(0, MAX_CERTNAMES_PER_VARIANT),
        };
      })
      // Largest variant first: the majority configuration is the baseline, and
      // the minority ones underneath it are what the operator came to find.
      .sort((a, b) => b.nodeCount - a.nodeCount || compareStrings(a.resourceHash, b.resourceHash));

    result.push({
      type: first.type,
      title: first.title,
      environment: first.environment,
      nodeCount: members.length,
      variantCount: variants.length,
      variants,
      file: first.file,
      line: first.line,
    });
  }

  /*
   * INCONSISTENT FIRST. This is the entire reason the screen exists: 190
   * identical rows hide the three that differ, and an operator scrolling to
   * find them is doing the work the console was supposed to do.
   *
   * Then by node count descending, so a disagreement affecting the whole estate
   * outranks one affecting a pair. Then alphabetically, so the order is total
   * and the same input always renders the same way.
   */
  return result.sort(
    (a, b) =>
      b.variantCount - a.variantCount ||
      b.nodeCount - a.nodeCount ||
      compareStrings(a.title, b.title) ||
      compareStrings(a.environment, b.environment),
  );
}
