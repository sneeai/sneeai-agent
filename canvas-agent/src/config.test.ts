import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const CONFIG_MODULE_URL = new URL("./config.ts", import.meta.url).href;
const CHILD_COUNT = 16;

test("temporary process HOME does not change the stable Sneeai Agent directory", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-stable-home-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const first = await runConfigPathChild(path.join(root, "task-one"));
    const second = await runConfigPathChild(path.join(root, "task-two"));
    const stableHome = os.userInfo().homedir;

    assert.equal(first.configDir, path.join(stableHome, ".sneeai-agent"));
    assert.equal(second.configDir, first.configDir);
});

test("CANVAS_AGENT_HOME controls default and tilde workspace paths", async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-home-override-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));

    const paths = await runWorkspacePathChild(home);

    assert.equal(paths.defaultWorkspace, path.join(home, ".sneeai-agent", "codex-workspaces", "site"));
    assert.equal(paths.customWorkspace, path.join(home, "custom-workspace"));
});

test("concurrent Agent and MCP startup creates one shared token", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-config-"));
    const home = path.join(root, "home");
    const readyDir = path.join(root, "ready");
    const releaseFile = path.join(root, "release");
    fs.mkdirSync(home);
    fs.mkdirSync(readyDir);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const children = Array.from({ length: CHILD_COUNT }, (_, index) => runConfigChild({ home, readyDir, releaseFile, id: String(index) }));
    try {
        await waitFor(() => fs.readdirSync(readyDir).length === CHILD_COUNT, 30_000);
    } catch (error) {
        fs.writeFileSync(releaseFile, "ready");
        await Promise.allSettled(children);
        throw error;
    }
    fs.writeFileSync(releaseFile, "ready");

    const tokens = await Promise.all(children);
    const configFile = path.join(home, ".sneeai-agent", "sneeai-agent.json");
    const saved = JSON.parse(fs.readFileSync(configFile, "utf8")) as { token: string };

    assert.equal(new Set(tokens).size, 1);
    assert.equal(tokens[0], saved.token);
    if (process.platform !== "win32") assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
});

test("legacy config receives one persistent device id", async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-device-id-"));
    const configDir = path.join(home, ".sneeai-agent");
    const configFile = path.join(configDir, "sneeai-agent.json");
    fs.mkdirSync(configDir);
    fs.writeFileSync(configFile, JSON.stringify({ url: "http://127.0.0.1:17371", token: "legacy-local-token" }));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));

    const first = await runDeviceIdChild(home);
    const second = await runDeviceIdChild(home);
    const saved = JSON.parse(fs.readFileSync(configFile, "utf8")) as { deviceId?: string };

    assert.match(first, /^d1:[A-Za-z0-9_-]{43}$/);
    assert.equal(second, first);
    assert.equal(saved.deviceId, first);
    if (process.platform !== "win32") assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
});

test("legacy local URL migrates to the effective loopback port and persists", async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-legacy-url-"));
    const configDir = path.join(home, ".sneeai-agent");
    const configFile = path.join(configDir, "sneeai-agent.json");
    fs.mkdirSync(configDir);
    fs.writeFileSync(configFile, JSON.stringify({ url: "local", token: "legacy-local-token" }));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));

    const config = await runLoadedConfigChild(home, { PORT: "18452" });
    const saved = JSON.parse(fs.readFileSync(configFile, "utf8")) as { url?: string };

    assert.equal(config.url, "http://127.0.0.1:18452");
    assert.equal(saved.url, config.url);
});

test("config accepts only standard HTTP loopback URLs", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-loopback-url-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    for (const [index, url] of ["http://127.0.0.1:17371", "http://localhost:17371", "http://[::1]:17371"].entries()) {
        const home = path.join(root, `valid-${index}`);
        writeConfigFixture(home, { url, token: "loopback-token" });
        assert.equal((await runLoadedConfigChild(home)).url, url);
    }

    for (const [index, url] of [
        "not-a-url",
        "https://127.0.0.1:17371",
        "http://agent.example:17371",
        "http://127.0.0.1:17371/private",
        "http://user@127.0.0.1:17371",
    ].entries()) {
        const home = path.join(root, `invalid-${index}`);
        writeConfigFixture(home, { url, token: "invalid-url-token" });
        await assert.rejects(runLoadedConfigChild(home), /Sneeai Agent .*无效/);
    }
});

function runConfigChild({ home, readyDir, releaseFile, id }: { home: string; readyDir: string; releaseFile: string; id: string }) {
    const script = `
        import fs from "node:fs";
        import path from "node:path";
        const originalRead = fs.readFileSync.bind(fs);
        let intercepted = false;
        fs.readFileSync = function(file, ...args) {
            try {
                return originalRead(file, ...args);
            } catch (error) {
                if (!intercepted && path.basename(String(file)) === "sneeai-agent.json" && error?.code === "ENOENT") {
                    intercepted = true;
                    fs.writeFileSync(path.join(process.env.TEST_READY_DIR, process.env.TEST_CHILD_ID), "ready");
                    while (!fs.existsSync(process.env.TEST_RELEASE_FILE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                }
                throw error;
            }
        };
        const { loadConfig } = await import(${JSON.stringify(CONFIG_MODULE_URL)});
        process.stdout.write(loadConfig(true).token);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        env: { ...process.env, CANVAS_AGENT_HOME: home, HOME: home, USERPROFILE: home, TEST_READY_DIR: readyDir, TEST_RELEASE_FILE: releaseFile, TEST_CHILD_ID: id },
        stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise<string>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `config child exited with ${code}`))));
    });
}

function runConfigPathChild(home: string) {
    const script = `
        const { CONFIG_DIR } = await import(${JSON.stringify(CONFIG_MODULE_URL)});
        process.stdout.write(JSON.stringify({ configDir: CONFIG_DIR }));
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        env: { ...process.env, CANVAS_AGENT_HOME: "", HOME: home, USERPROFILE: home },
        stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise<{ configDir: string }>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `config child exited with ${code}`))));
    });
}

function runWorkspacePathChild(home: string) {
    const script = `
        const { ensureSiteWorkspace, updateSiteWorkspace } = await import(${JSON.stringify(CONFIG_MODULE_URL)});
        const config = { url: "http://127.0.0.1:17371", token: "test-token" };
        const defaultWorkspace = ensureSiteWorkspace(config).workspacePath;
        const customWorkspace = updateSiteWorkspace(config, { workspacePath: "~/custom-workspace" }).workspacePath;
        process.stdout.write(JSON.stringify({ defaultWorkspace, customWorkspace }));
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        env: { ...process.env, CANVAS_AGENT_HOME: home, HOME: path.join(home, "temporary-home"), USERPROFILE: path.join(home, "temporary-home") },
        stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise<{ defaultWorkspace: string; customWorkspace: string }>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `config child exited with ${code}`))));
    });
}

function runDeviceIdChild(home: string) {
    const script = `
        const { loadConfig } = await import(${JSON.stringify(CONFIG_MODULE_URL)});
        process.stdout.write(loadConfig(true).deviceId);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        env: { ...process.env, CANVAS_AGENT_HOME: home, HOME: home, USERPROFILE: home },
        stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise<string>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `device id child exited with ${code}`))));
    });
}

function runLoadedConfigChild(home: string, environment: Record<string, string> = {}) {
    const script = `
        const { loadConfig } = await import(${JSON.stringify(CONFIG_MODULE_URL)});
        process.stdout.write(JSON.stringify(loadConfig(true)));
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        env: { ...process.env, CANVAS_AGENT_HOME: home, HOME: home, USERPROFILE: home, PORT: "", ...environment },
        stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise<{ url: string; token: string }>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `config child exited with ${code}`))));
    });
}

function writeConfigFixture(home: string, config: { url: string; token: string }) {
    const configDir = path.join(home, ".sneeai-agent");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "sneeai-agent.json"), JSON.stringify(config));
}

async function waitFor(predicate: () => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for config children");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
