#!/usr/bin/env bash
# Check the calls between binaries: generate tests/fixtures/relay.scaffold.yaml, build it with
# tests/remote/interop.cpp, then over each generated transport call C++ from Python, Python from C++
# and Python from Python (and the Python peers of both binaries). Needs cmake, a C++17 compiler and
# python3 (3.8+).
# Usage: scripts/check_remote.sh [work directory (default: a temporary one)]
set -euo pipefail
cd "$(dirname "$0")/.."

work=${1:-$(mktemp -d)}
mkdir -p "$work"
npm run -s generate -- tests/fixtures/relay.scaffold.yaml -o "$work/relay" --force >/dev/null
# Unused parameters: the generated handlers are empty.
cmake -S tests/remote -B "$work/build" -DRELAY_DIR="$work/relay" \
  -DCMAKE_CXX_FLAGS="-Wall -Wextra -Werror -Wno-unused-parameter" >/dev/null
cmake --build "$work/build" -j >/dev/null

cpp=("$work/build/interop")
py=(python3 tests/remote/interop.py "$work/relay/python")
failed=0

# pair <name> <server command...> -- <client command...>
pair() {
  local name=$1 server=() client=() log="$work/server.log"
  shift
  while [ "$1" != -- ]; do server+=("$1"); shift; done
  shift
  client=("$@")
  "${server[@]}" >"$log" 2>&1 &
  local pid=$!
  for _ in $(seq 100); do
    grep -q ready "$log" 2>/dev/null && break
    kill -0 $pid 2>/dev/null || break
    sleep 0.05
  done
  if grep -q ready "$log" && "${client[@]}"; then
    echo "ok      $name"
  else
    echo "FAILED  $name"
    sed 's/^/        server: /' "$log"
    failed=1
  fi
  kill $pid 2>/dev/null || true
  wait $pid 2>/dev/null || true
}

port=47100
for t in tcp udp http websocket shm; do
  ack=true
  [ $t = udp ] && ack=false
  for way in "python -> c++" "c++ -> python" "python -> python"; do
    port=$((port + 1))
    address=127.0.0.1:$port
    [ $t = shm ] && address=relay_check_$$_$port
    case $way in
      "python -> c++") pair "$t: $way" "${cpp[@]}" serve $t $address -- "${py[@]}" call $t $address $ack ;;
      "c++ -> python") pair "$t: $way" "${py[@]}" serve $t $address -- "${cpp[@]}" call $t $address $ack ;;
      *) pair "$t: $way" "${py[@]}" serve $t $address -- "${py[@]}" call $t $address $ack ;;
    esac
  done
done

if "${py[@]}" peers; then echo "ok      python peers, every link"; else echo "FAILED  python peers"; failed=1; fi
exit $failed
