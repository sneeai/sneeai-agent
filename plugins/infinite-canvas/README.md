# SneeAI Codex Plugin

SneeAI is configured as a Codex plugin for the SneeAI remote MCP service. The target connection uses Codex's streamable HTTP transport and user-scoped OAuth; it does not start a Node process, require a local bridge, or ask the user to copy an Agent URL or token.

This repository contains the client declaration, not the remote MCP or OAuth server. The endpoint and its OAuth metadata must be deployed and verified before this plugin is released as usable.

## Install

```bash
git clone https://github.com/sneeai/sneeai-agent.git
cd sneeai-agent
codex plugin marketplace add "$(pwd)"
codex plugin add sneeai@sneeai
```

Windows PowerShell uses `"$PWD"` instead of `"$(pwd)"`.

## Use

1. Install this Codex plugin once.
2. Start a Codex task that uses SneeAI. If authorization is missing, the plugin starts the
   supported `codex mcp login sneeai` flow and opens the authorization page for you; you do not
   need to copy a URL, run a command, or configure a token.
3. Approve the requested SneeAI permissions in the opened page, then say: `打开并连接 SneeAI Canvas`.

Codex stores and refreshes the OAuth session for the public client `sneeai-codex-plugin`. This client ID is not a secret. The plugin never receives a website password, refresh token, API key, local file path, or another user's session. If the remote MCP service is unavailable or authorization expires, Codex reports a retryable connection error and offers OAuth login again.

The remote endpoint is declared in `.mcp.json` as `https://sneeai.com/api/v1/agent/mcp`. It must advertise standard MCP OAuth metadata before a production release; a configuration file alone does not create the server endpoint.

Use Codex's supported MCP OAuth login flow when the service requests authorization. The plugin's
`open-canvas` skill starts `codex mcp login sneeai`, opens the returned authorization URL, waits for
the local callback, and retries the canvas connection. Do not put a bearer token in this repository
or in plugin configuration.

The plugin keeps the existing SneeAI tool names and protocol-major compatibility contract. Additive response fields are safe; removing a tool or narrowing its arguments requires a protocol-major change.

## Secondary development

This plugin directory is licensed under `AGPL-3.0-only`. Custom distributions must use a distinct plugin name, branding, and marketplace identity. Plugins may extend prompts, skills, workflows, and authorized tools, but must not bypass service authorization, read website credentials, or choose arbitrary users or browser sessions.

See [plugin development](../../docs/PLUGIN_DEVELOPMENT.md) and the [Agent protocol boundary](../../docs/AGENT_PROTOCOL.md).
