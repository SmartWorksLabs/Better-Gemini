#!/bin/sh
# Zip extensions for the Chrome Web Store: dist/<folder>-<version>.zip
# Run from the repo root: scripts/package.sh [folder ...]   (default: all three)
set -e
cd "$(dirname "$0")/.."
mkdir -p dist
for folder in ${@:-hide-chat-bar usage versions}; do
  version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$folder/manifest.json")
  out="dist/$folder-$version.zip"
  rm -f "$out"
  (cd "$folder" && zip -qr "../$out" . -x 'test/*' 'store/*' 'icons/logo.png' '*.md' '.DS_Store')
  echo "$out"
done
