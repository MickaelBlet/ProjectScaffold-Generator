#!/usr/bin/env bash
# Build the code generator into dist-cli/scaffold-gen: a standalone static executable (Rust, musl),
# the built-in template sets embedded.
# Usage: scripts/build_cli.sh [rust target triple] (default: x86_64-unknown-linux-musl; e.g.
# aarch64-unknown-linux-musl, x86_64-pc-windows-msvc, x86_64-pc-windows-gnu with a mingw linker)
# Windows MSVC targets build from Linux with cargo-xwin (cargo install cargo-xwin; it downloads the
# MSVC CRT and Windows SDK) and llvm-rc for the version resource (searched in /usr/lib/llvm-*/bin).
set -euo pipefail
cd "$(dirname "$0")/.."

target=${1:-x86_64-unknown-linux-musl}
case $target in
*windows-msvc)
    if ! command -v llvm-rc >/dev/null; then
        for dir in $(printf '%s\n' /usr/lib/llvm-*/bin | sort -V -r); do
            [[ -x "$dir/llvm-rc" ]] && { PATH="$dir:$PATH"; break; }
        done
    fi
    cargo xwin build --release --target "$target"
    ;;
*) cargo build --release --target "$target" ;;
esac
mkdir -p dist-cli
exe=scaffold-gen
case $target in *windows*) exe=scaffold-gen.exe ;; esac
cp "target/$target/release/$exe" "dist-cli/$exe"
ls -lh "dist-cli/$exe"
