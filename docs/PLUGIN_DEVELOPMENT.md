# Develop a SneeAI Codex plugin extension

The official SneeAI plugin may be studied and modified under the license declared in `plugins/infinite-canvas/LICENSE`. A custom distribution must use its own name and identity so users can distinguish it from the SneeAI-maintained plugin.

## Safe extension surface

You may customize prompts, skills, tool descriptions, workflows, tool composition, and presentation. You may add tools when the remote SneeAI MCP service explicitly exposes and authorizes them. Keep the remote MCP protocol compatible with [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

Do not copy website credentials or OAuth tokens into a plugin, bypass service confirmation, select arbitrary users, profiles, browser sessions, or canvases, broaden file-system access, connect to an undeclared endpoint, or download executable code dynamically. The SneeAI service remains the enforcement point even when the plugin is custom.

## Create a separate plugin

1. Copy `plugins/infinite-canvas` to a new directory outside the official plugin path.
2. Change the manifest name, display name, description, repository, and assets. Do not publish a modified plugin under the `sneeai` identity.
3. Keep the remote MCP server name and HTTPS origin declared in `.mcp.json`; preserve the documented protocol major version.
4. Add or modify skills without embedding API keys, OAuth client secrets, refresh tokens, or bearer tokens.
5. Run manifest, remote MCP declaration, and compatibility tests before installation.
6. Install the custom plugin through Codex's supported local marketplace workflow.

The remote SneeAI service and a custom plugin update independently. A custom plugin must declare which protocol versions it supports and must fail clearly when they are incompatible.

## Validation checklist

- The manifest is valid and has a unique plugin identity.
- The MCP configuration connects only to the declared HTTPS SneeAI origin and uses Codex-managed OAuth.
- Missing OAuth authorization, missing canvas, protocol mismatch, timeout, and denied authorization produce understandable errors.
- Read tools can run concurrently where supported; canvas writes are not duplicated.
- No test invokes a paid model or requires production credentials.
- Logs and diagnostic bundles contain no tokens, keys, prompts, canvas contents, or private file paths.

The repository does not yet publish a standalone schema/type package. Treat the plugin contract test and the deployed service's versioned tool schemas as the compatibility boundary until a public package is released. Plugin tests validate declarations and documentation; they do not prove that the remote endpoint or OAuth service is deployed.
