# TLC trace fixtures (V39)

TLC counterexample traces in the `-dumpTrace json` format defined in `docs/tla/TRACES.md`, checked by
`tooling/tla-traces.test.ts` on every PR:

- `Cover*.json`: one per `docs/tla/Cover*.cfg` (CatanTrade), replayed through the engine step by step. Mapping at the
  top of `packages/engine/src/__integration__/tla-trace.ts`.
- `core/CoreCover*.json`: one per `docs/tla/CoreCover*.cfg` (CatanCore skip loops), checked against the engine's
  skipSeat from the state at the trace's SkipSeat. Mapping at the top of
  `packages/engine/src/__integration__/tla-core-trace.ts`.

Regenerate with TLC from tla2tools.jar **v1.8.0** (the `-dumpTrace` option is not in v1.7.4):

```sh
cd docs/tla
TLA2TOOLS=/path/to/tla2tools.jar ./dump-traces.sh /tmp/tla-traces
cp /tmp/tla-traces/Cover*.json ../../packages/engine/src/__fixtures__/tla-traces/
cp /tmp/tla-traces/core/CoreCover*.json ../../packages/engine/src/__fixtures__/tla-traces/core/
```

The nightly `tla-traces` job regenerates both sets and checks the fresh traces (`HEXLANDS_TLA_TRACES_DIR`; the core set is
read from its `core/` subdirectory).
