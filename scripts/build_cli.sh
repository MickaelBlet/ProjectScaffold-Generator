#!/usr/bin/env bash
# Build the code generator into dist-cli/scaffold-gen: a standalone static executable (Rust, musl),
# the built-in template sets embedded.
# Usage: scripts/build_cli.sh [rust target triple] (default: x86_64-unknown-linux-musl; e.g.
# aarch64-unknown-linux-musl, x86_64-pc-windows-gnu with a mingw linker)
set -euo pipefail
cd "$(dirname "$0")/.."

target=${1:-x86_64-unknown-linux-musl}
cargo build --release --target "$target"
mkdir -p dist-cli
exe=scaffold-gen
case $target in *windows*) exe=scaffold-gen.exe ;; esac
cp "target/$target/release/$exe" "dist-cli/$exe"
ls -lh "dist-cli/$exe"
