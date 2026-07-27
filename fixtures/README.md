# Fixtures

Drop the artifacts requested in `/INTAKE.md` §B here:

- `node-facts.sample.json` — one node's full facts
- `report-success.sample.json` — one successful run report
- `report-failure.sample.json` — one failed run report
- `nodes-query.sample.json` — `puppet-query 'nodes[certname, report_timestamp] {}'`, ~50 rows

## Anonymize before committing

Everything in this directory except `*.sample.json` is gitignored, because real
facts and reports contain hostnames, IP addresses, and sometimes credentials in
resource titles. Only commit files you have anonymized and named `*.sample.json`.

Design and test quality are bounded by data realism — anonymize the values, but
keep the shape, cardinality, and size honest. A 3-node fixture will not surface
the pagination and rendering problems a 1,000-node estate has.
