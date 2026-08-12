# ADR-0024 — Reading the class list from puppetserver

- **Status:** Proposed (2026-08-12)
- **Deciders:** Architect
- **Amended:** 2026-08-12 — reference analysis against Foreman and its Smart Proxy; §6 corrected; §7–§9 added.
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

### 6. Revalidation exists, but only if the operator turned it on

An earlier draft of this ADR claimed the documented ETag support "is not
there", from a measurement showing no `ETag` header and `If-None-Match`
answered `200`. **That diagnosis was wrong**, and reading Foreman's Smart Proxy
found the reason. Its retriever carries the comment:

```ruby
cache_used = @m.synchronize { !!@etag_cache[environment] } # etags are only available when classes cache is enabled
logger.warn("Puppet server classes cache is disabled, classes retrieval can be slow.") unless cache_used
```

ETags are gated on **`environment-class-cache-enabled`** in
`puppetserver.conf`, which is **off by default**. Verified both ways on the
same server:

| `environment-class-cache-enabled` | `ETag` header | `If-None-Match` |
| --- | --- | --- |
| absent (default) | none | `200` |
| `true` | `ETag: 397d5af6…` | `304` |

So the design must work **without** revalidation and merely go faster with it.
We cache on our side regardless, treat an `ETag` as an optimisation when
present, and never require the operator to change `puppetserver.conf`.

**Enabling it is not free, and we do not recommend it lightly.** With the class
cache on, Puppet Server stops noticing new code until its environment cache is
flushed — see §8.

### 7. Environment awareness is a correctness requirement, not a nicety

`environment_classes` is per-environment. Classes, their parameters, and their
defaults all differ between environments, and a group may set its own
`environment` while others inherit.

- The cache is keyed **by environment**, never global. Foreman's Smart Proxy
  does the same (`@etag_cache[environment]`, `@classes_cache[environment]`),
  and so does its importer, which walks environments one at a time.
- The picker shows the classes of the environment **that group will actually
  use** — its own `environment` when set, otherwise the deployment default.
- The environment in force is **named in the UI** beside the suggestions.

Showing `production`'s classes to a group pinned to `development` is
confidently wrong in the way that is hardest to notice: every name looks
plausible, and the failure appears later as a compile error on the nodes that
group matches.

### 8. Staleness must be bustable from the console — the r10k problem

An operator who has just pushed Puppet code wants to classify it **now**. A
cache that makes them wait, with no way to force the issue, is worse than no
cache: it turns a five-second task into a support question.

So: a **Refresh** control beside the class field, which discards our cached
entry for that environment and refetches. This is the single most important
usability decision in this ADR, and it comes straight from watching where
Foreman users get stuck — Foreman requires an explicit *Import environments*
run before newly deployed classes can be assigned at all.

**There may be two caches, and only one is ours.** If the operator has enabled
`environment-class-cache-enabled` (§6), Puppet Server holds its own class cache
and will keep serving pre-deployment classes until its environment cache is
flushed — normally by r10k or Code Manager calling
`DELETE /puppet-admin-api/v1/environment-cache`, or by `environment_timeout`
expiring.

**We do not call that endpoint.** It is a second endpoint and a mutation, and
§2 says one read-only call. Instead, when a refresh returns a byte-identical
list, the UI says so plainly and names the likely cause, rather than silently
appearing to have worked:

> Refreshed — the class list is unchanged. If you have just deployed code, your
> Puppet server may still be serving its cached environment.

That sentence is the difference between an operator learning something and an
operator filing a bug against us for someone else's cache.

### 9. The UI must never hard-lock

Every failure mode ends in the operator still being able to save the
classification they came to make.

| condition | behaviour |
| --- | --- |
| `PUPPETSERVER_URL` unset | silent; today's free-text field, no prompts |
| `403` (no `auth.conf` rule) | free text, with the reason and the rule to add |
| timeout / `50x` / TLS failure | free text, with the error and a Retry |
| class not in the list | accepted, marked unknown, never blocked |
| parameters unavailable for a class | the JSON textarea, exactly as today |

The parameter form is **an enhancement over the JSON textarea, never a
replacement for it**. The textarea remains reachable for every class at all
times — including classes we know perfectly well — because a parameter taking a
structure our form cannot express must never become unassignable.

A failed fetch is a **degraded suggestion**, never a failed write. Nothing on
this path may return an error that prevents `assign-class` from being
submitted.

## Prior art: Foreman

Read rather than recalled — `theforeman/foreman_puppet` and
`theforeman/smart-proxy` at HEAD, 2026-08-12. Foreman has run this exact
integration in production for over a decade, and most of the decisions above
are theirs.

### What we take

**Per-environment caching with request coalescing.** Smart Proxy keys every
cache by environment and holds a `@futures_cache` so concurrent requests for
the same environment share one in-flight fetch rather than stampeding a server
that may take minutes to answer. We do the same.

**Tiered timeouts that admit the uncached case is slow.**
`DEFAULT_CLIENT_TIMEOUT = 15` when a cache entry exists, a longer configured
timeout when not, and `MAX_PUPPETAPI_TIMEOUT = 300` upstream. An uncached fetch
on a large estate is a *minutes* operation, and a design that assumes otherwise
will time out in exactly the deployments that most need it.

**Operator intent outranks imported metadata.** Foreman's importer proposes a
new default only `if !p.override`, and `update_parameter` does
`next unless key.override == false`. Once a human has taken control of a
parameter, an upstream default change never silently overwrites it.

This is binding for us: **a refetched class signature never rewrites an
assigned parameter value.** Fetched metadata drives the form's shape and its
placeholder defaults, and nothing else. What we store is what the operator
chose.

**A default may be an expression, not a value.** Smart Proxy rewrites a
`default_source` beginning with `$` into `${…}`, because such a default
references another variable and is not a literal at all. A form that prefills
it as a string would be quietly wrong; the field is left empty with the source
shown as a hint.

**`default_literal` and `default_source` are different things.**
`default_literal` is the parsed value and is absent for non-literal defaults;
`default_source` is the raw manifest text. Absence of both means the parameter
is **required** — which is how `pubkey` is distinguished from `users` in the
measured response.

**Per-file errors are normal.** An entry in `files[]` may carry an `error` key
instead of `classes` when a manifest fails to parse. Foreman passes those
through rather than failing the request. So must we: one broken manifest must
not blank the whole picker, and the affected file should be named.

### What we deliberately do not take

**The import model.** Foreman *imports* classes into its own database as
first-class records, then reconciles with a reviewable
`new / obsolete / updated / ignored` diff. That is the right design for
Foreman, which builds Smart Class Parameters, override hierarchies and
validators on top of the imported metadata.

It is the wrong design here. We need a *suggestion*, not a second source of
truth to keep in sync. Importing would add a reconciliation surface, a
destructive edge, and a mandatory step between deploying code and being able to
classify it — the very friction §8 exists to avoid.

**The Smart Proxy hop.** Foreman reaches puppetserver through a separate
service. We already hold a Puppet-CA-signed certificate and can call the
endpoint directly; adding a proxy would add a component to deploy for no gain.

### The pitfall we are avoiding outright

Foreman's `remove_classes_from_foreman` destroys classes and **unassigns them
from hosts** (`HostClass … destroy_all`) with no guard against a truncated or
failed fetch. Nothing in the code distinguishes "this environment genuinely has
fewer classes now" from "the fetch went wrong" — the operator reviewing the
diff *is* the safety mechanism, which holds only because import is manual.

We have seen this shape before and already ruled on it: `NodeProjectionService`
refuses to prune when PuppetDB returns implausibly little, because a partial
fetch and a shrunken estate look identical. The same reasoning applies here and
is easier to honour, because **we never delete anything**. A failed or partial
fetch degrades the suggestion list; it can never remove an assigned class,
because assignments do not live in the fetched data at all.

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

**The first fetch in an environment may be slow, and must say so.** Without
`environment-class-cache-enabled` on the Puppet server, every fetch reparses
the environment. Foreman logs a warning for precisely this. The picker shows a
loading state that names what it is waiting for rather than a bare spinner, and
the tiered timeouts of §8 apply.

**We are choosing not to solve the two-cache problem, only to explain it.** An
operator running r10k with the server-side class cache enabled and no
environment-cache flush will refresh and see nothing change. §8 makes that
legible instead of mysterious. Solving it properly means calling
`puppet-admin-api`, which is a mutation this ADR forbids — if that ever becomes
necessary it is a superseding decision, not an extension.
