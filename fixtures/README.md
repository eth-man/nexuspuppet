# Fixtures

## What is here

Synthetic PuppetDB responses, generated from the **PuppetDB 8 query API v4
documentation** by [`scripts/generate-fixtures.mjs`](../scripts/generate-fixtures.mjs):

| File | Endpoint | Contents |
|---|---|---|
| `nodes-query.sample.json` | `/pdb/query/v4/nodes` | 50 nodes: mixed environments and statuses, one deactivated, one expired, two stale |
| `factset-single-node.sample.json` | `/pdb/query/v4/factsets` | One node's full fact set, including structured `os`, `networking`, `memory`, `processors` |
| `report-success.sample.json` | `/pdb/query/v4/reports` | A `changed` run with two successful resource events |
| `report-failure.sample.json` | `/pdb/query/v4/reports` | A `failed` run: one package failure, two dependent resources skipped, one noop |

Regenerate with:

```bash
node scripts/generate-fixtures.mjs
```

Output is deterministic — a seeded PRNG and a fixed base instant — so
regenerating produces byte-identical files and never shows up as a spurious
diff.

## ⚠️ These are synthetic

They encode **our reading of the documentation**, not an observed estate.

They are sufficient to build and test against. They are **not** evidence that
the client works against real infrastructure. Specifically, they cannot tell us:

- what the estate's actual fact cardinality and payload size look like — a
  1,000-node estate with large custom facts will stress pagination and the fact
  projection in ways 50 synthetic nodes do not;
- which custom facts exist, and therefore whether `PUPPETDB_PROJECTED_FACTS`
  covers the facts operators will actually write matching rules against. A rule
  referencing an unprojected fact can never match;
- whether the PuppetDB version in use returns fields this project has not
  anticipated. The mappers degrade unknown values to `unknown` rather than
  throwing, so a surprise should be visible rather than fatal — but "visible"
  still means somebody has to look.

**When real data arrives, re-run the mapper tests against it before trusting the
inventory screens.** That is the moment to find out whether the assumptions
above hold.

## Committing real data

Everything in this directory is gitignored except `*.sample.json`.

Real facts and reports contain hostnames, IP addresses, and sometimes
credentials in resource titles or error messages. Only commit files you have
anonymized and named `*.sample.json`.

Anonymize the values, but keep the shape, cardinality, and size honest. A
3-node fixture will not surface the pagination and rendering problems a
1,000-node estate has.

## What has been verified against these

- `apps/api/src/puppetdb/puppetdb.mapper.spec.ts` — every mapper, including the
  deactivated/expired states and the null-heavy skipped events.
- The mTLS client path, end to end, against a local HTTPS server that requires
  client certificates and serves these files.
