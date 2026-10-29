#!/bin/sh
# Turn a rootfs tarball from tools/mkimage.py into an ext4 disk image for the
# QEMU (x86_64) guest. Needs Linux and root (extracting device nodes, owners),
# so it runs in CI rather than on the Mac.
#
#   sudo sh tools/mkdisk.sh rootfs-x86_64.tar disk.img [size]
set -eu

TAR="$1"
OUT="$2"
SIZE="${3:-1G}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

tar -xpf "$TAR" -C "$work" --numeric-owner
rm -f "$OUT"
truncate -s "$SIZE" "$OUT"
# No journal or metadata checksums: the disk is used through a copy-on-write
# overlay in the browser, and both only cost emulated CPU and extra writes.
mke2fs -q -t ext4 -O ^has_journal,^metadata_csum -L dbvm-root -m 0 -d "$work" "$OUT"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1) used of $SIZE)"
