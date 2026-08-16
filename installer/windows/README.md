# Windows installer contract

Expected artifact: `sneeai-agent-<version>-windows-x64.msi`.

The installer must be built and tested on Windows. The current macOS/Linux development environment cannot certify MSI behavior, Authenticode signing, Windows Defender reputation, or per-user startup behavior.

Build from a Visual Studio Developer PowerShell with an already-installed WiX v4 CLI:

```powershell
.\installer\windows\build.ps1 `
  -AgentVersion 0.3.5 `
  -PayloadDirectory .\payload\sneeai-agent-0.3.5-windows-x64 `
  -OutputDirectory .\release
```

Set `SNEEAI_WINDOWS_SIGNING_THUMBPRINT` to a certificate in the protected Windows certificate store. The script does not install WiX, download certificates, or accept a certificate password. `-AllowUnsigned` exists only for local MSI lifecycle tests and always emits `publishable: false` evidence.

## Installation lifecycle

- Install for the current user without requiring a SYSTEM service.
- Place binaries in a per-user application directory and data in the existing per-user SneeAI configuration directory.
- Register one background start-at-login entry and enforce a single Agent instance.
- Start the Agent after installation and leave no console window open.
- Use the small Windows-subsystem launcher to start the console-subsystem Agent with `CREATE_NO_WINDOW`.
- Before upgrade or uninstall, the launcher stops only a process whose full executable path exactly matches the installed Agent path.
- Preserve compatible configuration during repair and upgrade.
- Stop the running Agent before replacement, verify the new process, and roll back when replacement fails.
- Remove installer-owned binaries and startup entries during uninstall. Offer configuration removal separately.

## Release gate

Before `status` can become `published`, the release job must verify:

1. The MSI product/upgrade identifiers and upgrade rules were reviewed.
2. The package and contained executables have valid Authenticode signatures.
3. The SHA-256 digest in the public release manifest matches the uploaded file.
4. Clean Windows 11 install, repair, upgrade, uninstall, reboot, port-conflict, and standard-user tests pass.
5. The Agent still listens only on loopback and does not add an inbound firewall rule.

The signing certificate and its password must remain in protected CI signing infrastructure, never in source files, installer properties, logs, or release metadata.
