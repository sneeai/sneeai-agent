# Archived local Agent installer delivery

> This directory is retained for compatibility and historical development. The official SneeAI Codex plugin now uses the hosted remote MCP service and does not require this installer.

This directory defines the installer handoff without pretending that an EXE or PKG already exists. The current release builder continues to produce reproducible ZIP/TAR compatibility archives. `canvas-agent/release/manifest.json` now also records the expected installer target, its lifecycle mode, and every unresolved signing or platform-validation blocker.

Validate a release manifest with:

```bash
node installer/release-plan.mjs --manifest canvas-agent/release/manifest.json
```

Use `--require-ready` in a release gate. It exits with status `2` until every installer entry is actually published. A release job must never change `status`, signature, or notarization fields merely because an unsigned file exists.

## Required user experience

- Windows delivers a per-user, code-signed EXE installer.
- macOS delivers a per-user, Developer ID signed and notarized PKG.
- The Agent runs in the signed-in user's session, starts at login, stays in the background, and does not require an open terminal.
- The Codex plugin remains a separate user-installed component. The Agent installer must not silently install or modify Codex plugins.
- Reinstalling the same version is idempotent; upgrades preserve supported user configuration; downgrades require an explicit recovery flow.
- Uninstall removes the executable, startup registration, updater state, and installation-owned files. Deleting user configuration or credentials requires an explicit user choice.

## Build boundary

The repository contains an Inno Setup 6 handoff on Windows and the platform-provided `pkgbuild`/`productbuild` tools on macOS. Build scripts never download a toolchain or embed credentials. They fail closed unless the required host tools and signing parameters are supplied; an explicit local-test flag is required to create an unsigned artifact. See [Windows](windows/README.md), [macOS](macos/README.md), and [release policy](../docs/AGENT_RELEASE.md).

Build entry points:

```text
installer/windows/build.ps1
installer/macos/build-pkg.sh
```

Both scripts emit an artifact checksum and a `.build.json` evidence file. That evidence remains `publishable: false` until a separate clean-device release gate verifies installation, launch, upgrade, rollback, and uninstall. The release channel must update the public manifest only after that gate succeeds.
