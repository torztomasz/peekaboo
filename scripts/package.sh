#!/bin/sh
# Builds a zip a reviewer can unpack and "Load unpacked" in Chrome: only what Chrome needs, inside one
# folder named after the extension, so it doesn't spill files into Downloads.
set -eu
cd "$(dirname "$0")/.."
npm run build --silent
version=$(node -p 'require("./manifest.json").version')
stage=$(mktemp -d)
mkdir "$stage/peekaboo"
cp -R manifest.json options.html dist icons "$stage/peekaboo/"
rm -f "$stage"/peekaboo/icons/*.svg
mkdir -p release
rm -f "release/peekaboo-$version.zip"
(cd "$stage" && zip -qr - peekaboo) > "release/peekaboo-$version.zip"
rm -rf "$stage"
echo "release/peekaboo-$version.zip"
