import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { KAPEAI_RELAY_BASE_URL } from "../agent/codex-provider-policy.js";
import { codexRuntimeFingerprint } from "../agent/codex-runtime.js";
import { AGENT_SERVICE, BUILD_ID, RELEASE_ID, VERSION } from "../config.js";
import { createAgentTicket } from "../pairing-ticket.js";
import { CANVAS_PROFILE_HEADER } from "../profile.js";
import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION } from "../protocol.js";
import { postCanvasAgentTool } from "./mcp.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEV_ORIGIN = "http://127.0.0.1:3100";

test("the plugin MCP process starts a protocol-clean HTTP bridge", async (t) => {
    const fixture = await runtimeFixture(t);
    fs.mkdirSync(fixture.codexHome, { recursive: true });
    fs.writeFileSync(path.join(fixture.codexHome, "config.toml"), `model_provider = "custom"\n[model_providers.custom]\nname = "KapeAI"\nbase_url = "${KAPEAI_RELAY_BASE_URL}"\n`);
    const child = startMcpRuntime(fixture, { debug: true });
    t.after(() => stopChild(child));

    await waitForAgent(fixture.url);
    await delay(100);
    assert.equal(child.stdoutText(), "");
    assert.ok(fs.readdirSync(path.join(fixture.home, ".sneeai-agent", "logs")).some((file) => file.startsWith("canvas-agent-")));
    child.stdin?.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "runtime-test", version: "1.0.0" } },
    })}\n`);
    await waitFor(() => child.stdoutText().length > 0, 2_000);
    const protocolMessages = child.stdoutText().split("\n").map((line) => JSON.parse(line) as { id?: number; result?: unknown });
    assert.equal(protocolMessages.some((message) => message.id === 1 && Boolean(message.result)), true);

    const configResponse = await fetch(`${fixture.url}/config`, { headers: { origin: DEV_ORIGIN } });
    const publicConfig = await configResponse.json() as Record<string, unknown>;
    assert.equal(configResponse.status, 200);
    assert.equal("token" in publicConfig, false);
    assert.match(String(publicConfig.deviceId || ""), /^d1:[A-Za-z0-9_-]{43}$/);
    assert.equal(publicConfig.protocolVersion, PROTOCOL_VERSION);
    assert.equal(publicConfig.buildVersion, VERSION);
    assert.equal(publicConfig.buildId, BUILD_ID);
    assert.equal(publicConfig.releaseId, RELEASE_ID);
    assert.equal(configResponse.headers.get("x-canvas-agent-build-id"), BUILD_ID);
    assert.equal(configResponse.headers.get("x-canvas-agent-release-id"), RELEASE_ID);

    const untrustedConfig = await fetch(`${fixture.url}/config`, { headers: { origin: "https://evil.example" } }).then((response) => response.json()) as Record<string, unknown>;
    assert.equal("deviceId" in untrustedConfig, false);

    const health = await fetch(`${fixture.url}/health`).then((response) => response.json()) as Record<string, unknown>;
    assert.equal(health.protocolVersion, PROTOCOL_VERSION);
    assert.equal(health.buildVersion, VERSION);
    assert.equal(health.buildId, BUILD_ID);
    assert.equal(health.releaseId, RELEASE_ID);
    assert.deepEqual(health.capabilities, PROTOCOL_CAPABILITIES);
    assert.equal(typeof health.diagnostics, "object");
    assert.equal(health.agentOnline, true);
    assert.equal(health.sitePaired, false);
    assert.equal(health.activeCanvas, false);
    assert.equal(health.pluginInstalled, false);
    assert.equal(health.pluginVersion, null);
    assert.equal(health.mcpActiveCanvas, false);
    assert.equal(health.mcpLastSeenAt, null);

    const denied = await fetch(`${fixture.url}/pair`, { method: "POST", headers: { origin: "https://evil.example" } });
    assert.equal(denied.status, 403);
    const disguised = await fetch(`${fixture.url}/pair`, { method: "POST", headers: { origin: "https://attacker@sneeai.com" } });
    assert.equal(disguised.status, 403);

    const incompatible = await fetch(`${fixture.url}/pair`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION + 1, capabilities: ["pairing.v1"] }),
    });
    const incompatibleBody = await incompatible.json() as { code?: string };
    assert.equal(incompatible.status, 426);
    assert.equal(incompatibleBody.code, "protocol_incompatible");

    const missingToolAuthorization = await fetch(`${fixture.url}/pair`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: PROTOCOL_CAPABILITIES.filter((capability) => capability !== "tool.authorization.v1"),
        }),
    });
    const missingToolAuthorizationBody = await missingToolAuthorization.json() as { code?: string; missingCapabilities?: string[] };
    assert.equal(missingToolAuthorization.status, 426);
    assert.equal(missingToolAuthorizationBody.code, "protocol_incompatible");
    assert.ok(missingToolAuthorizationBody.missingCapabilities?.includes("tool.authorization.v1"));

    const legacyPair = await fetch(`${fixture.url}/pair`, { method: "POST", headers: { origin: DEV_ORIGIN } });
    assert.equal(legacyPair.status, 426);

    const invalidPairClient = await fetch(`${fixture.url}/pair`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json" },
        body: modernPairBody({ clientId: "x".repeat(201) }),
    });
    assert.equal(invalidPairClient.status, 400);

    const invalidProofClient = await fetch(`${fixture.url}/pairing/proof`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json" },
        body: modernPairBody({ clientId: "bad\nclient", challenge: "unused" }),
    });
    assert.equal(invalidProofClient.status, 400);

    const paired = await fetch(`${fixture.url}/pair`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json" },
        body: modernPairBody({ clientId: "pair-client" }),
    });
    const connection = await paired.json() as { ok?: boolean; url?: string; token?: string; deviceId?: string; protocolVersion?: number; capabilities?: string[]; buildVersion?: string; pairingTicket?: string; pairingTicketExpiresAt?: number };
    assert.equal(paired.status, 200);
    assert.equal(connection.ok, true);
    assert.equal(connection.url, fixture.url);
    assert.ok(connection.token);
    assert.equal(connection.deviceId, publicConfig.deviceId);
    assert.equal(connection.protocolVersion, PROTOCOL_VERSION);
    assert.equal(connection.buildVersion, VERSION);
    assert.ok(connection.capabilities?.includes("pairing.ticket.v1"));
    assert.match(connection.pairingTicket || "", /^cat1\./);
    assert.equal(Number.isSafeInteger(connection.pairingTicketExpiresAt), true);
    assert.ok(connection.pairingTicketExpiresAt! > Date.now());

    const workspace = await fetch(`${fixture.url}/agent/codex/workspace`, {
        headers: { origin: DEV_ORIGIN, "x-canvas-agent-token": connection.token!, "x-canvas-client-id": "pair-client" },
    });
    assert.equal(workspace.status, 200);
    assert.equal(fs.existsSync(path.join(fixture.home, ".sneeai-agent", "codex-workspaces", "site", "AGENTS.md")), true);

    const wrongOrigin = await fetch(`${fixture.url}/agent/codex/workspace`, {
        headers: { origin: "https://evil.example", "x-canvas-agent-token": connection.token!, "x-canvas-client-id": "pair-client" },
    });
    assert.equal(wrongOrigin.status, 403);

    const localMcp = await fetch(`${fixture.url}/agent/codex/workspace`, {
        headers: { "x-canvas-agent-token": connection.token!, "x-canvas-client-id": "pair-client" },
    });
    assert.equal(localMcp.status, 200);

    const runtime = await fetchRuntime(fixture.url, connection.token!);
    assert.match(runtime.fingerprint, /^v1:[a-f0-9]{64}$/);
    assert.match(runtime.claim, /^v1:[a-f0-9]{24}:[a-f0-9]{8}$/);
    assert.equal(runtime.busy, false);

    const hiddenRuntime = await fetch(`${fixture.url}/agent/runtime`);
    assert.equal(hiddenRuntime.status, 401);

    const wrongClient = await fetch(`${fixture.url}/agent/codex/workspace`, {
        headers: { origin: DEV_ORIGIN, "x-canvas-agent-token": connection.token!, "x-canvas-client-id": "other-client" },
    });
    assert.equal(wrongClient.status, 401);

    const invalidAuthenticatedClient = await fetch(`${fixture.url}/agent/codex/workspace`, {
        headers: { origin: DEV_ORIGIN, "x-canvas-agent-token": connection.token!, "x-canvas-client-id": "x".repeat(201) },
    });
    assert.equal(invalidAuthenticatedClient.status, 400);

    const invalidEventTicketClient = await fetch(`${fixture.url}/agent/events-ticket`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json", "x-canvas-agent-token": connection.token! },
        body: JSON.stringify({ clientId: "bad\u0000client" }),
    });
    assert.equal(invalidEventTicketClient.status, 400);

    const blankEventTicketClient = await fetch(`${fixture.url}/agent/events-ticket`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json", "x-canvas-agent-token": connection.token! },
        body: JSON.stringify({ clientId: " " }),
    });
    assert.equal(blankEventTicketClient.status, 400);

    const ticketResponse = await fetch(`${fixture.url}/agent/events-ticket`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json", "x-canvas-agent-token": connection.token! },
        body: JSON.stringify({ clientId: "pair-client" }),
    });
    const ticketBody = await ticketResponse.json() as { ticket?: string };
    assert.equal(ticketResponse.status, 200);
    assert.match(ticketBody.ticket || "", /^cat1\./);
    const queryTicket = await fetch(`${fixture.url}/events?ticket=${ticketBody.ticket}`, { headers: { origin: DEV_ORIGIN, "x-canvas-client-id": "pair-client" } });
    assert.equal(queryTicket.status, 401);
    const ticketEvents = await fetch(`${fixture.url}/events`, { headers: { origin: DEV_ORIGIN, "x-canvas-agent-ticket": ticketBody.ticket!, "x-canvas-client-id": "pair-client" } });
    assert.equal(ticketEvents.status, 200);
    await ticketEvents.body?.cancel();
    const replayedTicket = await fetch(`${fixture.url}/events`, { headers: { origin: DEV_ORIGIN, "x-canvas-agent-ticket": ticketBody.ticket!, "x-canvas-client-id": "pair-client" } });
    assert.equal(replayedTicket.status, 401);

    const publicConfigAfterPairing = await fetch(`${fixture.url}/config`).then((response) => response.json()) as Record<string, unknown>;
    assert.equal("token" in publicConfigAfterPairing, false);
    assert.equal(JSON.stringify(publicConfigAfterPairing).includes(connection.token!), false);
});

test("profile-bound pairing isolates HTTP workspaces and MCP canvas state", async (t) => {
    const fixture = await runtimeFixture(t);
    fs.mkdirSync(fixture.codexHome, { recursive: true });
    fs.writeFileSync(path.join(fixture.codexHome, "config.toml"), `model_provider = "custom"\n[model_providers.custom]\nname = "KapeAI"\nbase_url = "${KAPEAI_RELAY_BASE_URL}"\n`);
    const child = startMcpRuntime(fixture);
    t.after(() => stopChild(child));
    await waitForAgent(fixture.url);

    const first = await pairProfile(fixture.url, "account-a", "client-a");
    const second = await pairProfile(fixture.url, "account-b", "client-b");
    assert.notEqual(first.profileKey, second.profileKey);
    assert.match(first.token, /^cat1\./);
    assert.deepEqual(first.negotiatedCapabilities, [...PROTOCOL_CAPABILITIES]);

    const firstWorkspace = await profileWorkspace(fixture.url, first.token);
    const secondWorkspace = await profileWorkspace(fixture.url, second.token);
    assert.notEqual(firstWorkspace, secondWorkspace);

    const firstEvents = await openProfileEvents(fixture.url, first.token, "client-a");
    const secondEvents = await openProfileEvents(fixture.url, second.token, "client-b");
    t.after(() => Promise.allSettled([firstEvents.body?.cancel(), secondEvents.body?.cancel()]));
    await postProfileState(fixture.url, first.token, "client-a", "canvas-a");
    await postProfileState(fixture.url, second.token, "client-b", "canvas-b");

    const bridgeConfig = readAgentConfig(fixture.home);
    const firstInternalTicket = createAgentTicket(bridgeConfig.token, { kind: "internal-mcp", origin: "local-internal", profileKey: first.profileKey, clientId: "nested-mcp" });
    const secondInternalTicket = createAgentTicket(bridgeConfig.token, { kind: "internal-mcp", origin: "local-internal", profileKey: second.profileKey, clientId: "nested-mcp" });
    assert.equal((await postCanvasAgentTool(bridgeConfig, "canvas_get_state", {}, { internalTicket: firstInternalTicket }) as { projectId?: string }).projectId, "canvas-a");
    assert.equal((await postCanvasAgentTool(bridgeConfig, "canvas_get_state", {}, { internalTicket: secondInternalTicket }) as { projectId?: string }).projectId, "canvas-b");
    const nestedMcpHealth = await fetch(`${fixture.url}/health`).then((response) => response.json()) as Record<string, unknown>;
    assert.equal(nestedMcpHealth.pluginInstalled, false);
    assert.equal(nestedMcpHealth.mcpLastSeenAt, null);
    const forbiddenProfileSelection = await fetch(`${fixture.url}/api/tools`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-canvas-agent-token": bridgeConfig.token,
            "x-canvas-profile-id": first.profileKey,
            "x-canvas-agent-protocol-version": String(PROTOCOL_VERSION),
            "x-canvas-agent-capabilities": "mcp.tools.v1,tool.authorization.v1",
        },
        body: JSON.stringify({ name: "canvas_get_state", input: {} }),
    });
    assert.equal(forbiddenProfileSelection.status, 401);

    const crossProfile = await fetch(`${fixture.url}/agent/codex/workspace`, { headers: { origin: DEV_ORIGIN, "x-canvas-agent-token": first.token, [CANVAS_PROFILE_HEADER]: second.profileKey } });
    assert.equal(crossProfile.status, 401);
    const tampered = `${first.token.slice(0, -1)}${first.token.endsWith("0") ? "1" : "0"}`;
    assert.equal((await fetch(`${fixture.url}/agent/codex/workspace`, { headers: { origin: DEV_ORIGIN, "x-canvas-agent-token": tampered } })).status, 401);
    assert.equal((await fetch(`${fixture.url}/agent/codex/workspace`, { headers: { origin: "https://evil.example", "x-canvas-agent-token": first.token } })).status, 403);
});

test("a non-KapeAI provider cannot pair or connect the web Agent", async (t) => {
    const fixture = await runtimeFixture(t);
    fs.mkdirSync(fixture.codexHome, { recursive: true });
    fs.writeFileSync(path.join(fixture.codexHome, "config.toml"), 'model_provider = "custom"\n[model_providers.custom]\nname = "Other relay"\nbase_url = "https://another.example/v1"\n');
    const child = startMcpRuntime(fixture);
    t.after(() => stopChild(child));

    await waitForAgent(fixture.url);
    const config = readAgentConfig(fixture.home);
    const requests = [
        fetch(`${fixture.url}/pair`, { method: "POST", headers: { origin: DEV_ORIGIN, "content-type": "application/json" }, body: modernPairBody() }),
        fetch(`${fixture.url}/agent/events-ticket`, {
            method: "POST",
            headers: { origin: DEV_ORIGIN, "content-type": "application/json", "x-canvas-agent-token": config.token },
            body: JSON.stringify({ clientId: "blocked-client" }),
        }),
        fetch(`${fixture.url}/agent/codex/workspace`, {
            headers: { origin: DEV_ORIGIN, "x-canvas-agent-token": config.token },
        }),
    ];

    for (const response of await Promise.all(requests)) {
        const body = await response.json() as { code?: string; error?: string };
        assert.equal(response.status, 403, JSON.stringify(body));
        assert.equal(body.code, "codex_provider_not_allowed");
        assert.equal((body.error || "").includes(KAPEAI_RELAY_BASE_URL), false);
    }
});

test("an independent KapeAI key lets the web Agent use a second relay", async (t) => {
    const fixture = await runtimeFixture(t);
    fs.mkdirSync(fixture.codexHome, { recursive: true });
    const hostConfig = 'model_provider = "host-relay"\n[model_providers.host-relay]\nname = "Host relay A"\nbase_url = "https://relay-a.example/v1"\n';
    fs.writeFileSync(path.join(fixture.codexHome, "config.toml"), hostConfig);
    const child = startMcpRuntime(fixture, { detached: true, env: { OPENAI_BASE_URL: "https://relay-a-env.example/v1", OPENAI_API_KEY: "host-relay-secret" } });
    t.after(() => stopRuntimeTree(child));

    await waitForAgent(fixture.url);
    const before = await fetch(`${fixture.url}/config`, { headers: { origin: DEV_ORIGIN } }).then((response) => response.json()) as Record<string, unknown>;
    assert.equal(before.codexMode, "inherit");
    assert.equal("relayBaseUrl" in before, false);
    assert.equal(before.hasRelayApiKey, false);

    const blocked = await fetch(`${fixture.url}/pair`, { method: "POST", headers: { origin: DEV_ORIGIN, "content-type": "application/json" }, body: modernPairBody() });
    assert.equal(blocked.status, 403);

    const apiKey = "kape-user-test-secret";
    const paired = await fetch(`${fixture.url}/pair`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json" },
        body: modernPairBody({ clientId: "relay-client", mode: "isolated", apiKey, relayBaseUrl: "https://attacker.example/v1" }),
    });
    const connection = await paired.json() as Record<string, unknown>;
    assert.equal(paired.status, 200, JSON.stringify(connection));
    assert.equal(connection.ok, true);
    assert.equal(connection.codexMode, "isolated");
    assert.equal("relayBaseUrl" in connection, false);
    assert.equal(connection.hasRelayApiKey, true);
    assert.equal(JSON.stringify(connection).includes(apiKey), false);

    const agentConfigFile = path.join(fixture.home, ".sneeai-agent", "sneeai-agent.json");
    const agentConfigText = fs.readFileSync(agentConfigFile, "utf8");
    assert.equal(JSON.parse(agentConfigText).codex.mode, "isolated");
    assert.equal(agentConfigText.includes(apiKey), false);
    assert.equal(fs.readFileSync(path.join(fixture.codexHome, "config.toml"), "utf8"), hostConfig);

    const isolatedHome = path.join(fixture.home, ".sneeai-agent", "codex-runtime");
    const isolatedConfig = fs.readFileSync(path.join(isolatedHome, "config.toml"), "utf8");
    const isolatedKeyFile = path.join(isolatedHome, "kapeai-api-key");
    assert.match(isolatedConfig, new RegExp(`base_url = "${KAPEAI_RELAY_BASE_URL.replaceAll(".", "\\.")}"`));
    assert.equal(isolatedConfig.includes("attacker.example"), false);
    assert.equal(isolatedConfig.includes("relay-a.example"), false);
    assert.equal(isolatedConfig.includes("relay-a-env.example"), false);
    assert.equal(fs.readFileSync(isolatedKeyFile, "utf8").trim(), apiKey);
    if (process.platform !== "win32") assert.equal(fs.statSync(isolatedKeyFile).mode & 0o777, 0o600);

    const workspace = await fetch(`${fixture.url}/agent/codex/workspace`, {
        headers: { origin: DEV_ORIGIN, "x-canvas-agent-token": String(connection.token) },
    });
    assert.equal(workspace.status, 200);

    const rejectedSwitch = await fetch(`${fixture.url}/pair`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json" },
        body: modernPairBody({ clientId: "relay-client", mode: "inherit" }),
    });
    assert.equal(rejectedSwitch.status, 403);
    const afterRejectedSwitch = await fetch(`${fixture.url}/config`, { headers: { origin: DEV_ORIGIN } }).then((response) => response.json()) as Record<string, unknown>;
    assert.equal(afterRejectedSwitch.codexMode, "isolated");
    const repairedWorkspace = await fetch(`${fixture.url}/agent/codex/workspace`, {
        headers: { origin: DEV_ORIGIN, "x-canvas-agent-token": String(connection.token) },
    });
    assert.equal(repairedWorkspace.status, 200);
});

test("concurrent plugin MCP processes reuse one HTTP bridge", async (t) => {
    const fixture = await runtimeFixture(t);
    const first = startMcpRuntime(fixture);
    const second = startMcpRuntime(fixture);
    t.after(() => Promise.all([stopChild(first), stopChild(second)]));

    await waitForAgent(fixture.url);
    await delay(250);
    assert.equal(first.exitCode, null);
    assert.equal(second.exitCode, null);
    assert.equal(first.stdoutText(), "");
    assert.equal(second.stdoutText(), "");
    const config = readAgentConfig(fixture.home);
    const initialRuntime = await fetchRuntime(fixture.url, config.token);
    await delay(100);
    assert.deepEqual(await fetchRuntime(fixture.url, config.token), initialRuntime);
});

test("legacy local plugin token routes tools to the active paired canvas", async (t) => {
    const fixture = await runtimeFixture(t);
    fs.mkdirSync(fixture.codexHome, { recursive: true });
    fs.writeFileSync(path.join(fixture.codexHome, "config.toml"), `model_provider = "custom"\n[model_providers.custom]\nname = "KapeAI"\nbase_url = "${KAPEAI_RELAY_BASE_URL}"\n`);
    const child = startMcpRuntime(fixture);
    const eventBodies: ReadableStream<Uint8Array>[] = [];
    t.after(async () => {
        await Promise.allSettled(eventBodies.map((body) => body.cancel()));
        await stopChild(child);
    });
    await waitForAgent(fixture.url);
    const persistentToken = readAgentConfig(fixture.home).token;

    const empty = await postLocalTool(fixture.url, persistentToken, "canvas_get_state");
    assert.equal(empty.response.status, 409);
    assert.equal(empty.body.code, "canvas_not_connected");
    const pluginHealth = await fetch(`${fixture.url}/health`).then((response) => response.json()) as Record<string, unknown>;
    assert.equal(pluginHealth.pluginInstalled, true);
    assert.equal(pluginHealth.pluginVersion, "0.1.0-test");
    assert.equal(pluginHealth.mcpActiveCanvas, false);
    assert.equal(typeof pluginHealth.mcpLastSeenAt, "number");

    const first = await pairProfile(fixture.url, "user-a", "client-a");
    const firstEvents = await openProfileEvents(fixture.url, first.token!, "client-a");
    if (firstEvents.body) eventBodies.push(firstEvents.body);
    await postProfileState(fixture.url, first.token!, "client-a", "project-a");
    const pairedHealth = await fetch(`${fixture.url}/health`).then((response) => response.json()) as Record<string, unknown>;
    assert.equal(pairedHealth.sitePaired, true);
    assert.equal(pairedHealth.activeCanvas, false);

    const second = await pairProfile(fixture.url, "user-b", "client-b");
    const secondEvents = await openProfileEvents(fixture.url, second.token!, "client-b");
    if (secondEvents.body) eventBodies.push(secondEvents.body);
    await postProfileState(fixture.url, second.token!, "client-b", "project-b");

    const ambiguous = await postLocalTool(fixture.url, persistentToken, "canvas_get_state");
    assert.equal(ambiguous.response.status, 409);
    assert.equal(ambiguous.body.code, "canvas_binding_ambiguous");

    await activateProfileCanvas(fixture.url, first.token!, "client-a");
    assert.equal((await postLocalTool(fixture.url, persistentToken, "canvas_get_state")).body.result?.projectId, "project-a");
    const firstActiveHealth = await fetch(`${fixture.url}/health`).then((response) => response.json()) as Record<string, unknown>;
    assert.equal(firstActiveHealth.activeCanvas, true);
    assert.equal(firstActiveHealth.mcpActiveCanvas, true);

    await activateProfileCanvas(fixture.url, second.token!, "client-b");
    assert.equal((await fetch(`${fixture.url}/health`).then((response) => response.json()) as Record<string, unknown>).mcpActiveCanvas, false);
    assert.equal((await postLocalTool(fixture.url, persistentToken, "canvas_get_state")).body.result?.projectId, "project-b");
    assert.equal((await fetch(`${fixture.url}/health`).then((response) => response.json()) as Record<string, unknown>).mcpActiveCanvas, true);

    const ticketScoped = await postTicketTool(fixture.url, first.token!, "client-a", "canvas_get_state");
    assert.equal(ticketScoped.response.status, 200);
    assert.equal(ticketScoped.body.result?.projectId, "project-a");
});

test("a changed Codex config waits for a pending canvas tool before handoff", async (t) => {
    const fixture = await runtimeFixture(t);
    fs.mkdirSync(fixture.codexHome, { recursive: true });
    fs.writeFileSync(path.join(fixture.codexHome, "config.toml"), `model_provider = "custom"\n[model_providers.custom]\nname = "KapeAI"\nbase_url = "${KAPEAI_RELAY_BASE_URL}"\n`);
    fs.writeFileSync(path.join(fixture.codexHome, "auth.json"), '{}');

    const first = startMcpRuntime(fixture);
    t.after(() => stopChild(first));
    await waitForAgent(fixture.url);
    const config = readAgentConfig(fixture.home);
    const firstRuntime = await fetchRuntime(fixture.url, config.token);
    const canvasEvents = await openProfileEvents(fixture.url, config.token, "handoff-canvas");
    const statusEvents = await openProfileEvents(fixture.url, config.token, "handoff-status");
    const statusEventsClosed = statusEvents.text();
    await activateProfileCanvas(fixture.url, config.token, "handoff-canvas");
    const pendingTool = fetch(`${fixture.url}/api/tools`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-canvas-agent-token": config.token,
            "x-canvas-agent-protocol-version": String(PROTOCOL_VERSION),
            "x-canvas-agent-capabilities": "mcp.tools.v1,tool.authorization.v1",
        },
        body: JSON.stringify({ name: "canvas_create_text_node", input: { text: "pending during handoff" } }),
    });
    await delay(50);

    fs.writeFileSync(path.join(fixture.codexHome, "config.toml"), 'model_provider = "second"\n[model_providers.second]\nbase_url = "https://second.example/v1"\n');
    const second = startMcpRuntime(fixture);
    t.after(() => stopChild(second));
    await delay(500);
    const blockedRuntime = await fetchRuntime(fixture.url, config.token);
    assert.equal(blockedRuntime.fingerprint, firstRuntime.fingerprint);

    await canvasEvents.body?.cancel();
    const secondRuntime = await waitForRuntimeChange(fixture.url, config.token, firstRuntime.fingerprint);

    assert.notEqual(secondRuntime.fingerprint, firstRuntime.fingerprint);
    assert.equal(secondRuntime.fingerprint, fixtureFingerprint(fixture));
    assert.equal(first.exitCode, null);
    assert.equal(second.exitCode, null);
    assert.equal(first.stdoutText(), "");
    assert.equal(second.stdoutText(), "");
    assert.match(await withTimeout(statusEventsClosed, 2_000), /event: hello/);
    assert.equal((await withTimeout(pendingTool, 2_000)).status, 500);
});

test("a nested MCP cannot hand off its owner while a Codex thread is starting", async (t) => {
    const fixture = await runtimeFixture(t);
    fs.mkdirSync(fixture.codexHome, { recursive: true });
    fs.writeFileSync(path.join(fixture.codexHome, "config.toml"), `openai_base_url = "${KAPEAI_RELAY_BASE_URL}"\n# runtime-a\n`);
    const owner = startMcpRuntime(fixture, { detached: true });
    t.after(() => stopRuntimeTree(owner));
    await waitForAgent(fixture.url);
    const config = readAgentConfig(fixture.home);
    fs.writeFileSync(path.join(fixture.codexHome, "config.toml"), `openai_base_url = "${KAPEAI_RELAY_BASE_URL}"\n# runtime-b\n`);

    const response = await withTimeout(fetch(`${fixture.url}/agent/codex/threads/new`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-canvas-agent-token": config.token },
        body: "{}",
    }), 12_000);
    const body = await response.json() as { ok?: boolean; error?: string };

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
});

test("a new MCP process does not hand off a busy bridge with another fingerprint", async (t) => {
    const fixture = await runtimeFixture(t);
    const token = "busy-runtime-token";
    writeConfig(fixture.home, { url: fixture.url, token });
    let handoffRequests = 0;
    const occupant = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/health") return void res.end(JSON.stringify(modernHealthBody()));
        if (req.url === "/agent/runtime" && req.headers["x-canvas-agent-token"] === token) return void res.end(JSON.stringify({ ok: true, fingerprint: `v1:${"0".repeat(64)}`, busy: true }));
        if (req.url === "/agent/runtime/handoff") {
            handoffRequests += 1;
            res.statusCode = 409;
            return void res.end(JSON.stringify({ ok: false, busy: true }));
        }
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false }));
    });
    await listen(occupant, fixture.port);
    t.after(() => closeServer(occupant));

    const child = startMcpRuntime(fixture);
    t.after(() => stopChild(child));
    await delay(500);

    assert.equal(child.exitCode, null, child.stderrText());
    assert.equal(handoffRequests, 0);
    assert.equal(child.stdoutText(), "");
});

test("a deferred handoff retries when the bridge becomes busy between probe and handoff", async (t) => {
    const fixture = await runtimeFixture(t);
    const token = "busy-race-token-0123456789abcdef";
    writeConfig(fixture.home, { url: fixture.url, token });
    let runtimeProbes = 0;
    let handoffRequests = 0;
    const occupant = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/health") return void res.end(JSON.stringify(modernHealthBody()));
        if (req.url === "/agent/runtime" && req.headers["x-canvas-agent-token"] === token) {
            runtimeProbes += 1;
            return void res.end(JSON.stringify({ ok: true, fingerprint: `v1:${"0".repeat(64)}`, busy: runtimeProbes === 1 }));
        }
        if (req.url === "/agent/runtime/handoff" && req.headers["x-canvas-agent-token"] === token) {
            handoffRequests += 1;
            if (handoffRequests === 1) {
                res.statusCode = 409;
                return void res.end(JSON.stringify({ ok: false, busy: true }));
            }
            res.statusCode = 202;
            res.once("finish", () => occupant.close());
            return void res.end(JSON.stringify({ ok: true, handoff: true }));
        }
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false }));
    });
    await listen(occupant, fixture.port);
    t.after(() => closeServerIfListening(occupant));

    const child = startMcpRuntime(fixture);
    t.after(() => stopChild(child));
    await waitFor(() => handoffRequests >= 2, 6_000);
    await waitForAgent(fixture.url);

    assert.ok(runtimeProbes >= 3);
    assert.equal(handoffRequests, 2);
    assert.equal(child.exitCode, null, child.stderrText());
});

test("a nested Codex MCP reuses its owning bridge even when fingerprints differ", async (t) => {
    const fixture = await runtimeFixture(t);
    const token = "nested-runtime-token";
    writeConfig(fixture.home, { url: "local", token });
    let runtimeProbes = 0;
    let handoffRequests = 0;
    const occupant = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/health") return void res.end(JSON.stringify(modernHealthBody()));
        if (req.url === "/agent/runtime" && req.headers["x-canvas-agent-token"] === token) {
            runtimeProbes += 1;
            return void res.end(JSON.stringify({ ok: true, fingerprint: `v1:${"0".repeat(64)}`, busy: false }));
        }
        if (req.url === "/agent/runtime/handoff") {
            handoffRequests += 1;
            res.statusCode = 202;
            return void res.end(JSON.stringify({ ok: true, handoff: true }));
        }
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false }));
    });
    await listen(occupant, fixture.port);
    t.after(() => closeServerIfListening(occupant));

    const child = startMcpRuntime(fixture, { env: { CANVAS_AGENT_NESTED_MCP: "1" } });
    t.after(() => stopChild(child));
    await waitFor(() => runtimeProbes > 0, 4_000);
    child.stdin?.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "legacy-local-test", version: "1.0.0" } },
    })}\n`);
    await waitFor(() => child.stdoutText().length > 0, 2_000);

    assert.equal(child.exitCode, null, child.stderrText());
    assert.equal(handoffRequests, 0);
    assert.equal(child.stdoutText().split("\n").map((line) => JSON.parse(line) as { id?: number; result?: unknown }).some((message) => message.id === 1 && Boolean(message.result)), true);
    assert.equal(readAgentConfig(fixture.home).url, fixture.url);
});

test("browser origins cannot request an Agent runtime handoff", async (t) => {
    const fixture = await runtimeFixture(t);
    const child = startMcpRuntime(fixture);
    t.after(() => stopChild(child));
    await waitForAgent(fixture.url);
    const config = readAgentConfig(fixture.home);

    const response = await fetch(`${fixture.url}/agent/runtime/handoff`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json", "x-canvas-agent-token": config.token },
        body: JSON.stringify({ fingerprint: `v1:${"f".repeat(64)}` }),
    });

    assert.equal(response.status, 403);
    assert.equal((await fetch(`${fixture.url}/health`)).status, 200);
});

test("older runtime claimants cannot replace a newer HTTP bridge", async (t) => {
    const fixture = await runtimeFixture(t);
    const child = startMcpRuntime(fixture);
    t.after(() => stopChild(child));
    await waitForAgent(fixture.url);
    const config = readAgentConfig(fixture.home);

    const response = await fetch(`${fixture.url}/agent/runtime/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-canvas-agent-token": config.token },
        body: JSON.stringify({ fingerprint: `v1:${"f".repeat(64)}`, claim: "v1:000000000000000000000000:00000000" }),
    });

    assert.equal(response.status, 409);
    assert.equal((await fetch(`${fixture.url}/health`)).status, 200);
});

test("unauthorized request bodies are rejected before JSON parsing", async (t) => {
    const fixture = await runtimeFixture(t);
    const child = startMcpRuntime(fixture);
    t.after(() => stopChild(child));
    await waitForAgent(fixture.url);

    const response = await fetch(`${fixture.url}/agent/codex/turn`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: "{malformed",
    });

    assert.equal(response.status, 403);
});

test("query credentials cannot authenticate protected Agent routes", async (t) => {
    const fixture = await runtimeFixture(t);
    const child = startMcpRuntime(fixture);
    t.after(() => stopChild(child));
    await waitForAgent(fixture.url);
    const config = readAgentConfig(fixture.home);

    const response = await fetch(`${fixture.url}/agent/codex/workspace?token=${encodeURIComponent(config.token)}`);
    assert.equal(response.status, 401);
});

test("a racing MCP reuses the authorized same-version server at the effective PORT", async (t) => {
    const fixture = await runtimeFixture(t);
    const stalePort = await availablePort();
    const token = "shared-runtime-token";
    writeConfig(fixture.home, { url: `http://127.0.0.1:${stalePort}`, token });
    let authenticatedProbes = 0;
    const occupant = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/health") return void res.end(JSON.stringify(modernHealthBody()));
        if (req.url === "/agent/runtime" && req.headers["x-canvas-agent-token"] === token) {
            authenticatedProbes += 1;
            return void res.end(JSON.stringify({ ok: true, fingerprint: fixtureFingerprint(fixture), busy: false }));
        }
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false }));
    });
    await listen(occupant, fixture.port);
    t.after(() => closeServer(occupant));

    const child = startMcpRuntime(fixture);
    t.after(() => stopChild(child));
    await waitFor(() => authenticatedProbes > 0 || child.exitCode !== null, 6_000);

    assert.equal(child.exitCode, null, child.stderrText());
    assert.equal(child.stdoutText(), "");
    assert.ok(authenticatedProbes > 0);
    const saved = JSON.parse(fs.readFileSync(path.join(fixture.home, ".sneeai-agent", "sneeai-agent.json"), "utf8")) as { url?: string };
    assert.equal(saved.url, fixture.url);
});

test("MCP startup rejects an incompatible port occupant", async (t) => {
    const fixture = await runtimeFixture(t);
    const occupant = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, service: "another-service", version: VERSION }));
    });
    await listen(occupant, fixture.port);
    t.after(() => closeServer(occupant));

    const child = startMcpRuntime(fixture);
    const exitCode = await waitForExit(child);

    assert.notEqual(exitCode, 0);
    assert.equal(child.stdoutText(), "");
    assert.match(child.stderrText(), /其他服务|不同版本|incompatible/i);
});

test("MCP startup rejects a same-version server with a different token", async (t) => {
    const fixture = await runtimeFixture(t);
    const occupant = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/health") return void res.end(JSON.stringify(modernHealthBody()));
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false }));
    });
    await listen(occupant, fixture.port);
    t.after(() => closeServer(occupant));

    const child = startMcpRuntime(fixture);
    const exitCode = await waitForExit(child);

    assert.notEqual(exitCode, 0);
    assert.equal(child.stdoutText(), "");
    assert.match(child.stderrText(), /token|unauthorized|不一致/i);
});

test("a lazy MCP tool call waits for the web canvas to connect", async (t) => {
    const port = await availablePort();
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    let attempts = 0;
    const operationIds = new Set<string>();
    const server = createServer((req, res) => {
        if (req.url === "/health") {
            res.setHeader("content-type", "application/json");
            return void res.end(JSON.stringify({ ok: true, service: AGENT_SERVICE, protocolVersion: PROTOCOL_VERSION, capabilities: PROTOCOL_CAPABILITIES, buildVersion: VERSION }));
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
            attempts += 1;
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { operationId?: string };
            if (body.operationId) operationIds.add(body.operationId);
            res.setHeader("content-type", "application/json");
            res.setHeader("x-canvas-agent-service", AGENT_SERVICE);
            res.setHeader("x-canvas-agent-version", VERSION);
            res.setHeader("x-canvas-agent-protocol-version", String(PROTOCOL_VERSION));
            res.setHeader("x-canvas-agent-capabilities", PROTOCOL_CAPABILITIES.join(","));
            res.setHeader("x-canvas-agent-build-version", VERSION);
            if (!ready) {
                res.statusCode = 500;
                res.end(JSON.stringify({ ok: false, error: "当前没有已连接画布" }));
                return;
            }
            res.end(JSON.stringify({ ok: true, result: { nodes: [] } }));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    setTimeout(() => (ready = true), 250);

    const result = await postCanvasAgentTool({ url, token: "test-token" }, "canvas_get_state", {});
    assert.deepEqual(result, { nodes: [] });
    assert.ok(attempts > 1);
    assert.equal(operationIds.size, 1);
});

test("MCP refuses an old bridge before posting a tool call", async (t) => {
    const port = await availablePort();
    const url = `http://127.0.0.1:${port}`;
    let toolCalls = 0;
    const server = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/health") {
            return void res.end(JSON.stringify({
                ok: true,
                service: AGENT_SERVICE,
                protocolVersion: PROTOCOL_VERSION,
                capabilities: PROTOCOL_CAPABILITIES.filter((capability) => capability !== "tool.authorization.v1"),
                buildVersion: VERSION,
            }));
        }
        if (req.url === "/api/tools") toolCalls += 1;
        res.end(JSON.stringify({ ok: true, result: {} }));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    await assert.rejects(postCanvasAgentTool({ url, token: "test-token" }, "canvas_create_text_node", { text: "must not execute" }), /协议不兼容/);
    assert.equal(toolCalls, 0);
});

async function pairProfile(url: string, profileId: string, clientId = "") {
    const response = await fetch(`${url}/pair`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
            profileId,
            ...(clientId ? { clientId } : {}),
            pairingNonce: crypto.randomBytes(32).toString("base64url"),
            protocolVersion: PROTOCOL_VERSION,
            capabilities: [...PROTOCOL_CAPABILITIES, "client.only.v1"],
        }),
    });
    const body = await response.json() as { token?: string; profileKey?: string; negotiatedCapabilities?: string[]; error?: string };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(body.token && body.profileKey);
    return { token: body.token, profileKey: body.profileKey, negotiatedCapabilities: body.negotiatedCapabilities };
}

function modernPairBody(extra: Record<string, unknown> = {}) {
    return JSON.stringify({
        clientId: "test-client",
        pairingNonce: crypto.randomBytes(32).toString("base64url"),
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...PROTOCOL_CAPABILITIES],
        ...extra,
    });
}

async function profileWorkspace(url: string, token: string) {
    const response = await fetch(`${url}/agent/codex/workspace`, { headers: { origin: DEV_ORIGIN, "x-canvas-agent-token": token } });
    const body = await response.json() as { workspace?: { workspacePath?: string }; error?: string };
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.workspace?.workspacePath || "";
}

async function openProfileEvents(url: string, token: string, clientId: string) {
    const ticketResponse = await fetch(`${url}/agent/events-ticket`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json", "x-canvas-agent-token": token },
        body: JSON.stringify({ clientId }),
    });
    const ticketBody = await ticketResponse.json() as { ticket?: string; error?: string };
    assert.equal(ticketResponse.status, 200, JSON.stringify(ticketBody));
    const response = await fetch(`${url}/events`, { headers: { origin: DEV_ORIGIN, "x-canvas-agent-ticket": ticketBody.ticket || "", "x-canvas-client-id": clientId } });
    assert.equal(response.status, 200);
    return response;
}

async function postProfileState(url: string, token: string, clientId: string, projectId: string) {
    const response = await fetch(`${url}/canvas/state?clientId=${encodeURIComponent(clientId)}`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json", "x-canvas-agent-token": token },
        body: JSON.stringify({ projectId, title: projectId, nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }),
    });
    assert.equal(response.status, 200);
}

async function activateProfileCanvas(url: string, token: string, clientId: string) {
    const response = await fetch(`${url}/canvas/activate?clientId=${encodeURIComponent(clientId)}`, {
        method: "POST",
        headers: { origin: DEV_ORIGIN, "content-type": "application/json", "x-canvas-agent-token": token },
        body: "{}",
    });
    assert.equal(response.status, 200);
}

async function postLocalTool(url: string, token: string, name: string) {
    const response = await fetch(`${url}/api/tools`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-canvas-agent-token": token,
            "x-canvas-agent-protocol-version": String(PROTOCOL_VERSION),
            "x-canvas-agent-capabilities": "mcp.tools.v1,tool.authorization.v1",
            "x-canvas-plugin-version": "0.1.0-test",
        },
        body: JSON.stringify({ name, input: {} }),
    });
    const body = await response.json() as { ok?: boolean; code?: string; error?: string; result?: { projectId?: string } };
    return { response, body };
}

async function postTicketTool(url: string, token: string, clientId: string, name: string) {
    const response = await fetch(`${url}/api/tools`, {
        method: "POST",
        headers: {
            origin: DEV_ORIGIN,
            "content-type": "application/json",
            "x-canvas-agent-token": token,
            "x-canvas-client-id": clientId,
            "x-canvas-agent-protocol-version": String(PROTOCOL_VERSION),
            "x-canvas-agent-capabilities": "mcp.tools.v1,tool.authorization.v1",
        },
        body: JSON.stringify({ name, input: {} }),
    });
    const body = await response.json() as { ok?: boolean; code?: string; error?: string; result?: { projectId?: string } };
    return { response, body };
}

async function runtimeFixture(t: test.TestContext) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-runtime-"));
    const port = await availablePort();
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    return { home, codexHome: path.join(home, ".codex"), port, url: `http://127.0.0.1:${port}` };
}

function startMcpRuntime(fixture: { home: string; codexHome: string; port: number }, options: { debug?: boolean; detached?: boolean; env?: Record<string, string> } = {}) {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "mcp", ...(options.debug ? ["--debug"] : [])], {
        cwd: PROJECT_ROOT,
        env: {
            ...process.env,
            CANVAS_AGENT_HOME: fixture.home,
            HOME: fixture.home,
            USERPROFILE: fixture.home,
            CODEX_HOME: fixture.codexHome,
            PORT: String(fixture.port),
            CANVAS_AGENT_PAIR_ORIGINS: DEV_ORIGIN,
            NODE_ENV: "test",
            SNEEAI_AGENT_DISABLE_SECURE_CREDENTIALS: "1",
            ...options.env,
        },
        detached: options.detached,
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code) => {
        if (code && !stderr.includes("SIGTERM")) stderr ||= `MCP runtime exited with ${code}`;
    });
    return Object.assign(child, { stdoutText: () => stdout.trim(), stderrText: () => stderr.trim() });
}

function writeConfig(home: string, config: { url: string; token: string }) {
    const configDir = path.join(home, ".sneeai-agent");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "sneeai-agent.json"), JSON.stringify(config));
}

function readAgentConfig(home: string) {
    return JSON.parse(fs.readFileSync(path.join(home, ".sneeai-agent", "sneeai-agent.json"), "utf8")) as { url: string; token: string };
}

function fixtureFingerprint(fixture: { home: string; codexHome: string; port: number }) {
    return codexRuntimeFingerprint({
        env: { ...process.env, CANVAS_AGENT_HOME: fixture.home, HOME: fixture.home, USERPROFILE: fixture.home, CODEX_HOME: fixture.codexHome, PORT: String(fixture.port), CANVAS_AGENT_PAIR_ORIGINS: DEV_ORIGIN },
        homeDir: fixture.home,
    });
}

async function fetchRuntime(url: string, token: string) {
    const response = await fetch(`${url}/agent/runtime`, { headers: { "x-canvas-agent-token": token } });
    assert.equal(response.status, 200);
    return await response.json() as { ok: true; fingerprint: string; claim: string; busy: boolean };
}

async function waitForRuntimeChange(url: string, token: string, previousFingerprint: string) {
    const deadline = Date.now() + 10_000;
    let lastError = "";
    while (Date.now() < deadline) {
        try {
            const runtime = await fetchRuntime(url, token);
            if (runtime.fingerprint !== previousFingerprint) return runtime;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await delay(50);
    }
    throw new Error(`Timed out waiting for HTTP bridge handoff: ${lastError}`);
}

function listen(server: ReturnType<typeof createServer>, port: number) {
    return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
}

function closeServer(server: ReturnType<typeof createServer>) {
    return new Promise<void>((resolve) => server.close(() => resolve()));
}

function closeServerIfListening(server: ReturnType<typeof createServer>) {
    return server.listening ? closeServer(server) : Promise.resolve();
}

function waitForExit(child: ReturnType<typeof startMcpRuntime>, timeoutMs = 6_000) {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return Promise.race([
        new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))),
        delay(timeoutMs).then(() => {
            throw new Error(`Timed out waiting for MCP exit: ${child.stderrText()}`);
        }),
    ]);
}

async function stopChild(child: ChildProcess) {
    if (child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        delay(2_000).then(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
        }),
    ]);
}

async function stopRuntimeTree(child: ChildProcess) {
    if (child.exitCode !== null || child.killed) return;
    if (child.pid && process.platform !== "win32") {
        try {
            process.kill(-child.pid, "SIGTERM");
        } catch {}
    } else {
        child.kill("SIGTERM");
    }
    await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        delay(2_000).then(() => {
            if (child.exitCode !== null) return;
            if (child.pid && process.platform !== "win32") {
                try {
                    process.kill(-child.pid, "SIGKILL");
                } catch {}
            } else {
                child.kill("SIGKILL");
            }
        }),
    ]);
}

async function waitForAgent(url: string) {
    const deadline = Date.now() + 30_000;
    let lastError = "";
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${url}/health`);
            if (response.ok) return;
            lastError = `HTTP ${response.status}`;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await delay(50);
    }
    throw new Error(`Timed out waiting for plugin HTTP bridge: ${lastError}`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime condition");
        await delay(25);
    }
}

function availablePort() {
    const server = net.createServer();
    return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") return reject(new Error("Failed to reserve a test port"));
            const port = address.port;
            server.close((error) => (error ? reject(error) : resolve(port)));
        });
    });
}

function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function modernHealthBody() {
    return {
        ok: true,
        service: AGENT_SERVICE,
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...PROTOCOL_CAPABILITIES],
        buildVersion: VERSION,
    };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
    return Promise.race([
        promise,
        delay(timeoutMs).then(() => {
            throw new Error("Timed out waiting for runtime handoff cleanup");
        }),
    ]);
}
