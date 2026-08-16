#!/bin/bash
set -euo pipefail
export COPYFILE_DISABLE=1

usage() {
  cat >&2 <<'EOF'
Usage: build-pkg.sh --version <x.y.z> --arch <arm64|x64> --payload <dir> --output <dir>

Required for a publishable build:
  SNEEAI_MACOS_APPLICATION_IDENTITY   Developer ID Application identity
  SNEEAI_MACOS_INSTALLER_IDENTITY     Developer ID Installer identity
  SNEEAI_MACOS_NOTARY_PROFILE         notarytool Keychain profile

Local package construction may use ALLOW_UNSIGNED=1. A signed build without
notarization requires ALLOW_UNNOTARIZED=1. Neither override is publishable.
EOF
  exit 2
}

version=""
arch=""
payload=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || usage; version="$2"; shift 2 ;;
    --arch) [ "$#" -ge 2 ] || usage; arch="$2"; shift 2 ;;
    --payload) [ "$#" -ge 2 ] || usage; payload="$2"; shift 2 ;;
    --output) [ "$#" -ge 2 ] || usage; output="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
case "$arch" in arm64|x64) ;; *) usage ;; esac
[ -d "$payload" ] || { echo "Payload directory does not exist: $payload" >&2; exit 1; }
payload="$(cd "$payload" && pwd -P)"
[ -x "$payload/sneeai-agent" ] || { echo "Payload must contain an executable sneeai-agent at its root." >&2; exit 1; }
mkdir -p "$output"
output="$(cd "$output" && pwd -P)"

for command in pkgbuild productbuild pkgutil shasum file xattr; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required build tool is missing: $command" >&2; exit 1; }
done
if [ "$arch" = "arm64" ]; then
  /usr/bin/file "$payload/sneeai-agent" | /usr/bin/grep -q 'arm64' || { echo "Agent payload is not arm64." >&2; exit 1; }
  host_arch="arm64"
else
  /usr/bin/file "$payload/sneeai-agent" | /usr/bin/grep -q 'x86_64' || { echo "Agent payload is not x86_64." >&2; exit 1; }
  host_arch="x86_64"
fi

script_directory="$(cd "$(dirname "$0")" && pwd -P)"
stage="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/sneeai-agent-pkg.XXXXXX")"
trap '/bin/rm -rf "$stage"' EXIT
root="$stage/root"
install_directory="$root/Library/Application Support/SneeAI/Agent"
launch_agents="$root/Library/LaunchAgents"
mkdir -p "$install_directory" "$launch_agents" "$stage/packages"
/bin/cp -R "$payload"/. "$install_directory"/
/bin/cp "$script_directory/com.sneeai.agent.plist" "$launch_agents/com.sneeai.agent.plist"
/bin/cp "$script_directory/uninstall-agent.sh" "$install_directory/uninstall-agent.sh"
/usr/bin/find "$root" \( -name '.DS_Store' -o -name '._*' \) -delete
/usr/bin/xattr -cr "$root"
/bin/chmod 700 "$install_directory/sneeai-agent" "$install_directory/uninstall-agent.sh"
/bin/chmod 600 "$launch_agents/com.sneeai.agent.plist"

application_identity="${SNEEAI_MACOS_APPLICATION_IDENTITY:-}"
installer_identity="${SNEEAI_MACOS_INSTALLER_IDENTITY:-}"
notary_profile="${SNEEAI_MACOS_NOTARY_PROFILE:-}"
signed=0
notarized=0
if [ -z "$application_identity" ] || [ -z "$installer_identity" ]; then
  [ "${ALLOW_UNSIGNED:-0}" = "1" ] || { echo "Developer ID Application and Installer identities are required." >&2; exit 1; }
else
  command -v codesign >/dev/null 2>&1 || { echo "codesign is required." >&2; exit 1; }
  while IFS= read -r -d '' candidate; do
    if /usr/bin/file "$candidate" | /usr/bin/grep -q 'Mach-O'; then
      /usr/bin/codesign --force --options runtime --timestamp --sign "$application_identity" "$candidate"
      /usr/bin/codesign --verify --strict --verbose=2 "$candidate"
    fi
  done < <(/usr/bin/find "$install_directory" -type f -print0)
  signed=1
fi

component="$stage/packages/sneeai-agent-component.pkg"
/usr/bin/pkgbuild \
  --root "$root" \
  --scripts "$script_directory/scripts" \
  --identifier com.sneeai.agent \
  --version "$version" \
  --install-location / \
  "$component"

distribution="$stage/Distribution.xml"
/usr/bin/sed -e "s/__AGENT_VERSION__/$version/g" -e "s/__HOST_ARCH__/$host_arch/g" "$script_directory/Distribution.xml.in" > "$distribution"
artifact_name="sneeai-agent-$version-macos-$arch.pkg"
artifact="$output/$artifact_name"
if [ "$signed" -eq 1 ]; then
  /usr/bin/productbuild --distribution "$distribution" --package-path "$stage/packages" --sign "$installer_identity" "$artifact"
  /usr/sbin/pkgutil --check-signature "$artifact"
else
  /usr/bin/productbuild --distribution "$distribution" --package-path "$stage/packages" "$artifact"
fi

if [ "$signed" -eq 1 ] && [ -n "$notary_profile" ]; then
  /usr/bin/xcrun notarytool submit "$artifact" --keychain-profile "$notary_profile" --wait
  /usr/bin/xcrun stapler staple "$artifact"
  /usr/bin/xcrun stapler validate "$artifact"
  notarized=1
elif [ "$signed" -eq 1 ] && [ "${ALLOW_UNNOTARIZED:-0}" != "1" ]; then
  echo "SNEEAI_MACOS_NOTARY_PROFILE is required for a signed release build." >&2
  exit 1
fi

digest="$(/usr/bin/shasum -a 256 "$artifact" | /usr/bin/awk '{print $1}')"
/usr/bin/printf '%s  %s\n' "$digest" "$artifact_name" > "$artifact.sha256"
if [ "$notarized" -eq 1 ]; then
  status="built_signed_notarized_unverified"
elif [ "$signed" -eq 1 ]; then
  status="built_signed_unnotarized_local_test"
else
  status="built_unsigned_local_test"
fi
/usr/bin/printf '{\n  "schemaVersion": 1,\n  "target": "darwin-%s",\n  "agentVersion": "%s",\n  "artifact": "%s",\n  "sha256": "%s",\n  "status": "%s",\n  "signed": %s,\n  "notarized": %s,\n  "publishable": false,\n  "remainingGate": "Clean-device lifecycle and release-channel verification are required."\n}\n' \
  "$arch" "$version" "$artifact_name" "$digest" "$status" \
  "$([ "$signed" -eq 1 ] && echo true || echo false)" \
  "$([ "$notarized" -eq 1 ] && echo true || echo false)" \
  > "$artifact.build.json"
