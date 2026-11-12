#!/bin/sh
set -eu
app_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MINDECK_INSTALL_ROOT=$(dirname "$app_dir") exec "$app_dir/bin/node" "$app_dir/scripts/install.mjs" uninstall
