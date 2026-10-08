# Hexlands docs

The specification lives on the IntentLab task board. This repo's code follows those tasks; when a task's text and the
design disagree, the design wins.

## Source of truth (task ids)

| Document | Task id |
|---|---|
| Epic | `f087c7331869468b33a6b397` |
| Requirements v1.5 (canonical) | `af543ff149df0372fb999d55` |
| Design v1.4 (canonical) | `0d61550789ecd1fe55eb2463` |

Each new requirements or design version is filed as a new, never-edited task, and later diffs are posted as comments on
it. ADR revisions are posted as `rev 1.x:` comments on the ADR tasks, so read the comments as well as the description.

### ADRs (design §15)

| ADR | Task id | Title |
|---|---|---|
| 0001 | `6fe34dd1245927354a40e227` | Hex coordinates with canonical vertex/edge identity |
| 0002 | `09480bc139209b0f8e1f0f80` | TypeScript everywhere; pnpm monorepo with a shared engine package |
| 0003 | `13bd153a35520f67feb6115d` | Rules-engine API: pure reducer, named RNG streams, single view(), stateHash, test hooks, closed reason codes |
| 0004 | `77586386f186e33501677182` | Wire protocol: WebSocket JSON envelope, actionId idempotency, gap-free seq, full-view resync, outcome record, signals |
| 0005 | `1b0ad8eaa4c5d715706609e4` | Persistence: SQLite command log + snapshots, ack after fsync, SIGTERM drain-and-flush, restart recovery |
| 0006 | `4d8fc48768ae836a200e7a12` | Identity and auth: room codes and seat tokens in URL fragments and the hello payload |
| 0007 | `409a3fc00afb0420816052ea` | Game lifecycle, abandonment job, injectable clock |
| 0008 | `957f684a0e95abe9378dca17` | Single-writer concurrency; P2P trade model; simultaneous discard |
| 0009 | `e6c30ca3e647f0c206f3c5d0` | Observability: OTel + Alloy sidecar, closed-enum labels, one span per action, series budget |
| 0010 | `68565215aba712b73f4bee99` | Web client: React + Vite + SVG; server-driven legal moves; no optimistic updates |
| 0011 | `447255465401a6518431ca2e` | Hosting/deploy target |
| 0012 | `363a007142ce81b25854b821` | Layout: desktop-first responsive, usable on mobile |
| 0013 | `524cd029cc95b483474042b7` | Chat |
| 0014 | `455ff2e7608deca63a8ae9d4` | Absent-player policy |

The status of each ADR (ACCEPTED or PROPOSED) is on its task.

## Repository layout (design §11)

| Path | Contents |
|---|---|
| `packages/engine` | `@hexlands/engine`: the pure, deterministic rules engine shared by server and client. `@hexlands/engine/testing` holds test-only builders. |
| `packages/protocol` | `@hexlands/protocol`: wire message types, zod schemas, shared enums, close codes. |
| `apps/server` | The Node.js game server. |
| `apps/web` | The browser client. Playwright end-to-end tests live in `apps/web/e2e`. |
| `deploy/` | Deployment configuration. |
| `docs/` | This file, and `docs/tla/`: the TLA+ formal models of the turn/phase machine, trade and lifecycle, with their TLC configurations ([docs/tla/README.md](tla/README.md)). |
| `tooling/` | Repo-wide checks, including the architecture-rule tests and their seeded-violation fixtures. |

Workspace packages are consumed as TypeScript source through their `exports` maps; nothing is published.

## Commands

Requires Node.js 22 (`.nvmrc`) and pnpm 9 (`corepack enable`).

```sh
pnpm install
pnpm lint        # ESLint, including the engine purity rules
pnpm typecheck   # tsc --noEmit for every package, plus tooling/
pnpm depcruise   # dependency-cruiser architecture rules
pnpm test        # vitest (unit + property)
pnpm --filter @hexlands/web build    # tsc + vite build into apps/web/dist
pnpm --filter @hexlands/web budget   # fails when built JS is >= 300 KB gzipped (NFR14)
pnpm --filter @hexlands/web dev      # Vite dev server; proxies /ws and /api to HEXLANDS_SERVER_URL (default http://127.0.0.1:8080)
pnpm e2e         # Playwright against apps/web/dist (build first; needs `pnpm --filter @hexlands/web exec playwright install chromium` once)
```

## Enforced rules

- **Engine purity** (ESLint, `packages/engine/src/**` except `*.test.ts`): no `Date`, `Math.random`, timers, `process`,
  `globalThis.crypto`/`crypto`, `fetch` or `performance`. Imports are limited to relative modules and `@noble/hashes`.
- **Only `packages/engine/src/view.ts` may cast to `PlayerView`** (ESLint), so `view()` is the only way to mint the brand.
- **Transport code never sees `GameState`**: `packages/protocol/src` and `apps/server/src/{ws-gateway,http}` may not import
  `GameState` from `@hexlands/engine` (ESLint) or the engine's `src/state.ts` module directly (dependency-cruiser).
- **dependency-cruiser** (`.dependency-cruiser.cjs`):
  - `no-engine-testing-in-apps`: `apps/*/src` must not import `@hexlands/engine/testing`.
  - `engine-internal-is-private`: `packages/engine/src/internal/*` is importable only from inside `packages/engine/src`.
  - `no-gamestate-in-transport`: see above.
  - `engine-is-a-leaf`: the engine imports no other workspace package.

`tooling/arch-rules.test.ts` runs every rule against seeded violations, so a rule that stops firing fails `pnpm test`.

## Repository settings (owner action)

The fleet's GitHub token cannot change repository administration settings, so the owner applies these once in
**Settings → Branches → Add branch protection rule** (or a ruleset) for `main`:

1. **Require a pull request before merging.**
2. **Require status checks to pass before merging**, with these required checks (the job names in
   `.github/workflows/ci.yml`):
   - `lint`
   - `typecheck`
   - `depcruise`
   - `test`
   - `e2e`
3. **Require branches to be up to date before merging.**

The check names appear in the picker after the `ci` workflow has run once on a pull request.
