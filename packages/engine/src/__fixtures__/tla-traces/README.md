# TLC trace fixtures (V39)

TLC counterexample traces of `docs/tla/CatanTrade.tla`, one per `Cover*.cfg`, in the `-dumpTrace json` format defined
in `docs/tla/TRACES.md`. `tooling/tla-traces.test.ts` replays each through the engine on every PR. The mapping from
model steps to engine commands is documented at the top of `packages/engine/src/__integration__/tla-trace.ts`.

Regenerate with TLC from tla2tools.jar **v1.8.0** (the `-dumpTrace` option is not in v1.7.4):

```sh
cd docs/tla
TLA2TOOLS=/path/to/tla2tools.jar ./dump-traces.sh /tmp/tla-traces
cp /tmp/tla-traces/Cover*.json ../../packages/engine/src/__fixtures__/tla-traces/
```

The nightly `tla-traces` job regenerates the set and replays the fresh traces (`HEXLANDS_TLA_TRACES_DIR`).
