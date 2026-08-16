# SneeAI

SneeAI connects Codex to the active canvas through the SneeAI-hosted remote MCP service. The supported user flow is: install the SneeAI plugin in Codex, sign in to `sneeai.com`, unlock Agent, and approve the Codex OAuth request. Users do not install Node.js, download a local Agent, copy ports, URLs, or tokens, or keep a desktop process open.

## Install the Codex plugin

```bash
git clone https://github.com/sneeai/sneeai-agent.git
cd sneeai-agent
codex plugin marketplace add "$(pwd)"
codex plugin add sneeai@sneeai
```

On Windows PowerShell, use `$PWD` instead of `$(pwd)`.

## Current remote service

The official plugin declares `https://sneeai.com/api/v1/agent/mcp` as a streamable HTTP MCP server. Codex owns the OAuth session; the SneeAI service owns user isolation, entitlement checks, active-canvas routing, operation authorization, and duplicate suppression.

The endpoint, OAuth metadata, and browser canvas gateway must be deployed together before the production flow is usable.

## Archived local runtime

`canvas-agent/`, `plugin-bridge/`, and `installer/` remain as compatibility and historical development sources. They are not part of the supported user installation path, and the official plugin no longer bundles or starts the local Node bridge. See [the archived release policy](docs/AGENT_RELEASE.md) when maintaining those sources.

## Plugin extensions

The plugin source is available for secondary development under its declared license. Custom builds must use a distinct identity and keep the Agent security boundary intact. Start with [docs/PLUGIN_DEVELOPMENT.md](docs/PLUGIN_DEVELOPMENT.md) and [docs/AGENT_PROTOCOL.md](docs/AGENT_PROTOCOL.md).
