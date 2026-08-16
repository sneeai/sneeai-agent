# Archived local Agent release and update policy

> This document applies only to the retained local-runtime compatibility sources. The supported SneeAI user path is the hosted remote MCP service declared by the official Codex plugin. No local installer or compatibility archive may be presented as required for that flow.

## Delivery channels

The release system has two deliberately separate channels:

- **Installer channel:** the intended end-user delivery. Windows uses a signed per-user EXE; macOS uses signed and notarized per-user PKGs.
- **Compatibility archive channel:** reproducible ZIP/TAR artifacts for development, recovery, and installer input. An archive is not a one-click installer and must not be advertised as one.

`canvas-agent/scripts/build-release.mjs` produces compatibility archives, SHA-256 files, and `manifest.json`. The manifest includes an installer delivery plan with `status: not_built` until a target-specific builder, signing job, and clean-device gate exist. This status is factual release metadata, not a promise that the expected installer file is present.

The compatibility archive publisher does not own or delete EXE/PKG files. Installer artifacts are published only by the separate signed installer gate, preventing a routine archive rebuild from removing or replacing a verified installer. A ZIP or TAR file cannot satisfy that gate, even if it is renamed with an `.exe` or `.pkg` extension.

The installer gate may change an entry to `published` only when all of the following are true:

- the expected EXE/PKG and its checksum file exist in the release directory;
- the artifact's computed SHA-256 matches the checksum file, installer metadata, and build evidence;
- evidence target, Agent version, release ID, source archive, source archive digest, and artifact name match the release manifest;
- `publishable` is `true`, `status` is `published`, and `blockers` is empty;
- the platform signature is independently verified;
- macOS notarization and stapling are independently verified;
- clean-device install, upgrade, rollback, and uninstall evidence records `rollback.status: verified`.

The build scripts always emit `publishable: false`. Building or locally verifying a signature is not publication approval. Only the independent release gate may write publishable evidence after it has verified the artifact bytes and lifecycle results.

## Build evidence contract

Each EXE/PKG is accompanied by `<artifact>.sha256` and `<artifact>.build.json`. Build evidence uses schema version 1 and records, at minimum:

```json
{
  "schemaVersion": 1,
  "target": "darwin-arm64",
  "agentVersion": "0.3.5",
  "releaseId": "0.3.5+source-build-id",
  "sourceArchive": "sneeai-agent-0.3.5-macos-arm64.tar.gz",
  "sourceArchiveSha256": "lowercase SHA-256",
  "artifact": "sneeai-agent-0.3.5-macos-arm64.pkg",
  "sha256": "lowercase SHA-256",
  "status": "built_unsigned_local_test",
  "signature": { "required": true, "status": "not_performed" },
  "notarization": { "required": true, "status": "not_performed" },
  "rollback": { "strategy": "staged-replace", "status": "not_verified" },
  "publishable": false,
  "blockers": ["Signing, notarization, and lifecycle gates remain."]
}
```

Evidence is declarative and must not contain signing keys, notarization credentials, passwords, access tokens, or provider configuration. A syntactically valid digest is not proof: the release gate recomputes hashes from the artifact and source archive before accepting the evidence.

## Version and compatibility

Every release records one Agent version, build ID, bundled Codex runtime version, target architecture, archive digest, and installer status. The stable local bridge protocol remains backward compatible within its declared protocol range. An Agent update must not silently rewrite a user's Codex plugin, provider credentials, canvas data, or website account.

Release gates must maintain a tested compatibility matrix covering:

- current and previous supported Agent versions;
- the official plugin and the public custom-plugin contract;
- Windows x64, macOS arm64, and macOS x64;
- direct, manual system-proxy, explicit system-PAC, and environment-proxy network environments;
- fresh install, repair, upgrade, rollback, and uninstall.

## Safe update behavior

Updates must be staged in a separate file, verified by signature and SHA-256, and applied only when the Agent is not executing a tool operation. The updater must stop the old process, atomically replace the executable, start the new process, verify health and protocol compatibility, then delete the rollback copy. Failure restores the previous executable and startup registration.

The website may show an update only when a published installer exists for the user's platform and the release manifest has passed artifact, signing/notarization, and rollback gates. A planned, missing, unsigned, unnotarized, hash-mismatched, or lifecycle-unverified artifact must never trigger an update prompt.

## Secrets and provenance

Release jobs must not embed website tickets, Agent tokens, provider credentials, proxy passwords, signing secrets, or notarization credentials. Store signing material in protected CI infrastructure. Publish build provenance, dependency/SBOM results, signatures, and checksums alongside the artifact without exposing secrets.

## Current blocker

This repository contains installer source and fail-closed build interfaces, but no signed output or production signing infrastructure. Windows EXE construction cannot be executed on this macOS workspace, and macOS publication still requires real Developer ID identities, notarization credentials, and clean-device tests. Validate the manifest structure with:

```bash
node installer/release-plan.mjs --manifest canvas-agent/release/manifest.json --require-ready
```

The expected exit status is `2` until the platform work is completed and the manifest is updated by a verified release job.

When installer artifacts and build evidence are present, run the repository's release-file verifier as a separate gate. It must reject missing artifacts, checksum mismatches, evidence identity mismatches, unsigned Windows packages, unnotarized macOS packages, and unverified rollback evidence. Do not manually edit a failed entry to `published`; regenerate evidence from the protected release job.
