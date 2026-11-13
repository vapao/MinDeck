#!/bin/sh
set -eu
# Filled by build-release.mjs; downloads stay pinned to the script's release.
repository='@REPOSITORY@'
version='@VERSION@'
[ "$(uname -s)" = Darwin ] || { echo 'MinDeck Finder requires macOS.' >&2; exit 1; }
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;;
esac
case "$repository" in *'<'*|*'@'*) echo 'Release repository is not configured.' >&2; exit 1 ;; esac
staging=$(mktemp -d "${TMPDIR:-/tmp}/mindeck-helper.XXXXXX")
trap 'rm -rf "$staging"' EXIT HUP INT TERM
archive="mindeck-helper-darwin-$arch.tar.gz"
base="https://github.com/$repository/releases/download/$version"
echo "Downloading MinDeck Finder $version ($arch)…"
curl -fL --retry 3 "$base/$archive" -o "$staging/$archive"
curl -fsSL --retry 3 "$base/$archive.sha256" -o "$staging/$archive.sha256"
(cd "$staging" && shasum -a 256 -c "$archive.sha256")
tar -xzf "$staging/$archive" -C "$staging"
# Prepare and check the complete app before replacing an existing installation.
codesign --verify --deep --strict "$staging/MinDeck Finder.app"
app_dir="$HOME/Applications/MinDeck Finder.app"
mkdir -p "$HOME/Applications"
rm -rf "$app_dir"
cp -R "$staging/MinDeck Finder.app" "$app_dir"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app_dir"
printf '\nInstalled: %s\nReturn to MinDeck Settings to configure Finder mapping and SSH, save, then use Test Finder / Test SSH.\nRun this command again to update.\n' "$app_dir"
