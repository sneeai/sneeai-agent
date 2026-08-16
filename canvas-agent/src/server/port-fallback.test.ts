import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sneeai-agent-port-fallback-"));
process.env.CANVAS_AGENT_HOME = home;

const { loadConfig } = await import("../config.js");
const { startHttpServerWithFallback } = await import("./http.js");
const { ensurePluginHttpServer } = await import("./mcp.js");

test("Agent persists the first available port from its fixed candidate list", async (t) => {
    const occupiedPort = await availablePort();
    const fallbackPort = await availablePort();
    const occupant = net.createServer();
    await listen(occupant, occupiedPort);
    t.after(() => occupant.close());

    const server = await startHttpServerWithFallback({
        silent: true,
        runtimeFingerprint: `v1:${"0".repeat(64)}`,
        portCandidates: [occupiedPort, fallbackPort],
    });
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const address = server.address();
    assert.equal(typeof address === "object" && address?.port, fallbackPort);
    assert.equal(loadConfig().url, `http://127.0.0.1:${fallbackPort}`);
});

test("concurrent MCP startup reuses one Agent instead of occupying adjacent ports", async (t) => {
    const [first, second] = await Promise.all([ensurePluginHttpServer(), ensurePluginHttpServer()]);
    const servers = [first, second].filter((server): server is NonNullable<typeof server> => Boolean(server));
    assert.equal(servers.length, 1);
    t.after(async () => {
        await new Promise<void>((resolve) => servers[0].close(() => resolve()));
        fs.rmSync(home, { recursive: true, force: true });
    });

    const address = servers[0].address();
    assert.ok(address && typeof address !== "string");
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { service?: string }).service, "sneeai-agent");
    assert.equal(loadConfig().url, `http://127.0.0.1:${address.port}`);
});

function availablePort() {
    const server = net.createServer();
    return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") return reject(new Error("Failed to reserve a test port"));
            server.close((error) => error ? reject(error) : resolve(address.port));
        });
    });
}

function listen(server: net.Server, port: number) {
    return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
    });
}
