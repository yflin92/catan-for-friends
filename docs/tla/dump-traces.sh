#!/bin/sh
# Writes one TLC counterexample trace per Cover*.cfg as JSON into $1 (see TRACES.md). Requires tla2tools.jar in this
# directory or TLA2TOOLS pointing at it. Runs the models one at a time, each with its own -metadir, never -cleanup.
set -eu
out="${1:?usage: dump-traces.sh OUT_DIR}"
jar="${TLA2TOOLS:-tla2tools.jar}"
mkdir -p "$out"
for cfg in Cover*.cfg; do
  name="${cfg%.cfg}"
  java -cp "$jar" tlc2.TLC -workers 1 -metadir "$out/meta-$name" -dumpTrace json "$out/$name.json" \
    -config "$cfg" CatanTrade.tla > "$out/$name.log" 2>&1 || true
  rm -rf "$out/meta-$name"
  if [ -s "$out/$name.json" ]; then echo "$name: trace written"; else echo "$name: NO TRACE (see $name.log)"; exit 1; fi
done
