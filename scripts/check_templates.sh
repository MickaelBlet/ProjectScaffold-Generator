#!/usr/bin/env bash
# Check the built-in template sets: generate the examples and fixtures with each, then build them
# (C++: CMake with -Wall -Wextra -Werror; Python: byte-compile and import each package).
# Needs cmake, a C++20 compiler (C++98 for cpp98) and python3 (3.8+); sca-cpp98 also omniORB 4 (omniidl,
# libomniorb4-dev; elsewhere than the system: OMNIORB_ROOT=<prefix>, omniidl in <prefix>/bin), else
# it is only generated.
# Usage: scripts/check_templates.sh [-w <work directory>] [set]...   (default: every templates/<set>)
set -euo pipefail
cd "$(dirname "$0")/.."

work=
if [ "${1:-}" = -w ]; then work=$2; shift 2; fi
work=${work:-$(mktemp -d)}
mkdir -p "$work"
sets=("$@")
[ ${#sets[@]} -gt 0 ] || sets=($(ls templates))
projects=(examples/robot.scaffold.yaml examples/rover.scaffold.yaml examples/station.scaffold.yaml
  tests/fixtures/plant.scaffold.yaml tests/fixtures/relay.scaffold.yaml)
failed=0
# Imports a package and all its modules, then makes and closes each system (servers not started).
IMPORT_ALL='
import importlib, inspect, pkgutil, sys
package = importlib.import_module(sys.argv[1])
for m in pkgutil.walk_packages(package.__path__, sys.argv[1] + "."):
    module = importlib.import_module(m.name)
    if ".systems." in m.name:
        for name, cls in inspect.getmembers(module, inspect.isclass):
            if cls.__module__ == m.name and hasattr(cls, "serve"):
                cls().close()
'

check() {
  local set=$1 project=$2 name out
  name=$(basename "$project" .scaffold.yaml)
  out="$work/$set/$name"
  if ! npm run -s generate -- "$project" -t "$set" -o "$out" -d --force >"$work/log" 2>&1; then
    echo "FAILED  $set: $name (generation)"; sed 's/^/        /' "$work/log"; failed=1; return
  fi
  local cmake_args=()
  if [[ $set == sca-* ]]; then
    if [ -n "${OMNIORB_ROOT:-}" ]; then
      cmake_args=(-DCMAKE_PREFIX_PATH="$OMNIORB_ROOT" -DOMNIIDL="$OMNIORB_ROOT/bin/omniidl")
    elif ! command -v omniidl >/dev/null; then
      echo "ok      $set: $name (generated; not built: no omniidl)"; return
    fi
  fi
  if [ -f "$out/CMakeLists.txt" ]; then
    # Unused parameters: the generated handlers are empty.
    if cmake -S "$out" -B "$out/.build" "${cmake_args[@]}" -DCMAKE_CXX_FLAGS="-Wall -Wextra -Werror -Wno-unused-parameter" \
      >"$work/log" 2>&1 && cmake --build "$out/.build" -j >>"$work/log" 2>&1; then
      echo "ok      $set: $name"
    else
      echo "FAILED  $set: $name (build)"; grep -E 'error:' "$work/log" | sed "s|$out/||" | sort -u | head -15 | sed 's/^/        /'; failed=1
    fi
  fi
  if [ -f "$out/pyproject.toml" ] || [ -d "$out/python" ]; then
    local root=$out
    [ -d "$out/python" ] && root=$out/python
    if python3 -m compileall -q "$root" >"$work/log" 2>&1 &&
      (cd "$root" && for p in */__init__.py; do python3 -c "$IMPORT_ALL" "${p%/__init__.py}" || exit 1; done) >>"$work/log" 2>&1; then
      echo "ok      $set: $name (python)"
    else
      echo "FAILED  $set: $name (python)"; tail -20 "$work/log" | sed 's/^/        /'; failed=1
    fi
  fi
}

for set in "${sets[@]}"; do
  for project in "${projects[@]}"; do check "$set" "$project"; done
done
exit $failed
