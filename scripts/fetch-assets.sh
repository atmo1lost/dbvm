#!/bin/sh
# Fetches the stock v86 Buildroot kernel used for Phase 0 into public/images/.
# BIOS files are committed under public/bios/ (copied from copy/v86, LGPL).
set -eu

cd "$(dirname "$0")/.."
mkdir -p public/images

fetch() {
    name="$1"
    if [ -f "public/images/$name" ]; then
        echo "have $name"
    else
        echo "fetching $name"
        curl -fL --progress-bar -o "public/images/$name.part" "https://i.copy.sh/$name"
        mv "public/images/$name.part" "public/images/$name"
    fi
}

fetch buildroot-bzimage68.bin
