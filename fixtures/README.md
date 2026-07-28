# Fixtures

## What is here

**Captured from a real Puppet estate** by
[`scripts/capture-fixtures.mjs`](../scripts/capture-fixtures.mjs):

| File | Endpoint | Contents |
|---|---|---|
| `factset-single-node.sample.json` | `/pdb/query/v4/factsets` | One node's complete factset — **114 facts**, captured |
| `report-success.sample.json` | `/pdb/query/v4/reports` | A real `changed` run, 2 resource events |
| `report-failure.sample.json` | `/pdb/query/v4/reports` | A real `failed` run, 4 events including a genuine resource failure |
| `nodes-query.sample.json` | `/pdb/query/v4/nodes` | 50 node rows — real field shape, synthesised estate (see below) |

Re-capture with the local estate running:

```bash
sudo ./scripts/dev/puppet-stack.sh          # if it is not already up
node scripts/capture-fixtures.mjs
```

## What is captured and what is not

Being exact about this matters more than the fixtures do, because the last
failure here came from believing invented data was observed.

| | origin |
|---|---|
| **factsets** | 100% captured. Only five hardware identifiers are masked — `uuid`, `serialnumber`, `boardserialnumber`, `macaddress`, `macaddress_eth0` — each to a value of the same shape. |
| **reports** | 100% captured, both statuses, including real resource events, metrics and Puppet's own error wording. |
| **nodes** | Field names, types and value formats are captured from a real node row, and the first entry is that row verbatim. The **estate** is synthesised: one node cannot be simultaneously deactivated, expired and stale, and the inventory has to render all three. Which node is in which state is ours; every field shape is observed. |

A re-capture is a new **snapshot** and will legitimately differ — timestamps
move, facts change. That is the opposite of the old generator's byte-identical
guarantee, and the difference is the point.

## Why the synthetic fixtures were replaced

They were generated from the PuppetDB 8 API documentation. They encoded our
reading of the docs, the test suite then encoded them, and a wrong assumption
became self-confirming: the code agreed with the fixture, the fixture agreed
with the code, and nothing agreed with Puppet.

That cost a real bug. The synthetic factset invented `role`, `rack_position` and
`maintenance_window`, and carried `fqdn` and `domain`. Three of those names
reached the default `PUPPETDB_PROJECTED_FACTS`, so a classification rule written
against `role` matched nothing on any real estate — silently, because a rule
evaluated against an absent fact is indistinguishable from one that legitimately
matches nothing.

The gap was not subtle once measured:

- synthetic factset: **23 facts**. Real node: **114**.
- the real node row carries `cached_catalog_status` and
  `latest_report_corrective_change`; the synthetic one never had them, so the
  mapper had not once seen them in the life of the project.
- the synthetic "failed" report contained only interesting events. A real failed
  run reports its **successful** resources too — so the report view's most
  common case, "mostly fine except this one thing", was never exercised.

The previous version of this file warned about exactly this, under a heading
reading "These are synthetic": *"which custom facts exist, and therefore whether
`PUPPETDB_PROJECTED_FACTS` covers the facts operators will actually write
matching rules against. A rule referencing an unprojected fact can never
match."* The warning was correct and was not enough. Documenting a hazard does
not remove it.

## What the captured data does and does not prove

It is one node, on one OS, from one agent version. It proves the shapes are
real. It does not prove the estate is representative, and these remain open:

- **Scale.** 50 rows derived from one node say nothing about how a 1,000-node
  estate with large custom facts stresses pagination and projection.
- **Fact diversity.** `os.family` here is `Debian`; a RedHat or Windows estate
  will exercise paths this capture does not.
- **Agent version.** This capture comes from puppet-agent **7.20**, which still
  emits the legacy flat facts `fqdn` and `domain`. Puppet 8 and OpenVox agents
  do **not** — they report ~31 top-level facts where this one reports 114. That
  difference is why neither name is in the shipped `PUPPETDB_PROJECTED_FACTS`
  default.
- **`role` is present here only because we supply it.** It is not a Facter fact.
  `scripts/dev/puppet-code/.../profile/facts.d/` provides it for the development
  estate; nothing supplies it on a stock installation.

## Committing real data

Everything here is gitignored except `*.sample.json`.

Real facts and reports contain hostnames, IP addresses, and sometimes
credentials in resource titles or error messages. The capture script masks known
hardware identifiers, but it cannot know what a custom fact or an error message
in *your* estate contains. **Read a capture before committing it.** Keep the
shape, cardinality and size honest while you do.

## What has been verified against these

- `apps/api/src/puppetdb/puppetdb.mapper.spec.ts` — every mapper, including the
  deactivated and expired states, real failure events and report metrics.
- `apps/api/test/node-projection.int-spec.ts` — projection, pruning and rule
  matching against the captured estate.
- The mTLS client path end to end, against a local HTTPS server that requires
  client certificates and serves these files.
- Separately, and not from these files: the real `PuppetDbClient` against both a
  live PuppetDB 7.10 and a live openvoxdb 8.15 — see
  `scripts/dev/openvox-compat.sh`.
