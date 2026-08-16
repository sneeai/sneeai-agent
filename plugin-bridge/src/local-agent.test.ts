import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callLocalAgent, LocalAgentError, localAgentConfigPath, PLUGIN_VERSION, readLocalAgentConfig } from "./local-agent.js";

test("the bridge only reads the Sneeai Agent loopback configuration", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sneeai-bridge-"));
    const configDir = path.dirname(localAgentConfigPath(home));
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(localAgentConfigPath(home), JSON.stringify({ url: "http://127.0.0.1:17371", token: "local-token" }));
    assert.deepEqual(readLocalAgentConfig(home), { url: "http://127.0.0.1:17371", token: "local-token" });
});

test("the bridge rejects a missing Agent and non-loopback endpoints", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sneeai-bridge-"));
    assert.throws(() => readLocalAgentConfig(home), LocalAgentError);
    const configDir = path.dirname(localAgentConfigPath(home));
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(localAgentConfigPath(home), JSON.stringify({ url: "https://remote.example", token: "local-token" }));
    assert.throws(() => readLocalAgentConfig(home), /回环地址/);
});

test("the bridge reports its bounded version only to the local Agent tool endpoint", async (t) => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input, init) => {
        const url = String(input);
        requests.push({ url, headers: new Headers(init?.headers) });
        if (url.endsWith("/health")) {
            return Response.json({ ok: true, service: "sneeai-agent", protocolVersion: 1, capabilities: ["mcp.tools.v1", "tool.authorization.v1"] });
        }
        return Response.json({ ok: true, result: { projectId: "canvas-1" } });
    }) as typeof fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    await callLocalAgent({ url: "http://127.0.0.1:17371", token: "local-token" }, "canvas_get_state", {});

    assert.equal(requests[0].headers.get("x-canvas-plugin-version"), null);
    assert.equal(requests[1].headers.get("x-canvas-plugin-version"), PLUGIN_VERSION);
});
