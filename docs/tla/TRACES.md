# TLC trace export (V39 import format)

Verification check V39 replays model traces through the engine and the server commit path. This file defines how the
traces are produced and the JSON shape an importer reads.

## Producing traces

Every `Cover*.cfg` model states one `Never…` action property that must fail, so TLC finds the shortest behaviour that
reaches the scenario and prints it. `-dumpTrace json` writes that behaviour as JSON:

```sh
cd docs/tla
./dump-traces.sh /tmp/tla-traces   # one <Cover>.json per Cover*.cfg, each from its own -metadir
```

The script runs the models one at a time (TLC checking is single-CPU here) and never passes `-cleanup`.

## JSON shape (TLC2 Version 2.19, `-dumpTrace json`)

```jsonc
{
  "vars": ["phase", "hand", ...],            // the module's VARIABLES
  "counterexample": {
    "state":  [[1, { "<var>": <value>, ... }], [2, { ... }], ...],
    "action": [[[1, {<state 1>}], { "name": "Send", "location": { "module": "CatanTrade", "beginLine": 121, ... } },
                [2, {<state 2>}]], ...]
  }
}
```

- `state[k]` is `[index, record]`; indices start at 1 and are consecutive.
- `action[k]` is `[[i, pre], step, [i + 1, post]]`, where `step.name` is the TLA+ action (`Send`, `Deliver`, `Redeliver`,
  `Spend`, `Restart`, `PhaseStep` in CatanTrade).
- Value encoding:

  | TLA+ value | JSON |
  |---|---|
  | integer, string, boolean | number, string, boolean |
  | record `[a ↦ x, …]` | object |
  | function or sequence over `1..n` | array (element `i` at index `i − 1`) |
  | any other function (for example over `Seats = 0..N-1`) | object with stringified keys (`{"0": …, "1": …}`) |
  | set | array, in TLC's normal order |
  | tuple `<<a, b>>` | array |

## Mapping CatanTrade traces to the engine and server

The importer reads each `Deliver` step and finds the one message whose `aid` is newly in `DOMAIN outcome`:

- `m.seat` is the seat; `m.aid = <<seat, n>>` maps to a fresh actionId per `(seat, n)`.
- `m.act.kind` maps to the Action: `propose → proposeTrade{give, get}`, `accept → respondTrade{tradeId: oid, accept:
  true}`, `confirm → confirmTrade{tradeId: oid, partner: with}`, `cancel → cancelTrade{tradeId: oid}`, and
  `endTurn → endTurn`. Resource names `"a"`/`"b"` map to any two distinct resources.
- The recorded `outcome[aid]` is the expected outcome code (`ok` or the reason code). `model_bound` marks the model's
  offer-id bound and has no engine counterpart.
- `PhaseStep` from `preRoll` to `main`, `discard` or `moveRobber` is a roll with forced dice (non-7, or 7 with or without
  a hand over the discard limit). From `discard` it is the last discard, and from `moveRobber` the robber move.
  `main → moveRobber` is a Knight, and `main → gameOver` is a winning build.
- `Spend` is any build or maritime trade by the active seat that removes the named resource.
- `Redeliver` resends a decided actionId with the same payload, and `Restart` is a server restart.

CatanCore traces use the same JSON shape. Their action names map to engine commands as listed at the top of
`packages/engine/src/__integration__/v39.ts`.
