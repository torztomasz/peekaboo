#!/bin/sh
# Builds a zip a reviewer can unpack and "Load unpacked" in Chrome: only what Chrome needs, inside one
# folder named after the extension, so it doesn't spill files into Downloads.
set -eu
cd "$(dirname "$0")/.."
npm run build --silent
version=$(node -p 'require("./manifest.json").version')
stage=$(mktemp -d)
mkdir "$stage/before-after-compare"
cp -R manifest.json dist icons "$stage/before-after-compare/"
rm -f "$stage/before-after-compare/icons/icon.svg"
mkdir -p release
rm -f "release/before-after-compare-$version.zip"
(cd "$stage" && zip -qr - before-after-compare) > "release/before-after-compare-$version.zip"
rm -rf "$stage"
echo "release/before-after-compare-$version.zip"
