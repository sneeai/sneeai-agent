# SneeAI Agent plugin protocol boundary

This document defines the stable boundary for the official Codex plugin and user-developed plugins. It documents ownership and compatibility; it does not expose website credentials or allow plugins to select arbitrary user sessions.

## Responsibilities

The plugin supplies the local Agent endpoint/token discovered by the supported local configuration, a tool name, validated tool arguments, and a unique operation identifier when the protocol supports it. The Agent owns authentication, authorization, active-canvas selection, session isolation, write serialization, duplicate suppression, and user confirmation for privileged operations.

A plugin must not depend on website `profileId`, browser `clientId`, pairing tickets, internal ports, or Agent storage paths. Those values are Agent implementation details. A custom plugin must use the same local contract as the official plugin and cannot bypass Agent policy.

## Compatibility rules

- Existing tool names and accepted argument shapes remain compatible within a protocol major version.
- Additive response fields are allowed; clients must ignore unknown fields.
- Removing a tool, narrowing accepted input, or changing tool semantics requires a new protocol major version.
- Unsupported versions fail clearly before a tool is executed.
- Missing or ambiguous canvas state is a normal connection error, not permission to guess another user or tab.
- A repeated operation identifier returns the recorded result and must not execute the same write twice.

`POST /api/tools` accepts a UUID `operationId` beside `name` and `input`. The official bridge creates one identifier per MCP invocation and preserves it across HTTP retries. Within the same isolated Agent session, the first invocation owns that identifier; concurrent and later retries with the same tool and normalized input reuse its pending or recorded result. Reusing the identifier with different content fails with `operation_id_conflict`. The bounded cache is intentionally in-memory, so an Agent restart clears unfinished work instead of replaying it.

The Agent advertises automatic local routing as `mcp.active-canvas.v1`. It is additive rather than a required legacy-plugin capability: existing plugins keep sending only the local endpoint/token, while the Agent selects the most recently activated valid canvas. The plugin remains unaware of browser session identifiers.

The persistent local plugin token cannot select a profile. When the website starts its own nested Codex MCP for an Agent turn, the Agent supplies a separate, short-lived `internal-mcp` ticket bound to that exact profile. This internal credential is accepted only without a browser origin and only on the local tool endpoint; custom plugins do not receive it. Ordinary plugin calls always use the current active canvas, while the internal nested MCP may retain the canvas bound to its running website turn.

## Security boundary

The local endpoint remains loopback-only and authenticates every request. Browser origin checks, short-lived website tickets, local plugin credentials, and privileged-tool confirmation are separate controls. Possession of an installed plugin does not grant file, command, or cross-user access.

Custom plugins must never read or log long-lived website tokens, provider keys, proxy passwords, or another system user's Agent configuration. They must not connect to arbitrary remote Agents or download executable code at runtime.

## Error contract

Expected connection failures should use stable machine-readable codes such as `canvas_not_connected`, `canvas_binding_ambiguous`, `canvas_binding_expired`, or `protocol_incompatible`. Plugins should present a concise recovery action and must not loop indefinitely or repeatedly execute a write after an uncertain response.

The runtime implementation and exact schemas remain authoritative. When public schemas are introduced, they must be versioned and covered by contract tests before this document claims them as stable.
