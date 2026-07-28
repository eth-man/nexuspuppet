# External facts for the development estate

`role.txt` supplies the `role` fact.

## Why this exists

`role` is the roles-and-profiles pattern: a node declares what it *is*, and
classification follows from that rather than from incidental hardware or OS
details. It is a perfectly good thing to write a rule against — but **`role` is
not a Facter fact**. Nothing supplies it unless you do.

That gap had a real consequence here. The `nginx-servers` group was created with
the rule `role EQUALS "web"`, `role` was in `PUPPETDB_PROJECTED_FACTS`, and the
group classified nothing from the day it was written. Nothing reported an error,
because a rule evaluating against a fact that is absent is indistinguishable
from a rule that legitimately matches nothing. It was found only by comparing
the projected list against what a real node reports.

`role` is no longer in the shipped default for exactly that reason — most
estates do not supply it. Adding it to *this* deployment's
`PUPPETDB_PROJECTED_FACTS` is the documented workflow, not a reversal: add the
custom facts **your** estate actually reports.

## How it reaches PuppetDB

Puppet pluginsyncs `<module>/facts.d/` to `/opt/puppetlabs/facter/facts.d/` on
each agent, Facter reads it as an external fact, and the agent submits it with
the rest of its factset. No NexusPuppet code is involved: this is the ordinary
Puppet path, which is the point — the console reads what Puppet produces
(ADR-0004).

## Scope

This applies `role=web` to **every** node syncing the `profile` module, which is
fine for a one-agent development estate and wrong for anything larger. A real
estate sets `role` per node — from a provisioning template, Hiera, or a trusted
certificate extension — rather than from a file shared by every node.
