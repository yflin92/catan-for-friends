# V15 golden fixtures

Byte-exact replay fixtures for verification plan V15. Each records a starting point, every command, the events that
command produced, and the `stateHash` after it. `packages/engine/src/golden.test.ts` replays them on every PR and fails
on any difference.

| File | Start | Steps |
|---|---|---|
| `v15-setup-4p.json` | `createGame({config: default rules, playerCount: 4, seed: "golden-board-1"})` | The 16-step setup snake draft. Sites are chosen from `legalActions` by a Park–Miller sequence (seed 15). The draft ends in preRoll of turn 1. |
| `v15-setup-3p.json` | The same with `playerCount: 3` | The 12-step draft. |
| `v15e-bank-shortage.json` | `buildState(buildStateSpec)` on DEFAULT_TEST_BOARD, with the bank down to 1 of each resource | One scripted roll per token number (no 7), with `endTurn` in between. Covers both R8 (d) outcomes: a single owed seat takes the remainder, and a resource owed to several seats goes to nobody. |

The board in the setup fixtures follows the normative board-stream draw order (design §3.5, D10). The fixtures are
owned by Verify (VA-V15-GOLD). E-INT's golden-replay runner asserts against them and does not regenerate them.

## Regenerating

```sh
pnpm golden:v15
```

This runs `tooling/v15-golden.ts`, which overwrites the three files. The test never writes them. Regenerate only in a PR
that intentionally changes rules or serialization, and say in that PR which hashes moved and why.
