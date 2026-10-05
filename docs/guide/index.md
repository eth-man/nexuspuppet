# NexusPuppet

NexusPuppet is a web console and node classifier for Puppet and OpenVox. It shows you every node PuppetDB knows about — facts, run reports, failures — and lets you decide which classes and parameters each node gets. Every classification change is previewed before it is saved, so you see how many machines it touches and what changes on them.

It cannot take your estate down. NexusPuppet writes each node's classification to a file, and your Puppet server reads that file without ever calling NexusPuppet. If the console is stopped, Puppet runs carry on as before.

![The plan review dialog, showing what a classification change would do](../images/plan-review.png)

## Where to start

| Page | Read it when |
|---|---|
| [Install & upgrade](install.md) | You are setting NexusPuppet up, or moving to a new release |
| [Using the console](using.md) | You want a short tour: nodes, classification, reports, searching |
| [Sign-in & users](sign-in.md) | You are adding people, or connecting LDAP, Active Directory or single sign-on |
| [Troubleshooting & support](troubleshooting.md) | Something is not working, or you need to send a support bundle |

These pages cover the common path. The full reference stays in the repository: [DEPLOYMENT.md](../../DEPLOYMENT.md) for every installation option, and the [user guide](../USER_GUIDE.md) for every screen in detail.

## Good to know

- **One product.** Everything is open source under Apache-2.0. There are no editions and nothing to unlock; LDAP/AD, single sign-on, custom roles and audit forwarding are in every install and switched on by configuring them.
- **Read-only towards PuppetDB.** NexusPuppet never writes to PuppetDB.
- **Changes are queued, not instant.** A saved change is written to disk within seconds and reaches a node on its next Puppet run.
- **Works with Puppet and OpenVox** without any configuration change.
