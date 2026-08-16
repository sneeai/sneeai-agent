# SneeAI Agent

Sneeai Agent is the independent local runtime for SneeAI. Users download and update it separately from the Codex plugin. It runs on the user's computer, listens only on `127.0.0.1`, and connects the SneeAI website to the user's local Codex.

## Start locally

Build and run this source checkout with `npm run build` followed by `npm start`.

For diagnostics:

After building, run `node dist/index.js doctor` or `node dist/index.js version`.

The Agent stores non-secret local configuration in `~/.sneeai-agent/sneeai-agent.json`. On macOS the Connect token is stored in the current user's Keychain; on Windows it is protected with current-user DPAPI. Existing plaintext configuration is migrated on the next runtime start without rotating the token. The Agent never sends the user's Codex credentials to SneeAI.

External Agent requests honor an explicit Agent proxy, a concrete Windows/macOS system PAC URL or manual system proxy, standard proxy environment variables, then direct access. WPAD without a concrete PAC URL is reported as unsupported. Loopback traffic always bypasses proxies.

`npm run build:release` currently creates reproducible ZIP/TAR compatibility archives plus SHA-256 files and a release manifest. It does not create, sign, or notarize an end-user installer. The manifest records the expected EXE/PKG targets as `not_built` so a release channel cannot mistake an archive for an installer. See [installer/README.md](../installer/README.md).

## Website pairing

The website discovers the loopback Agent, verifies its protocol and device identity, then issues a short-lived authorization ticket. The Agent must be running before the website can connect. Agent updates do not require a Codex plugin update as long as the stable protocol remains compatible.

## Codex plugin boundary

The Codex plugin bundles its small bridge, which only forwards MCP calls to this already-installed local Agent. The bridge never starts, downloads, or upgrades the Agent.

## Development

```bash
cd canvas-agent
npm install
npm run typecheck
npm test
npm run build
```

The current package version is defined by `package.json`. Publish an installer only after its platform signing, clean-device lifecycle, rollback, and uninstall gates pass. Compatibility archives remain available for development and recovery.
