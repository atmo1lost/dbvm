#!/bin/sh
# Download the latest successful qemu-wasm CI build (QEMU-Wasm + x86_64 guest)
# into $DBVM_CACHE/images/{qemu,alpine64}, where the dev server serves them.
#
#   sh tools/fetch-qemu-artifacts.sh [run-id]
set -eu

cd "$(dirname "$0")/.."
IMAGES="${DBVM_CACHE:-$HOME/Library/Caches/dbvm}/images"
RUN="${1:-$(gh run list --workflow qemu-wasm.yml --status success --limit 1 --json databaseId --jq '.[0].databaseId')}"
[ -n "$RUN" ] || { echo "no successful qemu-wasm run yet"; exit 1; }

rm -rf "$IMAGES/qemu" "$IMAGES/alpine64"
gh run download "$RUN" --name qemu-wasm --dir "$IMAGES/qemu"
gh run download "$RUN" --name alpine64 --dir "$IMAGES/alpine64"
du -sh "$IMAGES/qemu" "$IMAGES/alpine64"
