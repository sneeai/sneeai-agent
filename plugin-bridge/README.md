# Archived SneeAI Codex bridge source

> This bridge is retained for compatibility and development. The official plugin no longer bundles or starts it and instead connects to the hosted remote MCP service.

This package builds the small MCP bridge shipped inside the SneeAI Codex plugin. It forwards supported tool calls to the separately installed loopback Agent. It does not download, start, update, or configure the Agent.

The bridge must remain independent of website `profileId`, browser `clientId`, pairing tickets, and provider credentials. Active-canvas routing and authorization belong to the Agent. See [the protocol boundary](../docs/AGENT_PROTOCOL.md).

Development commands:

```bash
npm run typecheck
npm test
npm run build
```

Changes to request or response shapes require compatibility tests against the current Agent. A custom plugin should use a separate plugin identity and follow [PLUGIN_DEVELOPMENT.md](../docs/PLUGIN_DEVELOPMENT.md).
