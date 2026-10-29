#!/bin/sh
# Turn a rootfs tarball from tools/mkimage.py into an ext4 disk image for the
# QEMU (x86_64) guest. Needs an x86_64 Linux host and root (device nodes,
# owners, chroot), so it runs in CI rather than on the Mac.
#
#   sudo sh tools/mkdisk.sh rootfs-x86_64.tar disk.img [size]
set -eu

TAR="$1"
OUT="$2"
SIZE="${3:-1G}"

work=$(mktemp -d)
cleanup() {
    umount "$work/proc" 2>/dev/null || true
    # Never cross into a mount that failed to unmount.
    rm -rf --one-file-system "$work"
}
trap cleanup EXIT

tar -xpf "$TAR" -C "$work" --numeric-owner

# Run the deferred apk maintainer scripts and triggers natively now, instead
# of on first boot under emulation (minutes on QEMU-Wasm). Only a fresh /proc
# and a few device nodes are provided; the host's /dev is never bind-mounted.
if [ -x "$work/usr/libexec/dbvm/firstboot" ]; then
    mount -t proc proc "$work/proc"
    for dev in "null c 1 3" "zero c 1 5" "random c 1 8" "urandom c 1 9" "tty c 5 0"; do
        set -- $dev
        [ -e "$work/dev/$1" ] || mknod -m 666 "$work/dev/$1" "$2" "$3" "$4"
    done
    echo "running first-boot package scripts in a chroot"
    chroot "$work" /bin/sh -c '/usr/libexec/dbvm/firstboot 2>&1 | tail -40'
    test -e "$work/etc/dbvm/firstboot.done"
    umount "$work/proc"
fi

rm -f "$OUT"
truncate -s "$SIZE" "$OUT"
# No journal or metadata checksums: the disk is used through a copy-on-write
# overlay in the browser, and both only cost emulated CPU and extra writes.
mke2fs -q -t ext4 -O ^has_journal,^metadata_csum -L dbvm-root -m 0 -d "$work" "$OUT"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1) used of $SIZE)"
