#!/bin/sh
# Build the Alpine guest and convert it to v86's lazily-loaded 9p format.
# Outputs go to $DBVM_CACHE (default ~/Library/Caches/dbvm), outside the
# iCloud-synced project, and everything runs at low priority.
set -eu

cd "$(dirname "$0")/.."
DBVM_CACHE="${DBVM_CACHE:-$HOME/Library/Caches/dbvm}"
export DBVM_CACHE
V86_TOOLS=refs/emulators/v86/tools
OUT="$DBVM_CACHE/images/alpine"
TAR="$DBVM_CACHE/build/rootfs.tar"

nice -n 10 python3 -I tools/mkimage.py

rm -rf "$OUT/rootfs"
mkdir -p "$OUT/rootfs"
nice -n 10 python3 -I "$V86_TOOLS/fs2json.py" --zstd --out "$OUT/fs.json" "$TAR"
nice -n 10 python3 -I "$V86_TOOLS/copy-to-sha256.py" --zstd "$TAR" "$OUT/rootfs" > /dev/null

# Identifies this build; saved browser sessions from other builds are ignored.
date +%s > "$OUT/version"

du -sh "$OUT" "$DBVM_CACHE/build"
