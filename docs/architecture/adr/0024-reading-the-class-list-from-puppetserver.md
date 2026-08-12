# ADR-0024 — Reading the class list from puppetserver

- **Status:** Proposed (2026-08-12)
- **Deciders:** Architect
- **Related:** [ADR-0003](./0003-enc-generate-dont-serve.md) (this is the opposite direction, and that is the whole argument), [ADR-0004](./0004-puppetdb-read-only-mtls.md) (the pattern this follows), [ADR-0013](./0013-console-tls.md)

## Context

Assigning a class means typing its name from memory. The field is free text
with a `profile::base` placeholder, and NexusPuppet has no idea what exists in
the operator's modulepath.

The cost of a typo is not a validation message. `node_terminus = exec` has **no
fallback to `site.pp`**, so a class that does not exist fails catalog
compilation for every node the group matches:

```
Error: Could not retrieve catalog from remote server: Error 500 on SERVER:
  Server Error: Evaluation Error: Error while evaluating a Function Call,
  Could not find declared class profile::base
```

The parameters are worse. They are a free-form JSON box. An operator assigning
a class must already know its parameter names, their types, and which are
required — from reading the manifest, in another window, on another host. A
misspelt key is not rejected either; it is passed to Puppet, which fails the
compile.

An operator reported this directly: *"I would like to list them, not guess what
I have in puppet server."*

## Two sources exist, and only one answers the question

**PuppetDB `resources[title] { type = "Class" }`** returns every class present
in a compiled catalog. It costs nothing new — the mTLS client already exists,
`PuppetDbClient.query()` is already generic over `/pdb/query/v4`, and it is
squarely inside ADR-0004.

It also cannot answer the question that was asked. It knows only what is
already **in use**. A module installed but never assigned is invisible, which
is exactly the case an operator needs help with: they are about to assign it
for the first time. And it carries no parameters at all.

**puppetserver `/puppet/v3/environment_classes?environment=<env>`** returns
every class in the environment, with parameter names, Puppet type signatures
and default values. It is the same API Puppet Enterprise's own classifier uses,
and it is present in open-source Puppet and OpenVox.

Measured against OpenVox puppetserver 8.15.2 (Puppet 8.28.1) rather than taken
from documentation:

```json
{
  "name": "jump_access",
  "params": [
    { "name": "pubkey", "type": "String[1]" },
    { "name": "users",  "type": "Array[String[1]]",
      "default_literal": ["root"], "default_source": "[\"root\"]" },
    { "name": "ensure", "type": "Enum['absent', 'present']",
      "default_literal": "present", "default_source": "\"present\"" },
    { "name": "target", "type": "Optional[String[1]]", "default_source": "undef" }
  ]
}
```

That is enough to stop guessing entirely: a parameter with no `default_*` is
**required**; an `Enum` carries its own option list; an `Array` wants a list
input. The JSON box can become a form.

## Decision

**Read `/puppet/v3/environment_classes` from puppetserver, read-only, as a
suggestion source that the console degrades without.**

### 1. This is not the dependency ADR-0003 forbids

ADR-0003 is **directional**: nothing may make *Puppet* depend on *NexusPuppet*
at runtime. The failure it prevents is an agent run blocked on this console
being up.

This is the other direction. NexusPuppet reads from puppetserver, out of band,
to populate a form. If puppetserver is unreachable, the field falls back to
free text and every existing classification continues to materialize. If
NexusPuppet is down, agent runs are unaffected exactly as before — the compile
path is still `cat` on a local file with no process of ours in it.

The direction is the whole argument, and it is why this needs an ADR rather
than being assumed safe by analogy with ADR-0004.

### 2. Read-only, one endpoint, and no write surface may be added

As with PuppetDB (ADR-0004), the client exposes exactly one call. There is no
general puppetserver client, no catalog compilation, no CA access, no
environment deployment. A future need for a second endpoint is a superseding
ADR, not a new method.

### 3. It reuses the PuppetDB client certificate

The certificate NexusPuppet already holds is signed by the Puppet CA and is
already trusted by puppetserver's TLS. Nothing new is issued, distributed or
rotated.

**This grants nothing on its own.** `auth.conf` denies the endpoint by default
— verified: the request is refused with `403 Forbidden request:
/puppet/v3/environment_classes` even when made with the Puppet server's *own*
certificate, because no rule matches and `puppetlabs deny all` at sort-order
999 catches it.

Access requires the operator to add a rule naming our certname:

```hocon
{
    match-request: {
        path: "/puppet/v3/environment_classes"
        type: path
        method: get
    }
    allow: "nexuspuppet.example.com"
    sort-order: 400
    name: "nexuspuppet environment classes"
}
```

That the operator must opt in **by editing their Puppet server** is a feature,
not friction to be designed away. It keeps the blast radius of our certificate
where ADR-0004 already put it: bounded by what the Puppet side chose to grant.

### 4. Absent configuration is the default, and it is silent

`PUPPETSERVER_URL` unset means the feature is off: no client is constructed, no
connection attempted, and the class field behaves exactly as it does today. An
operator who never wants NexusPuppet talking to their Puppet server does
nothing and is never nagged.

### 5. It never blocks a write

The class name field stays a **combobox, never a closed list**. A class an
operator is about to write does not exist yet, and refusing it would be worse
than the guessing this replaces. Unknown entries are marked unknown and
accepted.

The same applies to the parameter form: it renders from the fetched signature
when available, and the raw JSON escape hatch remains, always. A class whose
parameters we could not fetch is assigned exactly as it is today.

This is not a validation feature. It is a suggestion feature that happens to
prevent most typos.

### 6. Caching is ours, because the documented revalidation is not there

Puppet's documentation describes ETag / `If-None-Match` support on this
endpoint. **OpenVox puppetserver 8.15.2 returns no `ETag` header**, and a
request carrying `If-None-Match` is answered `200`, not `304` — measured, not
assumed.

So the design must not depend on revalidation. A short TTL cache in the API,
refreshed on demand, with the fetch time shown in the UI. The list being a few
minutes stale is harmless; a class list that is authoritative-looking and
silently wrong is not, which is why the age is displayed rather than hidden.

### 7. The environment is a parameter, not a global

`environment_classes` is per-environment, and a group may set its own
`environment`. The suggestions shown must be for the environment that group
will actually use, falling back to `production` when the group inherits. Showing
`production`'s classes to a group pinned to `development` would be confidently
wrong in the way that is hardest to notice.

## Consequences

**The parameter form is the real prize.** Knowing names, types and defaults
turns the most error-prone box in the product into a form that cannot be
misspelt. That, not the class list, is what justifies the coupling.

**A second Puppet-side dependency now exists in deployment.** It is optional
and degrades cleanly, but `DEPLOYMENT.md` grows a section, and an operator who
enables it and later tightens `auth.conf` will see suggestions vanish. The UI
must say *why* — an empty list and a 403 must not look alike.

**We inherit puppetserver's view of "exists".** A class present in the
environment but broken at compile time still lists. This narrows the failure
from "misspelt name" to "genuinely broken manifest", and does not claim to
eliminate it.

**Estates with many environments will want more than this.** Fetching per
environment on demand is the scope here; a cross-environment index is not, and
should not be added by accretion.
