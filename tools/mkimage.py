#!/usr/bin/env python3
"""Build the dbvm Alpine guest image without Docker.

Two targets (--arch):
  x86     i686 guest for v86. Root is v86's lazily loaded 9p share.
  x86_64  64-bit guest for QEMU-Wasm. Root is an ext4 virtio disk (/dev/vda),
          made from rootfs.tar by tools/mkdisk.sh (Linux/CI only).

Starts from Alpine's minirootfs, resolves and unpacks extra packages from
the Alpine CDN straight into an in-memory tar (no host extraction, so macOS's
case-insensitive filesystem never touches guest paths), applies dbvm config,
and writes:

  $DBVM_CACHE/build/rootfs[-x86_64].tar        full guest rootfs
  $DBVM_CACHE/images/alpine[64]/vmlinuz-virt   kernel
  $DBVM_CACHE/images/alpine[64]/initramfs.img  tiny busybox initramfs that mounts the root

$DBVM_CACHE defaults to ~/Library/Caches/dbvm (outside the iCloud-synced project).

Convert rootfs.tar to v86's lazy 9p format with tools/build-image.sh.
"""

import argparse
import gzip
import io
import os
import re
import sys
import tarfile
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

ALPINE_VERSION = "3.21"
MINIROOTFS = "3.21.9"
ARCH = "x86"  # set from --arch in main()
MIRROR = "https://dl-cdn.alpinelinux.org/alpine"
REPOS = ["main", "community"]

PACKAGES = [
    "alpine-base", "openrc", "agetty", "linux-virt", "eudev", "eudev-openrc",
    "udev-init-scripts-openrc", "dbus", "dbus-openrc",
    "bash", "nano", "htop", "less", "util-linux-misc", "curl", "ca-certificates",
]
DESKTOP_PACKAGES = [
    "xorg-server", "xinit", "xf86-video-fbdev", "xf86-input-libinput",
    "xauth", "xsetroot", "xrandr", "xrdb", "setxkbmap",
    "jwm", "xterm", "pcmanfm", "mousepad", "dillo", "xclip",
    "font-dejavu", "hicolor-icon-theme", "adwaita-icon-theme",
]
# Extra packages per architecture. The 64-bit guest gets Flatpak (Flathub only
# publishes x86_64/aarch64 apps).
ARCH_PACKAGES = {
    "x86": [],
    "x86_64": ["flatpak"],
}
# Flathub is preconfigured through flatpak's remotes.d drop-in directory.
FLATHUB_REPO = "https://dl.flathub.org/repo/flathub.flatpakrepo"

# Never install these: mkinitfs pulls in a large toolchain (we ship our own
# initramfs), and mesa/llvm are ~300 MB of software GL that v86 can't use.
EXCLUDE = {
    "mkinitfs", "initramfs-generator", "linux-firmware-any", "linux-firmware-none",
    "mesa", "mesa-dri-gallium", "llvm19-libs",
}

# Per-architecture root filesystem: modules the initramfs loads (in dependency
# order; virtio-pci is built in) and how it mounts the root.
ROOTS = {
    "x86": {
        "modules": ["netfs", "9pnet", "9pnet_virtio", "9p"],
        "mount": "mount -t 9p -o trans=virtio,cache=loose host9p /newroot",
    },
    "x86_64": {
        "modules": ["virtio_blk", "crc16", "crc32c_generic", "mbcache", "jbd2", "ext4"],
        "mount": "mount -t ext4 /dev/vda /newroot",
    },
}

RUNLEVELS = {
    "sysinit": ["devfs", "dmesg", "udev", "udev-trigger", "udev-settle"],
    "boot": ["modules", "sysctl", "hostname", "bootmisc", "syslog", "dbvm-firstboot"],
    "default": ["local", "dbus", "udev-postmount", "networking", "dbvm-agent"],
    "shutdown": ["killprocs", "savecache"],
}

# Files copied verbatim into the guest (X config, WM, first-boot hook, ...).
OVERLAY = Path(__file__).resolve().parent.parent / "guest" / "overlay"
# Maintainer scripts are not run at build time; first boot runs them in the guest.
SCRIPTS_DIR = "etc/dbvm/apk-scripts"

INIT_SCRIPT = """#!/bin/busybox sh
/bin/busybox mkdir -p /sbin /usr/bin /usr/sbin
/bin/busybox --install -s
mount -t devtmpfs devtmpfs /dev
mount -t proc proc /proc
mount -t sysfs sysfs /sys
for m in {modules}; do insmod /lib/modules/$m.ko || echo "dbvm: failed to load $m"; done
# The root device may take a moment to appear after its driver loads.
for i in 1 2 3 4 5 6 7 8 9 10; do
    {mount} && break
    sleep 1
done
if ! mountpoint -q /newroot; then
    echo "dbvm: could not mount the root filesystem, dropping to initramfs shell"
    exec sh
fi
mount --move /dev /newroot/dev
umount /proc /sys
exec switch_root /newroot /sbin/init
"""

DBVM_CACHE = Path(os.environ.get("DBVM_CACHE", Path.home() / "Library/Caches/dbvm"))
CACHE = DBVM_CACHE / "build" / "cache"


def log(msg):
    print(f"[mkimage] {msg}", flush=True)


def fetch(url, name):
    """Download url into the cache (once) and return its bytes."""
    path = CACHE / ARCH / name
    if not path.exists():
        log(f"fetch {url}")
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    data = r.read()
                break
            except OSError:
                if attempt == 2:
                    raise
                time.sleep(2)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return path.read_bytes()


# --- APKINDEX -------------------------------------------------------------

def dep_name(token):
    return re.split(r"[<>=~]", token, maxsplit=1)[0]


def parse_index(text, repo):
    pkgs = {}
    for block in text.split("\n\n"):
        f = defaultdict(list)
        for line in block.splitlines():
            if len(line) > 2 and line[1] == ":":
                f[line[0]].append(line[2:])
        if "P" not in f:
            continue
        pkgs[f["P"][0]] = {
            "name": f["P"][0],
            "version": f["V"][0] if f["V"] else "",
            "deps": " ".join(f["D"]).split(),
            "provides": [dep_name(p) for p in " ".join(f["p"]).split()],
            "priority": int(f["k"][0]) if f["k"] else 0,
            "repo": repo,
            "record": block.strip(),
        }
    return pkgs


def load_indexes():
    pkgs = {}
    for repo in REPOS:
        url = f"{MIRROR}/v{ALPINE_VERSION}/{repo}/{ARCH}/APKINDEX.tar.gz"
        raw = fetch(url, f"APKINDEX-{repo}.tar.gz")
        with tarfile.open(fileobj=io.BytesIO(raw)) as t:
            text = t.extractfile("APKINDEX").read().decode()
        for name, p in parse_index(text, repo).items():
            pkgs.setdefault(name, p)  # main wins over community
    return pkgs


def resolve(pkgs, wanted, installed):
    providers = defaultdict(list)
    for p in pkgs.values():
        for prov in p["provides"]:
            providers[prov].append(p)

    satisfied = set(installed)
    for name in installed:
        if name in pkgs:
            satisfied.update(pkgs[name]["provides"])

    order, queue = [], list(wanted)
    while queue:
        token = queue.pop(0)
        if token.startswith("!"):
            continue
        name = dep_name(token)
        if name in satisfied or name in EXCLUDE:
            continue
        pkg = pkgs.get(name)
        if pkg is None:
            cands = providers.get(name)
            if not cands:
                sys.exit(f"cannot resolve dependency {token!r}")
            pkg = max(cands, key=lambda p: p["priority"])
        if pkg["name"] in satisfied or pkg["name"] in EXCLUDE:
            satisfied.add(name)
            continue
        satisfied.add(name)
        satisfied.add(pkg["name"])
        satisfied.update(pkg["provides"])
        order.append(pkg)
        queue.extend(pkg["deps"])
    return order


# --- rootfs assembly ------------------------------------------------------

class RootFS:
    """Ordered path -> (TarInfo, bytes) map; later writes override earlier ones."""

    def __init__(self):
        self.entries = {}

    @staticmethod
    def norm(name):
        if name.startswith("./"):
            name = name[2:]
        return name.lstrip("/").rstrip("/") if name != "." else ""

    def add_apk(self, raw):
        """Unpack an .apk; returns its control files (.PKGINFO, .post-install, ...)."""
        # An .apk is several concatenated gzip members forming one tar stream;
        # GzipFile handles multi-member input, tarfile's own gz stream does not.
        return self.add_tar(gzip.GzipFile(fileobj=io.BytesIO(raw)), mode="r|", skip_control=True)

    def add_tar(self, fileobj, mode="r:*", skip_control=False):
        control = {}
        with tarfile.open(fileobj=fileobj, mode=mode) as t:
            for m in t:
                name = self.norm(m.name)
                if not name:
                    continue
                data = t.extractfile(m).read() if m.isreg() else None
                if skip_control and name.startswith("."):
                    control[name] = data
                    continue
                m.name = name
                if m.islnk():
                    m.linkname = self.norm(m.linkname)
                m.pax_headers = {}
                self.entries[name] = (m, data)
        return control

    def get(self, path):
        entry = self.entries.get(path)
        return entry[1] if entry else None

    def put(self, path, data, mode=0o644):
        if isinstance(data, str):
            data = data.encode()
        info = tarfile.TarInfo(path)
        info.size, info.mode, info.mtime = len(data), mode, int(time.time())
        self.entries[path] = (info, data)

    def symlink(self, path, target):
        info = tarfile.TarInfo(path)
        info.type, info.linkname, info.mode = tarfile.SYMTYPE, target, 0o777
        info.mtime = int(time.time())
        self.entries[path] = (info, None)

    def mkdir(self, path, mode=0o755):
        if path not in self.entries:
            info = tarfile.TarInfo(path)
            info.type, info.mode, info.mtime = tarfile.DIRTYPE, mode, int(time.time())
            self.entries[path] = (info, None)

    def write(self, out):
        # v86's fs2json drops entries whose parent directory hasn't appeared yet,
        # so emit every ancestor directory before its first child.
        emitted = set()
        with tarfile.open(out, "w", format=tarfile.GNU_FORMAT) as t:
            def emit(path):
                if path in emitted:
                    return
                parent = path.rpartition("/")[0]
                if parent:
                    emit(parent)
                if path in self.entries:
                    info, data = self.entries[path]
                else:
                    info, data = tarfile.TarInfo(path), None
                    info.type, info.mode, info.mtime = tarfile.DIRTYPE, 0o755, int(time.time())
                t.addfile(info, io.BytesIO(data) if data is not None else None)
                emitted.add(path)

            for path in self.entries:
                emit(path)


def installed_packages(rootfs):
    db = rootfs.get("lib/apk/db/installed") or b""
    return [line[2:] for line in db.decode().splitlines() if line.startswith("P:")]


def configure(rootfs, installed):
    inittab = rootfs.get("etc/inittab").decode()
    inittab = re.sub(r"^tty1::respawn:.*$",
                     "tty1::respawn:/sbin/agetty --autologin root --noclear tty1 linux",
                     inittab, flags=re.M)
    inittab = re.sub(r"^(tty[2-6]::respawn:.*)$", r"#\1", inittab, flags=re.M)
    inittab = re.sub(r"^#?ttyS0::respawn:.*$\n?", "", inittab, flags=re.M)
    inittab += "ttyS0::respawn:/sbin/agetty --autologin root -L -s ttyS0 115200 vt100\n"
    rootfs.put("etc/inittab", inittab)

    shadow = rootfs.get("etc/shadow").decode()
    rootfs.put("etc/shadow", re.sub(r"^root:[^:]*:", "root::", shadow, flags=re.M), 0o640)

    rootfs.put("etc/hostname", "dbvm\n")
    rootfs.put("etc/hosts", "127.0.0.1\tdbvm localhost\n::1\tlocalhost\n")
    rootfs.mkdir("root/Downloads")  # host file drops land here
    rootfs.put("etc/fstab", "# root is the v86 9p share (host9p), mounted by the initramfs\n")
    rootfs.put("etc/apk/world", "\n".join(sorted(set(PACKAGES + DESKTOP_PACKAGES + ARCH_PACKAGES[ARCH]))) + "\n")
    if "flatpak" in ARCH_PACKAGES[ARCH]:
        rootfs.put("etc/flatpak/remotes.d/flathub.flatpakrepo", fetch(FLATHUB_REPO, "flathub.flatpakrepo"))

    for path in sorted(OVERLAY.rglob("*")):
        rel = path.relative_to(OVERLAY).as_posix()
        if path.is_dir():
            rootfs.mkdir(rel)
        elif path.name != ".DS_Store":
            rootfs.put(rel, path.read_bytes(), 0o755 if path.stat().st_mode & 0o111 else 0o644)

    for level, services in RUNLEVELS.items():
        rootfs.mkdir(f"etc/runlevels/{level}")
        for svc in services:
            if f"etc/init.d/{svc}" in rootfs.entries:
                rootfs.symlink(f"etc/runlevels/{level}/{svc}", f"/etc/init.d/{svc}")
            else:
                log(f"warning: no init script for {svc}")

    # Record packages so apk knows they exist (file lists are not tracked).
    db = (rootfs.get("lib/apk/db/installed") or b"").decode().rstrip("\n")
    rootfs.put("lib/apk/db/installed", db + "\n\n" + "\n\n".join(installed) + "\n")


# --- initramfs --------------------------------------------------------------

def cpio_newc(files):
    """files: list of (path, mode, data, rdev_major, rdev_minor)."""
    out = io.BytesIO()
    ino = 1

    def entry(name, mode, data, maj=0, minr=0):
        nonlocal ino
        name_b = name.encode() + b"\0"
        hdr = "070701" + "".join(f"{v:08X}" for v in (
            ino, mode, 0, 0, 1, 0, len(data), 0, 0, maj, minr, len(name_b), 0))
        ino += 1
        out.write(hdr.encode() + name_b)
        out.write(b"\0" * (-out.tell() % 4))
        out.write(data)
        out.write(b"\0" * (-out.tell() % 4))

    for f in files:
        entry(*f)
    entry("TRAILER!!!", 0, b"")
    return out.getvalue()


def build_initramfs(pkgs, rootfs):
    static = pkgs["busybox-static"]
    raw = fetch(apk_url(static), f"{static['name']}-{static['version']}.apk")
    bb = RootFS()
    bb.add_apk(raw)
    busybox = bb.get("bin/busybox.static")

    modules_root = next(p for p in rootfs.entries if re.fullmatch(r"lib/modules/[^/]+", p))
    files = [(d, 0o040755, b"") for d in
             ("bin", "dev", "proc", "sys", "newroot", "lib", "lib/modules")]
    files.append(("dev/console", 0o020600, b"", 5, 1))
    files.append(("bin/busybox", 0o100755, busybox))
    root = ROOTS[ARCH]
    init = INIT_SCRIPT.format(modules=" ".join(root["modules"]), mount=root["mount"])
    files.append(("init", 0o100755, init.encode()))
    for mod in root["modules"]:
        path = next(p for p in rootfs.entries
                    if p.startswith(modules_root) and p.endswith(f"/{mod}.ko.gz"))
        files.append((f"lib/modules/{mod}.ko", 0o100644, gzip.decompress(rootfs.get(path))))
    return gzip.compress(cpio_newc(files), 9)


def apk_url(pkg):
    return f"{MIRROR}/v{ALPINE_VERSION}/{pkg['repo']}/{ARCH}/{pkg['name']}-{pkg['version']}.apk"


def main():
    global ARCH
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--arch", choices=sorted(ROOTS), default="x86")
    ap.add_argument("--out-tar")
    ap.add_argument("--out-boot")
    args = ap.parse_args()
    ARCH = args.arch
    suffix = "" if ARCH == "x86" else f"-{ARCH}"
    args.out_tar = args.out_tar or str(DBVM_CACHE / "build" / f"rootfs{suffix}.tar")
    args.out_boot = args.out_boot or str(DBVM_CACHE / "images" / ("alpine" if ARCH == "x86" else "alpine64"))

    rootfs = RootFS()
    name = f"alpine-minirootfs-{MINIROOTFS}-{ARCH}.tar.gz"
    rootfs.add_tar(io.BytesIO(fetch(f"{MIRROR}/v{ALPINE_VERSION}/releases/{ARCH}/{name}", name)))

    pkgs = load_indexes()
    wanted = PACKAGES + DESKTOP_PACKAGES + ARCH_PACKAGES[ARCH]
    todo = resolve(pkgs, wanted, installed_packages(rootfs))
    log(f"installing {len(todo)} packages")
    triggers = []
    for i, p in enumerate(todo):
        raw = fetch(apk_url(p), f"{p['name']}-{p['version']}.apk")
        control = rootfs.add_apk(raw)
        stem = f"{SCRIPTS_DIR}/{i:03d}-{p['name']}"
        for kind in (".pre-install", ".post-install", ".trigger"):
            if control.get(kind):
                rootfs.put(stem + kind, control[kind], 0o755)
        info = (control.get(".PKGINFO") or b"").decode()
        for line in info.splitlines():
            if line.startswith("triggers = ") and control.get(".trigger"):
                triggers.append(f"{i:03d}-{p['name']}.trigger {line[len('triggers = '):]}")
    rootfs.put("etc/dbvm/triggers", "\n".join(triggers) + "\n")

    configure(rootfs, [p["record"] for p in todo])

    boot = Path(args.out_boot)
    boot.mkdir(parents=True, exist_ok=True)
    (boot / "vmlinuz-virt").write_bytes(rootfs.get("boot/vmlinuz-virt"))
    (boot / "initramfs.img").write_bytes(build_initramfs(pkgs, rootfs))

    Path(args.out_tar).parent.mkdir(parents=True, exist_ok=True)
    rootfs.write(args.out_tar)
    size = sum(len(d) for _, d in rootfs.entries.values() if d)
    log(f"wrote {args.out_tar} ({len(rootfs.entries)} entries, {size / 1048576:.1f} MB)")
    log(f"wrote {boot}/vmlinuz-virt and initramfs.img")


if __name__ == "__main__":
    main()
