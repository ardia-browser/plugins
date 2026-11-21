#!/usr/bin/env bash
# Usage: .github/release/sign-macos.sh <cli folder>
#        .github/release/sign-macos.sh --check <assets dir> <version>
#   The first form is plugins/cli/build.sh's ARDIA_SIGN_CMD (sh -c "$ARDIA_SIGN_CMD" ardia-sign <out>/cli): it
#   Developer ID-signs bin/ardia, bin/ardia-libc.so, libexec/esbuild and any other Mach-O in the folder with one
#   identity, the hardened runtime, a secure timestamp and no entitlements, sends them to Apple's notary service in one
#   submission, fails unless it comes back Accepted, then checks each against the Developer ID requirement for
#   $APPLE_TEAM_ID. build.sh packs both tarballs from the folder afterwards.
#   The second form checks what build.sh packed: every Mach-O in cli-plugin-<version>-macos-arm64.tar.gz and
#   ardia-cli-<version>-macos-arm64.tar.gz is signed for $APPLE_TEAM_ID with the hardened runtime, and the packed
#   ardia says <version>. It fails when the hook didn't run, so an unsigned command is never released.
#   Signing needs, from the cli-release environment: DEVELOPER_ID_P12_BASE64, DEVELOPER_ID_P12_PASSWORD,
#   ASC_API_KEY_P8_BASE64, ASC_API_KEY_ID, ASC_API_ISSUER_ID and APPLE_TEAM_ID, and stops before touching anything
#   when one is missing. --check needs APPLE_TEAM_ID.
set -euo pipefail

case "${1:-}" in '' | -h | --help) sed -n '2,15s/^# \{0,1\}//p' "$0"; [ -n "${1:-}" ] && exit 0 || exit 64 ;; esac

die() { echo "::error::sign-macos: $*" >&2; exit 1; }

expect_mach_os=(bin/ardia bin/ardia-libc.so libexec/esbuild)

need() {
  local missing=() name
  for name in "$@"; do [ -n "${!name:-}" ] || missing+=("$name"); done
  [ "${#missing[@]}" = 0 ] || die "missing ${missing[*]}: the macOS command can't be signed and checked, so nothing is released"
  [[ "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || die "APPLE_TEAM_ID isn't a team ID"
  [ "$(uname -s)" = Darwin ] || die "this needs macOS"
}

requirement() {
  echo "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$APPLE_TEAM_ID\""
}

machos() {
  find "$1" -type f -print0 | while IFS= read -r -d '' file; do
    if file -b "$file" | grep -q '^Mach-O'; then printf '%s\0' "$file"; fi
  done
}

verify_tree() {
  local root=$1 label=$2 count=0 file details expected
  for expected in "${expect_mach_os[@]}"; do
    [ -f "$root/$expected" ] || die "$label has no $expected"
  done
  while IFS= read -r -d '' file; do
    codesign --verify --strict --test-requirement="=$(requirement)" "$file" >/dev/null 2>&1 \
      || die "${file#$root/} in $label isn't Developer ID-signed by $APPLE_TEAM_ID"
    details=$(codesign -dv "$file" 2>&1)
    [[ "$details" == *"flags="*"runtime"* && "$details" == *"TeamIdentifier=$APPLE_TEAM_ID"* && "$details" == *"Timestamp="* ]] \
      || die "${file#$root/} in $label isn't signed with the hardened runtime and a timestamp by $APPLE_TEAM_ID"
    count=$((count + 1))
  done < <(machos "$root")
  [ "$count" -ge "${#expect_mach_os[@]}" ] || die "$label has $count signed Mach-Os, not at least ${#expect_mach_os[@]}"
  echo "$label: $count Mach-Os signed by $APPLE_TEAM_ID with the hardened runtime"
}

check() {
  local assets version entry name top unpacked links work
  assets=$(cd "${1:?usage: sign-macos.sh --check <assets dir> <version>}" && pwd)
  version=${2:?usage: sign-macos.sh --check <assets dir> <version>}
  need APPLE_TEAM_ID
  work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sign-check.XXXXXX")
  trap 'rm -rf "'"$work"'"' EXIT
  for entry in "cli-plugin-$version-macos-arm64.tar.gz:cli" "ardia-cli-$version-macos-arm64.tar.gz:ardia-cli-$version"; do
    name=${entry%%:*}
    top=${entry#*:}
    [ -f "$assets/$name" ] || die "no $name in $assets"
    (cd "$assets" && shasum -a 256 -c "$name.sha256" >/dev/null) || die "$name doesn't match its .sha256"
    unpacked="$work/${name%.tar.gz}"
    mkdir -p "$unpacked"
    tar -xzf "$assets/$name" -C "$unpacked"
    links=$(find "$unpacked" -type l | head -n 5)
    [ -z "$links" ] || die "$name has links, which Ardia refuses: $links"
    [ -d "$unpacked/$top" ] || die "$name has no $top/ folder"
    verify_tree "$unpacked/$top" "$name"
    [ "$("$unpacked/$top/bin/ardia" --version)" = "ardia $version" ] || die "the ardia in $name doesn't say $version"
  done
}

sign() {
  local folder keychain keychain_password identity signed=0 file submission status id work
  folder=$(cd "$1" && pwd)
  need DEVELOPER_ID_P12_BASE64 DEVELOPER_ID_P12_PASSWORD ASC_API_KEY_P8_BASE64 ASC_API_KEY_ID ASC_API_ISSUER_ID APPLE_TEAM_ID
  [ -f "$folder/plugin.json" ] || die "$folder isn't the cli plugin folder"
  work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sign-macos.XXXXXX")
  keychain="$work/signing.keychain-db"
  trap 'security delete-keychain "'"$keychain"'" >/dev/null 2>&1 || true; rm -rf "'"$work"'"' EXIT
  keychain_password=$(openssl rand -hex 24)
  printf '%s' "$DEVELOPER_ID_P12_BASE64" | base64 --decode >"$work/identity.p12" || die "DEVELOPER_ID_P12_BASE64 isn't base64"
  printf '%s' "$ASC_API_KEY_P8_BASE64" | base64 --decode >"$work/notary.p8" || die "ASC_API_KEY_P8_BASE64 isn't base64"
  chmod 600 "$work/identity.p12" "$work/notary.p8"
  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 3600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$work/identity.p12" -k "$keychain" -P "$DEVELOPER_ID_P12_PASSWORD" -T /usr/bin/codesign >/dev/null \
    || die "the certificate couldn't be imported (is DEVELOPER_ID_P12_PASSWORD right?)"
  security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
  identity=$(security find-identity -v -p codesigning "$keychain" | awk -F'"' -v team="($APPLE_TEAM_ID)" '/Developer ID Application:/ && index($2, team) { print $2; exit }')
  [ -n "$identity" ] || die "the certificate holds no Developer ID Application identity for team $APPLE_TEAM_ID"
  echo "Signing as $identity"
  while IFS= read -r -d '' file; do
    codesign --force --options runtime --timestamp --keychain "$keychain" --sign "$identity" "$file" >/dev/null 2>&1 \
      || die "codesign failed on ${file#$folder/}"
    signed=$((signed + 1))
  done < <(machos "$folder")
  echo "Signed $signed Mach-Os"
  verify_tree "$folder" "the signed folder"
  ditto -c -k --keepParent "$folder" "$work/notarize.zip"
  submission=$(xcrun notarytool submit "$work/notarize.zip" --key "$work/notary.p8" --key-id "$ASC_API_KEY_ID" --issuer "$ASC_API_ISSUER_ID" \
    --wait --timeout 45m --output-format json) || die "notarytool submit failed: $submission"
  status=$(printf '%s' "$submission" | /usr/bin/python3 -I -c 'import json, sys; print(json.load(sys.stdin).get("status", ""))')
  id=$(printf '%s' "$submission" | /usr/bin/python3 -I -c 'import json, sys; print(json.load(sys.stdin).get("id", ""))')
  if [ "$status" != Accepted ]; then
    [ -z "$id" ] || xcrun notarytool log "$id" --key "$work/notary.p8" --key-id "$ASC_API_KEY_ID" --issuer "$ASC_API_ISSUER_ID" >&2 || true
    die "notarization came back '$status', not Accepted (submission ${id:-none})"
  fi
  echo "Notarized: submission $id Accepted"
}

if [ "$1" = --check ]; then
  shift
  check "$@"
else
  [ "$#" = 1 ] || die "usage: sign-macos.sh <cli folder>"
  sign "$1"
fi
