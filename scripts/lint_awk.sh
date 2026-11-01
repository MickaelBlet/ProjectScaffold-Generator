#!/usr/bin/env bash
# Detect awk constructs that break on mawk or busybox awk (from sh_jinja/tools/lint_awk.sh).
set -u
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
status=0
kw='if|while|for|return|in|print|printf|getline|delete|else|do|exit|function'
for f in "$root"/lib/awk/*.awk; do
	# strip comments and string literals before matching
	out=$(sed -E -e 's/^[[:space:]]*#.*$//' -e 's/"([^"\\]|\\.)*"/""/g' -e 's/[[:space:]]#.*$//' "$f" |
		sed -E "s/(^|[^A-Za-z0-9_])($kw)[[:space:]]+\(/\1KW_(/g" |
		grep -nE '(^|[^A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*[[:space:]]+\(')
	if [[ -n $out ]]; then
		printf '%s: identifier followed by "(" (busybox parses a call):\n%s\n' "${f#"$root"/}" "$out"
		status=1
	fi
	out=$(sed -E -e 's/^[[:space:]]*#.*$//' -e 's/"([^"\\]|\\.)*"/""/g' -e 's#/([^/\\]|\\.)+/#//#g' -e 's/[[:space:]]#[^p]*$//' "$f" |
		grep -nE '\^|\*\*|(^|[^a-z_])(sqrt|exp|log|sin|cos|atan2)\(|%[0-9]*d' | grep -v 'portable-math')
	if [[ -n $out ]]; then
		printf '%s: non-portable math/format:\n%s\n' "${f#"$root"/}" "$out"
		status=1
	fi
done
exit $status
