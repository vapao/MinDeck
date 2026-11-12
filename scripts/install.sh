#!/bin/sh
set -eu
# Filled by build-release.mjs from release-config.json and the release tag.
repository='@REPOSITORY@'
version='@VERSION@'
[ "$(uname -s)" = Darwin ] || { echo 'MinDeck requires macOS.' >&2; exit 1; }
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;;
esac
install_root=${MINDECK_INSTALL_ROOT:-"$HOME/.mindeck"}
if [ "${1:-}" = uninstall ]; then
  exec "$install_root/app/bin/node" "$install_root/app/scripts/install.mjs" uninstall
fi
[ "${1:-install}" = install ] || { echo 'Usage: install.sh [install|uninstall]' >&2; exit 1; }
staging=$(mktemp -d "${TMPDIR:-/tmp}/mindeck-install.XXXXXX")
trap 'rm -rf "$staging"' EXIT HUP INT TERM
archive="mindeck-darwin-$arch.tar.gz"
if [ -n "${MINDECK_ARCHIVE:-}" ]; then
  cp "$MINDECK_ARCHIVE" "$staging/$archive"
  cp "$MINDECK_ARCHIVE.sha256" "$staging/$archive.sha256"
else
  case "$repository" in *'<'*|*'@'*) echo 'Release repository is not configured.' >&2; exit 1 ;; esac
  base="https://github.com/$repository/releases/download/$version"
  echo "Downloading MinDeck $version ($arch)…"
  curl -fL --retry 3 "$base/$archive" -o "$staging/$archive"
  curl -fsSL --retry 3 "$base/$archive.sha256" -o "$staging/$archive.sha256"
fi
(cd "$staging" && shasum -a 256 -c "$archive.sha256")
mkdir "$staging/app"
tar -xzf "$staging/$archive" -C "$staging/app"
"$staging/app/bin/node" "$staging/app/scripts/install.mjs" install
