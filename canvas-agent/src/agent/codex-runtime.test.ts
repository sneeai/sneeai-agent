import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canvasCodexAppServerArgs, canvasCodexConnectionStatus, canvasCodexRuntimeEnvironment, CodexConnectionInputError, CodexRelayApiKeyRequiredError, configureCanvasCodexConnection, KAPEAI_API_KEY_ENV, codexRuntimeFingerprint } from "./codex-runtime.js";

test("Codex app-server disables only Sneeai plugin variants", () => {
    const args = canvasCodexAppServerArgs();

    assert.deepEqual(args.slice(0, 2), ["app-server", "--stdio"]);
    assert.deepEqual(args.slice(2), [
        "-c",
        'plugins."sneeai@sneeai".enabled=false',
        "-c",
        'plugins."sneeai-agent@sneeai".enabled=false',
    ]);
    assert.equal(args.some((arg) => arg.includes("chrome") || arg.includes("browser")), false);
});

test("Codex runtime fingerprint follows config, auth, and authentication environment", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-codex-runtime-"));
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model_provider = "openai"\n');
    fs.writeFileSync(path.join(codexHome, "auth.json"), '{"tokens":{"access_token":"first-auth-secret"}}');
    const env = { CODEX_HOME: codexHome, OPENAI_API_KEY: "first-openai-secret" };
    const initial = codexRuntimeFingerprint({ env, homeDir: root });

    assert.match(initial, /^v1:[a-f0-9]{64}$/);
    assert.equal(initial.includes("first-auth-secret"), false);
    assert.equal(initial.includes("first-openai-secret"), false);

    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example/v1"\nenv_key = "GATEWAY_API_KEY"\n');
    const configChanged = codexRuntimeFingerprint({ env: { ...env, GATEWAY_API_KEY: "first-gateway-secret" }, homeDir: root });
    assert.notEqual(configChanged, initial);

    fs.writeFileSync(path.join(codexHome, "auth.json"), '{"tokens":{"access_token":"second-auth-secret"}}');
    const authChanged = codexRuntimeFingerprint({ env: { ...env, GATEWAY_API_KEY: "first-gateway-secret" }, homeDir: root });
    assert.notEqual(authChanged, configChanged);

    const customEnvChanged = codexRuntimeFingerprint({ env: { ...env, GATEWAY_API_KEY: "second-gateway-secret" }, homeDir: root });
    assert.notEqual(customEnvChanged, authChanged);

    const commonEnvChanged = codexRuntimeFingerprint({ env: { ...env, OPENAI_API_KEY: "second-openai-secret", GATEWAY_API_KEY: "second-gateway-secret" }, homeDir: root });
    assert.notEqual(commonEnvChanged, customEnvChanged);

    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model_provider = "inline"\nmodel_providers.inline = { base_url = "https://inline.example/v1", env_key = "INLINE_API_KEY" }\n');
    const inlineEnv = codexRuntimeFingerprint({ env: { ...env, INLINE_API_KEY: "first-inline-secret" }, homeDir: root });
    const inlineEnvChanged = codexRuntimeFingerprint({ env: { ...env, INLINE_API_KEY: "second-inline-secret" }, homeDir: root });
    assert.notEqual(inlineEnvChanged, inlineEnv);
});

test("isolated Canvas Codex runtime uses only its KapeAI profile and credential", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-isolated-codex-"));
    const runtimeHome = path.join(root, "codex-runtime");
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(path.join(runtimeHome, "kapeai-api-key"), "kape-user-secret\n", { mode: 0o600 });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const env = canvasCodexRuntimeEnvironment(
        { url: "http://127.0.0.1:17371", token: "bridge-token", codex: { mode: "isolated" } },
        {
            configDir: root,
            env: {
                HOME: "/host/home",
                CODEX_HOME: "/host/.codex",
                CODEX_BASE_URL: "https://relay-a.example/v1",
                OPENAI_BASE_URL: "https://relay-a.example/v1",
                OPENAI_API_KEY: "host-secret",
            },
        },
    );

    assert.equal(env.CODEX_HOME, runtimeHome);
    assert.equal(env[KAPEAI_API_KEY_ENV], "kape-user-secret");
    assert.equal(env.CODEX_BASE_URL, undefined);
    assert.equal(env.OPENAI_BASE_URL, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    const runtimeConfig = fs.readFileSync(path.join(runtimeHome, "config.toml"), "utf8");
    assert.match(runtimeConfig, /base_url = "https:\/\/api\.kapeai\.cn\/v1"/);
    assert.match(runtimeConfig, new RegExp(`env_key = "${KAPEAI_API_KEY_ENV}"`));
    assert.equal(runtimeConfig.includes("relay-a.example"), false);
    assert.equal(runtimeConfig.includes("kape-user-secret"), false);
    assert.deepEqual(canvasCodexConnectionStatus({ url: "local", token: "token", codex: { mode: "isolated" } }, { configDir: root }), {
        mode: "isolated",
        hasRelayApiKey: true,
    });
    if (process.platform !== "win32") {
        assert.equal(fs.statSync(runtimeHome).mode & 0o777, 0o700);
        assert.equal(fs.statSync(path.join(runtimeHome, "config.toml")).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.join(runtimeHome, "kapeai-api-key")).mode & 0o777, 0o600);
    }
});

test("isolated Canvas Codex runtime refuses to start without a KapeAI credential", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-missing-key-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.throws(
        () => canvasCodexRuntimeEnvironment({ url: "local", token: "token", codex: { mode: "isolated" } }, { configDir: root, env: {} }),
        (error: unknown) => error instanceof CodexRelayApiKeyRequiredError,
    );
    assert.throws(
        () => configureCanvasCodexConnection({ url: "local", token: "token" }, { mode: "isolated", apiKey: "invalid\nkey" }, { configDir: root }),
        (error: unknown) => error instanceof CodexConnectionInputError,
    );
    for (const invalid of ["short", "invalid key", " valid-key", "valid-key ", "含非ASCII字符的密钥"]) {
        assert.throws(
            () => configureCanvasCodexConnection({ url: "local", token: "token" }, { mode: "isolated", apiKey: invalid }, { configDir: root }),
            (error: unknown) => error instanceof CodexConnectionInputError,
            invalid,
        );
    }

    const runtimeHome = path.join(root, "codex-runtime");
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(path.join(runtimeHome, "kapeai-api-key"), "stored-key-with-space \n", { mode: 0o600 });
    assert.throws(
        () => canvasCodexRuntimeEnvironment({ url: "local", token: "token", codex: { mode: "isolated" } }, { configDir: root, env: {} }),
        (error: unknown) => error instanceof CodexConnectionInputError,
    );
});

test("a printable KapeAI key enters the existing isolated runtime flow", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-valid-key-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = { url: "local", token: "token" };

    const status = configureCanvasCodexConnection(config, { mode: "isolated", apiKey: "kape-test-key_1234567890" }, { configDir: root });
    const env = canvasCodexRuntimeEnvironment(config, { configDir: root, env: {} });

    assert.deepEqual(status, { mode: "isolated", hasRelayApiKey: true });
    assert.equal(env[KAPEAI_API_KEY_ENV], "kape-test-key_1234567890");
    assert.match(fs.readFileSync(path.join(root, "codex-runtime", "config.toml"), "utf8"), /base_url = "https:\/\/api\.kapeai\.cn\/v1"/);
});

test("inherited Canvas Codex runtime leaves the host Codex environment intact", () => {
    const hostEnv = { CODEX_HOME: "/host/.codex", OPENAI_BASE_URL: "https://relay-a.example/v1", OPENAI_API_KEY: "host-secret" };
    const env = canvasCodexRuntimeEnvironment({ url: "local", token: "token" }, { env: hostEnv });
    assert.deepEqual(env, hostEnv);
    assert.notEqual(env, hostEnv);
});

test("Codex runtime fingerprint includes the effective home and ignores task-scoped environment", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-codex-home-"));
    const firstHome = path.join(root, "first");
    const secondHome = path.join(root, "second");
    for (const home of [firstHome, secondHome]) {
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, "config.toml"), 'model = "gpt-test"\n');
        fs.writeFileSync(path.join(home, "auth.json"), '{}');
    }
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const first = codexRuntimeFingerprint({ env: { CODEX_HOME: firstHome, CODEX_THREAD_ID: "thread-one", CODEX_TASK_ID: "task-one" }, homeDir: root });
    const taskChanged = codexRuntimeFingerprint({ env: { CODEX_HOME: firstHome, CODEX_THREAD_ID: "thread-two", CODEX_TASK_ID: "task-two" }, homeDir: root });
    const homeChanged = codexRuntimeFingerprint({ env: { CODEX_HOME: secondHome, CODEX_THREAD_ID: "thread-two", CODEX_TASK_ID: "task-two" }, homeDir: root });

    assert.equal(taskChanged, first);
    assert.notEqual(homeChanged, first);
});

test("Codex runtime fingerprint follows installed plugin versions", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-codex-plugins-"));
    const codexHome = path.join(root, "codex-home");
    const pluginRoot = path.join(codexHome, "plugins", "cache", "local-marketplace", "sneeai-agent");
    fs.mkdirSync(path.join(pluginRoot, "0.1.0+codex.old"), { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const env = { CODEX_HOME: codexHome };
    const oldVersion = codexRuntimeFingerprint({ env, homeDir: root });

    fs.rmSync(path.join(pluginRoot, "0.1.0+codex.old"), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, "0.1.0+codex.new"));
    const newVersion = codexRuntimeFingerprint({ env, homeDir: root });

    assert.notEqual(newVersion, oldVersion);
});

test("Codex plugin fingerprint is stable across cache creation order", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-codex-plugin-order-"));
    const codexHome = path.join(root, "codex-home");
    const cacheRoot = path.join(codexHome, "plugins", "cache");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const versions = [
        path.join(cacheRoot, "marketplace-b", "plugin-b", "2.0.0"),
        path.join(cacheRoot, "marketplace-a", "plugin-a", "1.0.0"),
    ];
    versions.forEach((version) => fs.mkdirSync(version, { recursive: true }));
    const first = codexRuntimeFingerprint({ env: { CODEX_HOME: codexHome }, homeDir: root });

    fs.rmSync(cacheRoot, { recursive: true });
    [...versions].reverse().forEach((version) => fs.mkdirSync(version, { recursive: true }));
    const recreated = codexRuntimeFingerprint({ env: { CODEX_HOME: codexHome }, homeDir: root });

    assert.equal(recreated, first);
});

test("Codex runtime fingerprint follows plugin symlink targets", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-codex-plugin-link-"));
    const codexHome = path.join(root, "codex-home");
    const pluginRoot = path.join(codexHome, "plugins", "cache", "bundled", "browser");
    const firstVersion = path.join(pluginRoot, "1.0.0");
    const secondVersion = path.join(pluginRoot, "2.0.0");
    const latest = path.join(pluginRoot, "latest");
    fs.mkdirSync(firstVersion, { recursive: true });
    fs.mkdirSync(secondVersion);
    fs.symlinkSync(firstVersion, latest, "dir");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const env = { CODEX_HOME: codexHome };
    const firstTarget = codexRuntimeFingerprint({ env, homeDir: root });

    fs.unlinkSync(latest);
    fs.symlinkSync(secondVersion, latest, "dir");
    const secondTarget = codexRuntimeFingerprint({ env, homeDir: root });

    assert.notEqual(secondTarget, firstTarget);
});
