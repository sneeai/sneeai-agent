# SneeAI Agent plugin protocol boundary

This document defines the target stable boundary for the official Codex plugin and user-developed plugins. The plugin is configured to reach the remote SneeAI MCP service over streamable HTTP and OAuth; local Node bridges are not part of the supported distribution path. The remote MCP endpoint and OAuth metadata are release prerequisites and are not implemented by the plugin configuration itself. This document describes ownership and compatibility; it is not evidence that the remote service has been deployed.

## Responsibilities

The plugin supplies an MCP server name, tool name, validated tool arguments, and a unique operation identifier when the protocol supports it. Codex owns the remote OAuth session. The SneeAI service owns authentication, authorization, active-canvas selection, user isolation, write serialization, duplicate suppression, and user confirmation for privileged operations.

A plugin must not depend on website `profileId`, browser `clientId`, OAuth tokens, pairing tickets, internal ports, Agent storage paths, or another user's identifiers. Those values are service implementation details. A custom plugin must use the same remote MCP contract as the official plugin and cannot bypass service policy.

## Compatibility rules

- Existing tool names and accepted argument shapes remain compatible within a protocol major version.
- Additive response fields are allowed; clients must ignore unknown fields.
- Removing a tool, narrowing accepted input, or changing tool semantics requires a new protocol major version.
- Unsupported versions fail clearly before a tool is executed.
- Missing or ambiguous canvas state is a normal connection error, not permission to guess another user or tab.
- A repeated operation identifier returns the recorded result and must not execute the same write twice.

The remote service must support a unique operation identifier for every write when the public tool schema exposes one. Codex or the calling plugin preserves that identifier across transport retries. For the same OAuth subject, a repeated identifier with the same tool and normalized input returns the pending or recorded result; reusing it with different content fails with `operation_id_conflict`. Idempotency ownership and retention belong to the remote service, not to plugin-local memory.

The target service capability for current-canvas routing is `mcp.active-canvas.v1`. It is additive rather than a required legacy-plugin capability: existing tool names and argument shapes remain valid, while the service selects the most recently activated valid canvas for the authorized OAuth subject. The plugin remains unaware of browser session identifiers. Production documentation may state that this capability is available only after the server advertises it.

OAuth credentials are managed by Codex and are never embedded in plugin files, prompts, URLs, or tool arguments. Every remote request is evaluated for the signed-in OAuth subject; a plugin cannot choose a profile, browser client, or canvas outside that subject. Website-internal tickets, if used by the service, are not exposed to plugins.

## Security boundary

The remote endpoint must require HTTPS and authenticate every request. OAuth subject checks, service-side canvas binding, transport protections, and privileged-tool confirmation are separate controls. Possession of an installed plugin does not grant file, command, or cross-user access.

Custom plugins must never read or log OAuth tokens, provider keys, proxy passwords, or another system user's Agent configuration. They must connect only to the declared SneeAI MCP origin and must not download executable code at runtime.

## Error contract

Expected connection failures should use stable machine-readable codes such as `canvas_not_connected`, `canvas_binding_ambiguous`, `canvas_binding_expired`, or `protocol_incompatible`. Plugins should present a concise recovery action and must not loop indefinitely or repeatedly execute a write after an uncertain response.

The runtime implementation and exact schemas remain authoritative. When public schemas are introduced, they must be versioned and covered by contract tests before this document claims them as stable.
