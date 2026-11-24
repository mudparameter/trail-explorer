#!/bin/sh
# Lets the development copy of Electron use its sandbox on Ubuntu 24.04 and later.
#
# Ubuntu stops apps from creating user namespaces unless an AppArmor profile
# allows it, and Electron's sandbox needs them. Without this, `npm start` and
# `npm run dev` stop with "The SUID sandbox helper binary was found, but is not
# configured correctly". Installed apps (the .deb) bring their own profile.
#
# Run once per checkout:  sudo scripts/linux-sandbox.sh
# The profile names this checkout's path, so it keeps working after npm ci.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
electron="$root/node_modules/electron/dist/electron"
profile=/etc/apparmor.d/trail-explorer-dev

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo $0" >&2
  exit 1
fi

cat > "$profile" <<EOF
# Lets Electron in $root use its sandbox. Made by scripts/linux-sandbox.sh.
abi <abi/4.0>,
include <tunables/global>

profile trail-explorer-dev "$electron" flags=(unconfined) {
  userns,
}
EOF
apparmor_parser --replace "$profile"
echo "Installed $profile for $electron"
