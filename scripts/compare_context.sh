#!/bin/sh
# Parity check of the Rust rewrite: the generation context of each project file from the
# TypeScript generator and from the Rust scaffold-gen, diffed. Removed with the TypeScript generator.
# Usage: scripts/compare_context.sh [-w workdir] [project file]...
set -u
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
work=${TMPDIR:-/tmp}/scaffold-compare
if [ "${1-}" = -w ]; then work=$2; shift 2; fi
[ $# -gt 0 ] || set -- $(find "$root/examples" "$root/tests/fixtures" -name '*.scaffold.yaml' -o -name '*.scaffold.json' | sort)
mkdir -p "$work"
norm='import json,sys
t=sys.stdin.read()
try: print(json.dumps(json.loads(t), sort_keys=True, indent=1))
except Exception: print(t)'
fail=0
for f in "$@"; do
	name=$(basename "$f")
	(cd "$root" && npx tsx scripts/dump-context.ts "$f") | python3 -c "$norm" >"$work/$name.ts.json"
	"${SCAFFOLD_GEN:-$root/rust/target/release/scaffold-gen}" --dump-context "$f" 2>&1 | python3 -c "$norm" >"$work/$name.rs.json"
	if cmp -s "$work/$name.ts.json" "$work/$name.rs.json"; then
		[ -n "${VERBOSE:-}" ] && echo "ok $name"
	else
		echo "DIFF $name: diff $work/$name.ts.json $work/$name.rs.json | head"
		fail=1
	fi
done
exit $fail
