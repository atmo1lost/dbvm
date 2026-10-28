#!/bin/sh
# Download the latest successful CI builds of the 64-bit backend into
# $DBVM_CACHE/images/, where the dev server serves them:
#   qemu/      QEMU-Wasm with the canvas display   (.github/workflows/qemu-wasm.yml)
#   alpine64/  x86_64 guest: kernel, initramfs, disk (.github/workflows/guest-x86_64.yml)
set -eu

cd "$(dirname "$0")/.."
IMAGES="${DBVM_CACHE:-$HOME/Library/Caches/dbvm}/images"

latest() {
    gh run list --workflow "$1" --status success --limit 1 --json databaseId --jq '.[0].databaseId'
}

fetch() {
    workflow="$1" artifact="$2"
    run=$(latest "$workflow")
    [ -n "$run" ] || { echo "no successful $workflow run yet"; return 1; }
    rm -rf "${IMAGES:?}/$3"
    gh run download "$run" --name "$artifact" --dir "$IMAGES/$3"
    echo "fetched $artifact from run $run"
}

fetch qemu-wasm.yml qemu-wasm qemu
fetch guest-x86_64.yml alpine64 alpine64
du -sh "$IMAGES/qemu" "$IMAGES/alpine64"
