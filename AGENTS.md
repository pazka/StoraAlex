# AGENTS.md — rules for the implementing agent

Read **SPEC.md** first. This file is the operating contract for whoever builds StorAlex. It is enforced, not advisory.

## Workspace
- OS: Windows 11, shell **PowerShell**. Node 24 / npm 11 available. No WSL, no Python, no cargo.
- Repo: `C:\Users\Utilisateur\Documents\dev\StorAlex`.
- Owner minimizes token spend: prefix noisy commands with `rtk` (e.g. `rtk git status`, `rtk ls`).

## Supply-chain security — NON-NEGOTIABLE
The owner's machine must not run untrusted install-time code. Before adding ANY dependency:

1. **Vet it.** Check: weekly downloads, last publish date, maintainer, open CVEs, and recent advisories. Sources: npm page, `npm view <pkg>`, GitHub Advisories / `npm audit`, deps.dev. Reject abandoned, typosquat-looking, or recently-compromised packages. Prefer few, popular, well-maintained deps.
2. **Install with lifecycle scripts disabled.** This repo ships `.npmrc` with `ignore-scripts=true`. Keep it. A malicious `postinstall` then cannot execute on this machine. If a package genuinely needs a build step (e.g. native module without prebuilt binary), stop and flag it to the owner — do not blanket-enable scripts.
3. **Prefer prebuilt-binary packages** (better-sqlite3, sharp ship prebuilds) so disabled scripts don't break installs.
4. **Pin versions**, commit `package-lock.json`. No `^`/`latest` drift for security-relevant deps. Re-run `npm audit` after every dependency change.
5. **No global installs**, no `npx`-ing unvetted CLIs, no piping curl→shell. No `yarn`/`pnpm` introduced without owner say-so; npm is the baseline.

## Code security — acceptance criteria (see SPEC §7)
Parameterized SQL only · Fastify JSON-Schema on every route · argon2id + pepper · httpOnly/Secure/SameSite=Strict signed cookies · helmet CSP, no inline scripts, no `dangerouslySetInnerHTML` · upload MIME/magic-byte check + sharp re-encode + EXIF strip · auth on every `/api` and `/media` route · rate-limit login · secrets from env only, never committed.

## How to work
- Make **surgical, minimal** changes. Don't add abstraction the spec doesn't need. (karpathy-guidelines skill applies.)
- **TDD where it matters** (tdd skill): write tests first for auth, code-resolve, move in/out, code assignment, upload validation. Red → green → refactor.
- State assumptions explicitly; if a spec point is ambiguous, pick the safe default and note it in the PR/commit rather than silently guessing.
- Keep the build green and the Docker image buildable at every milestone (SPEC §9).
- Conventional Commits. Don't push or open PRs unless the owner asks.

## Definition of done per milestone
Builds clean · tests pass · `npm audit` clean (or documented) · security criteria for touched areas met · Docker image still builds · README updated if behavior/deploy changed.

## Maintenance (autonomous agent)
Keeping dependencies, base image and Actions current **without changing behaviour**. Read [TESTING.md](./TESTING.md) first.

- **Gate = `ci` workflow green**: `test (node 24)`, `test (node 26)`, `container smoke`. Nothing is ready without it.
- **Branches**: work on `agent/<topic>`; pushing it runs CI without a PR. Never push to `main`, never tag (a `v*` tag releases to ghcr), never edit the push/tag logic of `deploy.yml`/`release.yml`.
- **Merge policy: owner merges.** An agent prepares and reports; it does not merge unless the owner has said so for that class of PR.
- **Dependabot PR triage**:
  1. CI green → summarise the change (changelog highlights, risk) in a PR comment; done.
  2. CI red → reproduce per TESTING.md on the PR's base, fix with the smallest change on an `agent/` branch (or the PR branch if asked). Re-run `npm audit`.
  3. **Never weaken or delete a test to get green.** If behaviour must change, stop and ask the owner; record the decision in TESTING.md.
  4. Base-image major merged → move the CI matrix to `[new, next]` and update TESTING.md "Upgrades checked".
  5. Snapshot (`test/__snapshots__/`) changes only with a migration that explains it.
- **Run tests in containers** (TESTING.md) — keeps package code off the owner's machine.
- **Never** read/print `.env`, `data/`, DB files or exports; never add a dependency without the vetting above.
