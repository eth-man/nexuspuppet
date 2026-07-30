# Lessons

Mistakes this project has actually made, what each one cost, and what to do
instead. Every entry links to the commit or pull request where it happened —
none of this is hypothetical, and a lesson without a scar is just an opinion.

Read it before a first substantive change. Most of these were expensive.

---

## 1. Things look correct precisely because nothing ran them

The single recurring failure here. In every case the code was plausible, the
tests were green, and the feature had never once been exercised.

| What shipped | How it was found |
| --- | --- |
| `AUTH_PROVIDER`, `ENC_FILE_WRITER`, `AUDIT_SINK` seams declared and never resolved | An audit of the DI graph |
| The projected-fact warning read `process.env` directly, so it silently disabled itself on the default configuration | Reading it while fixing something else |
| An OIDC route used `request.cookies`, which this app never populates — fifteen tests passed because the fake request supplied what the app does not | Driving a real Keycloak login |
| A `COPY` from a build stage that never contained the file, so the image did not build | A production install ([#32](https://github.com/eth-man/nexuspuppet/pull/32)) |
| A container healthcheck pointed at `localhost` while Next.js standalone binds `$HOSTNAME`, so it failed forever while the service worked | Something finally depended on it ([#37](https://github.com/eth-man/nexuspuppet/pull/37)) |

**Do instead.** Before claiming a seam works, run it: log in through the real
provider, build the image, start the container, watch the healthcheck go green.
A test that constructs its own inputs proves the test agrees with itself.

---

## 2. Verify before documenting, not after

Three separate corrections were needed because a plausible claim went into a
document unmeasured.

- A deployment report suggested replacing `auth.conf` guidance with
  `certificate-whitelist`. Trying it first was the only reason we learned it is
  **not a valid key in OpenVoxDB 8** — the container refuses to start. Following
  the suggestion would have shipped operators a change that takes PuppetDB down
  ([#27](https://github.com/eth-man/nexuspuppet/pull/27)).
- The `ca generate` note was rewritten to say the spurious error means "your CA
  does not autosign". A live install saw it on an **autosigning** CA. The
  measurement was real but partial: one configuration, generalised
  ([#30](https://github.com/eth-man/nexuspuppet/pull/30), corrected in
  [#33](https://github.com/eth-man/nexuspuppet/pull/33)).
- A `pg` deprecation was "fixed" by rewriting a `Promise.all` over a transaction
  client. Measured before and after: **6 warnings either way**. Probing each
  shape showed `Promise.all` over a transaction does not warn at all — the
  trigger is Prisma's own relation loading. The fix fixed nothing
  ([#30](https://github.com/eth-man/nexuspuppet/pull/30)).

**Do instead.** If a sentence in a document asserts behaviour, run the thing
first. If it cannot be run here, say so in the text rather than implying it was
checked.

---

## 3. The deployment path is the least tested code you ship

Every defect found by two real installs was in the deployment path — the image,
the Compose environment, certificate ownership, the documentation — and **none**
was in the application. Five CI jobs and hundreds of tests found none of them,
because none of them lives in the source tree.

`scripts/ci/install-smoke.sh` now runs the literal commands from `DEPLOYMENT.md`
and asserts the bootstrap admin can log in. Its **first run caught the real
`COPY` bug**, on a branch cut before the fix, while every other job on the same
run passed.

**Do instead.** When you change `Dockerfile`, `docker-compose.yml`,
`.env.example` or a documented procedure, run the procedure.

---

## 4. A test that passes can still be wrong

Passing is not the same as correct, and several tests here were both.

- The README screenshot script passed while capturing the flagship feature
  reporting **"0 nodes affected"** — an unscoped `getByLabel('Value')` had filled
  the parameters editor instead of the rule row. The test was green; the picture
  was a lie ([#41](https://github.com/eth-man/nexuspuppet/pull/41)).
- A guard asserting `"newly classified"` **rejected a perfectly good plan**,
  because the nodes were already classified and the plan correctly said
  "changed".
- A certificate test captured its reference timestamp at module load, before
  generating certificates. It passed locally and failed on a slower runner —
  a race, not a bug ([#37](https://github.com/eth-man/nexuspuppet/pull/37)).
- A `@screenshots` tag was assumed to keep a spec out of CI. `playwright test
  --list` showed both tests in the default run; the tag excludes nothing.

**Do instead.** Look at the artifact, not the exit code. For anything producing
an image, a document or a file, open it.

---

## 5. A preview more permissive than its write is worse than no preview

The plan contract declared `className: z.string().min(1)` while the write used
Puppet's identifier grammar. So the preview accepted names the write rejects,
reached the ENC renderer, and its assertion escaped as a **500** — an operator
who typed `profile:monitoring` got "internal server error" where the write would
have said "Not a valid Puppet class name"
([#45](https://github.com/eth-man/nexuspuppet/pull/45)).

The comment directly above that line congratulated the contract on matching the
write exactly, so `params` could not drift into `parameters`. The very next line
was the same divergence.

**Do instead.** When two schemas must agree, assert it — compare them against
the same inputs rather than trusting either in isolation:

```ts
it('is treated identically by both', () => {
  expect(plan(className)).toBe(write(className));
});
```

---

## 6. Fixing the status code is not fixing the experience

Changing that 500 to a 400 was correct and, on its own, nearly worthless. The
client took only the body's top-level `message`, so the dialog said **"Invalid
request parameters"** — naming neither the field nor the reason — and still
offered **Apply without preview** for a change that could not succeed.

The reporter said it looked the same. They were right.

**Do instead.** Follow the error all the way to the screen. Validate at the
field where the user is, and surface the detail the API already returns.

---

## 7. Grouping without showing what you grouped by reads as repetition

The plan groups nodes by distinct outcome, keyed on before *and* after state.
The UI rendered only the delta — identical across four groups — so the reviewer
saw four boxes each showing the same single line. The thing making them separate
was the one thing not displayed
([#46](https://github.com/eth-man/nexuspuppet/pull/46)).

**Do instead.** If a UI splits things, show the axis it split on.

---

## 8. Do not disturb an environment someone else is using

A dev stack was restarted onto `main` mid-session to check whether a test
failure was pre-existing — a reasonable check — and then left there. The person
recording a demo against it spent an attempt on pre-fix code before saying the
site had "gone back to how it was".

Separately, moving `next-env.d.ts` aside to simulate a fresh clone was done
while that same stack was running.

**Do instead.** Say what you are about to disturb, restore it immediately, or
use a `git worktree` and leave the running tree alone. This file was written in
one, for exactly that reason.

---

## 9. Branch from the branch you mean to

Twice. Once landed an unrelated ADR on `main` through an unrelated pull request
([#26](https://github.com/eth-man/nexuspuppet/pull/26)); once put a feature on
another feature's branch and was caught before merge.

**Do instead.** `git status -sb` before the first commit of a new piece of work,
not after pushing.

---

## 10. Stale build output survives a branch switch

`packages/contracts/dist` built on one branch, then a switch to another, then a
build failure that looks like a type error in code you did not touch. The API
also refuses to start with `Cannot find module '../generated/prisma/client'`
when `dist/generated` is missing after a failed build.

**Do instead.** After switching branches, rebuild contracts before the API:

```bash
npm run build --workspace @nexuspuppet/contracts
npm run build --workspace @nexuspuppet/api
```

---

## 11. Not every local failure is yours

An E2E test failed locally after a change. Checking out `main` and running it
there showed **it fails on `main` too** — the local dev database has fixture
groups that already classify every node, while the test assumes CI's empty
estate.

Ten minutes of checking prevented "fixing" a test into breaking CI.

**Do instead.** Before adapting a test to your change, run it without your
change.

---

## 12. Say which claims you measured

Several statements in this repository's documentation were once written with
more confidence than the evidence supported. The ones that survived review are
the ones that name their evidence — a version number, a command, an observed
output.

Where something could not be checked, the text says so. That is not hedging; it
is the difference between a document a reader can act on and one they have to
re-derive.
