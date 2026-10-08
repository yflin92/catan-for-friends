# Formal models (TLA+)

TLA+ models of the parts of Hexlands where concurrency or ordering bugs are easy to write and hard to test: the
turn/phase machine, simultaneous discard, player-to-player trade over an unreliable channel, and the game lifecycle.
They model design v1.4 (`0d61550789ecd1fe55eb2463`) §5.2–§5.10 and §6.1–§6.2, and are checked with TLC.

These models are checks on the **design**. Check V39 (trace conformance) ties them to the engine and server code by
replaying model traces through `reduce` and the server commit path.

## Models

| Module | Check | ACs | What it covers |
|---|---|---|---|
| `CatanCore.tla` | V38a, V38b | AC9, AC10, AC11, AC17, AC18 | Phase machine with the ADR-0003 phase names, setup snake order, roll/production with the bank-shortage rule, simultaneous discard, robber with the friendly-robber restriction and its fallback, Knight and Road Building, abstract builds and Longest Road moves, the win check (including at turn start), offer withdrawal on leaving `main`, and the system `skipSeat` loop with the auto-robber. |
| `CatanTrade.tla` | V38c | AC11, AC17, AC21 | Propose / accept / confirm / cancel with offer ids, over a channel that delays, reorders and repeats messages, with actionId idempotency and one server restart. Intents are dispatched in the engine's D18a/D18b order (game_over → discard_pending → not_your_turn → wrong_phase → handler) across abstract preRoll / discard / moveRobber / main / gameOver phase steps, and Design's delayed-trade traces (a)–(f) are action properties. |
| `CatanLifecycle.tla` | V38d | AC18, AC29 | `lobby → active ⇄ abandoned → finished \| expired` and `lobby → expired`, with the abandonment job running every tick and on every hello or action. |

### Abstractions

- **No board geometry.** The distance rule, road connectivity, robber adjacency and Longest Road length are covered
  by property tests (V5–V7). Production is a nondeterministic claim of 0..1 per seat and resource.
- **Builds** cost one of each resource and are worth 1 VP. A build may move Longest Road to any seat or to nobody (a
  settlement can break a road and hand the award to a third seat). A free road may move it only to its owner.
- **Friendly robber** uses a worst-case board where every hex except the desert touches every seat.
- **`skipSeat`** is one engine command that runs a loop (§5.10). `CatanCore` runs the loop as `SkipStep` micro-steps
  while `skipping` names the seat. No other action is enabled until the loop finishes, so the loop is atomic. Presence
  and timer checks belong to the server and are tested in V42.
- **Trade** in `CatanCore` is a single "offer open" flag; its message-level behaviour is in `CatanTrade`.
- **Lifecycle time** is discrete ticks with scaled-down thresholds.

## Configurations and expected results

Every passing configuration has a mutant that must fail; a mutant that passes means the check has stopped testing
anything. State counts are from one TLC worker. Every row reproduces with the `tla2tools.jar` of release
[v1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4) (TLC2 Version 2.19), except the three `CatanCore`
safety runs, `CoreLive.cfg` and `CatanTrade.cfg`. Those were checked with the `tla2tools.jar` of release
[v1.8.0](https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0) (TLC2 Version 2026.10.06, sha256 `7beec0f04818732a62fa193731711a99aa4f11279499b2360a7d156c519ea78d`),
and every other row gives identical state counts on both versions.

| Config | Module | Expected result |
|---|---|---|
| `Core.cfg` | CatanCore | Pass. 1,474,121 distinct states, about 30 min. Friendly robber off; all safety invariants and action properties; deadlock check on. |
| `CoreFriendly.cfg` | CatanCore | Pass. 1,474,121 distinct states. Friendly robber on with the fallback. |
| `CoreFriendly3.cfg` | CatanCore | Pass. 539,459 distinct states, about 10 min. Three hexes, so the friendly restriction can filter some hexes and keep others. |
| `CoreLive.cfg` | CatanCore | Pass. 106,981 distinct states, about 4 min. Liveness: discard, robber and skip loops always finish under the §6.1 fairness assumption. |
| `CoreMutantWin.cfg` | CatanCore | **Fails** `NoUnclaimedWin`: without the turn-start win check, a seat that reaches the target off-turn starts its turn without winning. |
| `CoreFriendlyStuck.cfg`, `CoreFriendly3Stuck.cfg` | CatanCore | **Fail** `RobberMoveExists`: without the fallback, a 7 can leave no legal robber hex. |
| `CatanTrade.cfg` | CatanTrade | Pass. 12,091,935 distinct states, about 15 min. No phase steps (`MaxPhaseSteps = 0`); rejections are cached in memory only, as in design §5.2. Checks `OfferOnlyInMain` and the delayed-trade traces TraceA–TraceF and TraceGameOver. |
| `CatanTradePhases.cfg` | CatanTrade | Pass. 698,752 distinct states, under a minute. Up to two phase steps (preRoll, discard, moveRobber, main, gameOver) with fewer proposer messages and no restarts, so delayed trade messages meet every phase. |
| `TradeMutant.cfg` | CatanTrade | **Fails** `AcceptBoundToOffer`: without the offer-id check, an accept binds to an offer it did not name. |
| `TradeNoDurable.cfg` | CatanTrade | **Fails** `AppliedAtMostOnce`: if committed actionIds do not survive a restart, a resent action is applied twice. |
| `TradeRestart.cfg` | CatanTrade | **Fails** `OneOutcomePerActionId`: after a restart a resent rejected action is re-evaluated and can get a different outcome. AC21 allows this; the trace is kept as a regression showing that nothing is applied twice. |
| `TradeRoleSwap.cfg` | CatanTrade | **Fails** `TraceC`: checking the phase before the role (the order D18a rejected) answers a delayed respond from the active seat outside main with wrong_phase instead of not_your_turn. |
| `CoverA.cfg` … `CoverWithdrawWin.cfg` | CatanTrade | Each **fails** its `Never…` property within seconds, which shows the scenario is reachable: (a) respond in preRoll from a non-active seat, (b) any intent during discard, the proposer's self-accept, (c) respond from the new active seat, (d) respond naming a withdrawn offer, (e) a confirm or cancel from the old proposer in preRoll, (f) a confirm reaching trade_stale, an intent after gameOver, and leaving main with an offer open, by endTurn (`CoverWithdrawEnd`), by a Knight to moveRobber (`CoverWithdrawStep`) or by a win (`CoverWithdrawWin`), where the engine must withdraw the offer. `dump-traces.sh` writes these traces as JSON for V39 (see `TRACES.md`). |
| `Lifecycle.cfg` | CatanLifecycle | Pass. 9,505 distinct states, seconds. |
| `LifecycleMutant.cfg` | CatanLifecycle | **Fails** `NothingOverdue`: comparing inactivity with `>` instead of `>=` lets a game stay active past the threshold. |

## Running TLC

Requires Java 11 or later and `tla2tools.jar` from TLA+ release
[v1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4) (TLC2 Version 2.19) or
[v1.8.0](https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0) (TLC2 Version 2026.10.06). Trace export
(`dump-traces.sh`) needs v1.8.0, sha256 `7beec0f04818732a62fa193731711a99aa4f11279499b2360a7d156c519ea78d`: v1.7.4 has no `-dumpTrace` option.

```sh
cd docs/tla
java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers auto -metadir /tmp/tlc-core -config Core.cfg CatanCore.tla
java -cp tla2tools.jar tlc2.TLC -workers auto -metadir /tmp/tlc-mut -config CoreMutantWin.cfg CatanCore.tla
```

- Give each concurrent run its own `-metadir`. TLC keeps its state queue there, and `-cleanup` deletes the shared
  `states/` directory under any other run using the default location.
- Deadlock checking stays on (do not pass `-deadlock`). In these models a deadlock is a stuck game: a non-`gameOver`
  state where no seat can act.
- `dump-traces.sh` runs each `Cover*.cfg` and writes its counterexample as JSON; `TRACES.md` gives the format and
  how each trace maps to engine actions and server outcomes.
- To parse a module without model checking: `java -cp tla2tools.jar tla2sany.SANY CatanCore.tla`.
