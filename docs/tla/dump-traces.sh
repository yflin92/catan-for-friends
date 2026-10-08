#!/bin/sh
# Writes one TLC counterexample trace per Cover*.cfg as JSON into $1 (see TRACES.md). Requires the tla2tools.jar of
# TLA+ v1.8.0 (v1.7.4 has no -dumpTrace) in this directory or TLA2TOOLS pointing at it; any other jar is
# refused by its sha256. Runs the models one at a time, each with its own -metadir, never -cleanup.
set -eu
out="${1:?usage: dump-traces.sh OUT_DIR}"
jar="${TLA2TOOLS:-tla2tools.jar}"
want=7beec0f04818732a62fa193731711a99aa4f11279499b2360a7d156c519ea78d
got=$(sha256sum "$jar" 2>/dev/null | cut -d' ' -f1 || true)
if [ "$got" != "$want" ]; then
  echo "dump-traces.sh: $jar is not the TLA+ v1.8.0 tla2tools.jar (sha256 $want)" >&2
  exit 2
fi
mkdir -p "$out"
for cfg in Cover*.cfg; do
  name="${cfg%.cfg}"
  java -cp "$jar" tlc2.TLC -workers 1 -metadir "$out/meta-$name" -dumpTrace json "$out/$name.json" \
    -config "$cfg" CatanTrade.tla > "$out/$name.log" 2>&1 || true
  rm -rf "$out/meta-$name"
  if [ -s "$out/$name.json" ]; then echo "$name: trace written"; else echo "$name: NO TRACE (see $name.log)"; exit 1; fi
done
