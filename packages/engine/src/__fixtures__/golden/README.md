# V15 golden fixtures

Byte-exact replay fixtures for verification plan V15. Each records a starting point, every command, the events that
command produced, and the `stateHash` after it. `packages/engine/src/golden.test.ts` replays them on every PR and fails
on any difference.

| File | Start | Steps |
|---|---|---|
| `v15-setup-4p.json` | `createGame({config: default rules, playerCount: 4, seed: "golden-board-1"})` | The 16-step setup snake draft. Sites are chosen from `legalActions` by a Park–Miller sequence (seed 15). The draft ends in preRoll of turn 1. |
| `v15-setup-3p.json` | The same with `playerCount: 3` | The 12-step draft. |
| `v15-game-4p.json` | `createGame({config: default rules, playerCount: 4, seed: "golden-board-1"})` | A full game to `gameOver` (477 steps). Every decision is picked from `legalActions` by a seeded player in `tooling/v15-golden.ts` (Park–Miller seed 51). All 17 Action types occur, both awards are held at the end, and one Year of Plenty is sent with its take in reverse RESOURCES order, so the fixture pins D20: the command is kept as sent and `devPlayed.picks` is canonical. |
| `v15-game-3p.json` | The same with `playerCount: 3` | A full game to `gameOver` (551 steps, Park–Miller seed 20), with the same coverage. |
| `v15e-bank-shortage.json` | `buildState(buildStateSpec)` on DEFAULT_TEST_BOARD, with the bank down to 1 of each resource | One scripted roll per token number (no 7), with `endTurn` in between. Covers both R8 (d) outcomes: a single owed seat takes the remainder, and a resource owed to several seats goes to nobody. |
| `v15h-skip-discarder.json` | `buildState(buildStateSpec)`, 3 players | V15(h): a scripted 7; an absent non-active discarder is skipped (absence stream), the present one discards, the roller moves the robber. |
| `v15h-skip-preroll.json` | The same board | V15(h): an absent active seat in preRoll. An auto-rolled 7 with a present discarder ends the turn after the last discard (DR4); the next skip auto-rolls with production. |
| `v15h-skip-moverobber.json` | The same board | V15(h): an absent active seat in moveRobber, with deterministic auto-placement and no steal. |
| `v15h-skip-main-offer.json` | The same board | V15(h): an absent active seat in main with an open offer, which is withdrawn. |
| `v15h-skip-roadbuilding.json` | The same board | V15(h): an absent active seat partway through Road Building; the remaining free road is forfeited. |
| `v15h-absence-stream.json` | `buildState(buildStateSpec)` with seeded dice and absence streams | 30 skips of whichever seat the game waits on. 7s force auto-discards drawn from the absence stream. |

The full games use the board, dice, steal and devDeck RNG streams. The absence stream is drawn only by `skipSeat`
auto-discards; `v15h-absence-stream.json` covers it from a seeded stream.

The board in the setup and full-game fixtures follows the normative board-stream draw order (design §3.5, D10). The fixtures are
owned by Verify (VA-V15-GOLD). E-INT's golden-replay runner asserts against them and does not regenerate them.

## Regenerating

```sh
pnpm golden:v15
```

This runs `tooling/v15-golden.ts`, which overwrites every file listed above. The test never writes them. Regenerate only in a PR
that intentionally changes rules or serialization, and say in that PR which hashes moved and why.
