#!/bin/sh
# Error parity of the sh/awk rewrite: for each tests/errors case, the TypeScript generator's message
# (written to <case>.expected with -w) against bin/scaffold-gen's. Run from the repository root.
set -u
write=0
[ "${1-}" = -w ] && { write=1; shift; }
[ $# -gt 0 ] || set -- tests/errors/*.scaffold.yaml
fail=0
for f in "$@"; do
	exp=${f%.scaffold.yaml}.expected
	if [ $write = 1 ]; then
		npx tsx scripts/dump-context.ts "$f" | sed -n '/^error: /,$p' | sed "1s|^error: |$f: error: |" >"$exp"
		[ -s "$exp" ] || echo "NO ERROR from TS: $f"
	fi
	got=$(bin/scaffold-gen --dump-context "$f" 2>&1 >/dev/null)
	if [ "$got" = "$(cat "$exp")" ]; then
		[ -n "${VERBOSE:-}" ] && echo "ok $f"
	else
		echo "DIFF $f"; printf '%s\n' "$got" | diff "$exp" - | head -${LINES_SHOWN:-8}
		fail=1
	fi
done
exit $fail
