# Develop a SneeAI Codex plugin extension

The official SneeAI plugin may be studied and modified under the license declared in `plugins/infinite-canvas/LICENSE`. A custom distribution must use its own name and identity so users can distinguish it from the SneeAI-maintained plugin.

## Safe extension surface

You may customize prompts, skills, tool descriptions, workflows, tool composition, and presentation. You may add tools when the local Agent explicitly exposes and authorizes them. Keep the local bridge protocol compatible with [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

Do not copy website credentials into a plugin, bypass Agent confirmation, select arbitrary profiles or browser sessions, broaden file-system access, connect to a remote Agent, or download executable code dynamically. The Agent remains the enforcement point even when the plugin is custom.

## Create a separate plugin

1. Copy `plugins/infinite-canvas` to a new directory outside the official plugin path.
2. Change the manifest name, display name, description, repository, and assets. Do not publish a modified plugin under the `sneeai` identity.
3. Keep the MCP bridge command local and preserve the documented protocol major version.
4. Add or modify skills without embedding API keys or long-lived tokens.
5. Run manifest, bridge, and compatibility tests before installation.
6. Install the custom plugin through Codex's supported local marketplace workflow.

The official Agent and a custom plugin update independently. A custom plugin must declare which Agent/protocol versions it supports and must fail clearly when they are incompatible.

## Validation checklist

- The manifest is valid and has a unique plugin identity.
- The bridge connects only to a verified loopback Agent.
- Missing Agent, missing canvas, protocol mismatch, timeout, and denied authorization produce understandable errors.
- Read tools can run concurrently where supported; canvas writes are not duplicated.
- No test invokes a paid model or requires production credentials.
- Logs and diagnostic bundles contain no tokens, keys, prompts, canvas contents, or private file paths.

The repository does not yet publish a standalone schema/type package. Treat the shipped bridge and runtime tests as the executable compatibility contract until a versioned public package is released.
