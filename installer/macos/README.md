# macOS installer contract

Expected artifacts:

- `sneeai-agent-<version>-macos-arm64.pkg`
- `sneeai-agent-<version>-macos-x64.pkg`

The installer must be built and tested on macOS. The package is not publishable until it is signed with a Developer ID Installer identity, accepted by Apple notarization, and successfully stapled and verified.

Build on macOS with the platform-provided packaging tools:

```bash
SNEEAI_MACOS_APPLICATION_IDENTITY='Developer ID Application: ...' \
SNEEAI_MACOS_INSTALLER_IDENTITY='Developer ID Installer: ...' \
SNEEAI_MACOS_NOTARY_PROFILE='sneeai-notary' \
./installer/macos/build-pkg.sh \
  --version 0.3.5 \
  --arch arm64 \
  --payload ./payload/sneeai-agent-0.3.5-macos-arm64 \
  --output ./release
```

The notarization profile must already exist in Keychain. The script does not create credentials or print them. `ALLOW_UNSIGNED=1` and `ALLOW_UNNOTARIZED=1` are explicit local-test overrides; their build evidence is never publishable.

## Installation lifecycle

- Install the executable for the current user.
- Register a user-level LaunchAgent, not a LaunchDaemon.
- Run in the signed-in user's graphical session without an open Terminal window.
- Enforce one Agent instance and preserve compatible per-user configuration during upgrade.
- Stop the existing process before replacement and restore the prior executable if launch verification fails.
- Uninstall the LaunchAgent and installer-owned files. Offer Keychain/configuration cleanup separately.

The package includes `uninstall-agent.sh`. Running it preserves `~/.sneeai-agent` by default; `--remove-data` explicitly removes that user-owned configuration after stopping the LaunchAgent.

## Release gate

Before `status` can become `published`, the release job must verify:

1. Package scripts and file ownership were reviewed for both architectures.
2. `pkgutil --check-signature` succeeds with the expected team identity.
3. `xcrun notarytool` reports acceptance and `xcrun stapler validate` succeeds.
4. Gatekeeper accepts a clean download without bypass instructions.
5. Clean Apple Silicon and Intel install, upgrade, uninstall, login, sleep/wake, and standard-user tests pass.
6. The SHA-256 digest in the public release manifest matches the uploaded file.

Developer certificates, App Store Connect credentials, API keys, and Keychain profiles must remain in protected CI infrastructure and must never be written to repository files or logs.
