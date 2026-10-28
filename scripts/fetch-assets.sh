#!/bin/sh
# Fetches the stock v86 Buildroot kernel into $DBVM_CACHE/images/ (served at /images).
# BIOS files are committed under public/bios/ (copied from copy/v86, LGPL).
set -eu

IMAGES="${DBVM_CACHE:-$HOME/Library/Caches/dbvm}/images"
mkdir -p "$IMAGES"

fetch() {
    name="$1"
    if [ -f "$IMAGES/$name" ]; then
        echo "have $name"
    else
        echo "fetching $name"
        curl -fL --progress-bar -o "$IMAGES/$name.part" "https://i.copy.sh/$name"
        mv "$IMAGES/$name.part" "$IMAGES/$name"
    fi
}

fetch buildroot-bzimage68.bin
