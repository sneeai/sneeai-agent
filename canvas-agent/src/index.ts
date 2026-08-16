#!/usr/bin/env node
import { startHttpServerWithFallback } from "./server/http.js";
import { startMcpServer } from "./server/mcp.js";
import { allowInsecureTestCredentials, ensureSecureConfig, loadConfig, migrateConfigCredential, rotateConfigToken, saveConfig, VERSION } from "./config.js";
import { canvasConnectionUrl, DEFAULT_CANVAS_URL, openExternalUrl, probeAgent } from "./pairing.js";
import { externalFetch } from "./network/external-fetch.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--debug");

if (args[0] === "mcp") {
    ensureRuntimeConfig();
    await startMcpServer();
} else if (args[0] === "version") {
    console.log(VERSION);
} else if (args[0] === "doctor") {
    const config = loadConfig();
    const status = await probeAgent(config);
    console.log(JSON.stringify({ ok: status === "ready", version: VERSION, status, url: config.url, platform: process.platform, node: process.version }, null, 2));
    if (status !== "ready") process.exitCode = 1;
} else if (args[0] === "check-update") {
    const response = await externalFetch("https://sneeai.com/agent-release.json", { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Agent version service returned HTTP ${response.status}`);
    const release = await response.json() as { latest_version?: unknown; download_page_url?: unknown };
    const latestVersion = typeof release.latest_version === "string" ? release.latest_version : "";
    if (!latestVersion) throw new Error("Agent version service returned an invalid response");
    console.log(JSON.stringify({ current_version: VERSION, latest_version: latestVersion, update_available: latestVersion !== VERSION, download_page_url: release.download_page_url || "https://sneeai.com/agent" }, null, 2));
} else if (args[0] === "migrate-credentials") {
    if (args[1] !== "--confirm") {
        console.error("未修改配置。确认将现有 Connect token 迁移到当前系统用户的安全存储后，运行 migrate-credentials --confirm。");
        process.exitCode = 2;
    } else {
        const result = migrateConfigCredential(loadConfig(true));
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    }
} else if (args[0] === "rotate-token") {
    if (args[1] !== "--confirm") {
        console.error("未轮换 token。轮换会使旧的本机连接凭据失效；停止 Agent 后运行 rotate-token --confirm。");
        process.exitCode = 2;
    } else {
        const config = loadConfig(true);
        const status = await probeAgent(config);
        if (status === "ready") {
            console.error("未轮换 token：Agent 仍在运行。请先停止 Agent，再重试此显式轮换命令。");
            process.exitCode = 1;
        } else {
            const result = rotateConfigToken(config);
            console.log(JSON.stringify({ ok: true, ...result, restartRequired: true, existingPairingsInvalidated: true }, null, 2));
        }
    }
} else if (args[0] === "open") {
    const canvasUrl = args[1] || DEFAULT_CANVAS_URL;
    const config = ensureRuntimeConfig();
    const pairedUrl = canvasConnectionUrl(canvasUrl, config);
    const canvasOrigin = new URL(pairedUrl).origin;
    config.origins ||= [];
    if (!config.origins.includes(canvasOrigin)) {
        config.origins.push(canvasOrigin);
        saveConfig(config);
    }
    const status = await probeAgent(config);
    if (status === "ready") {
        console.log(`Canvas URL: ${pairedUrl}`);
        await openExternalUrl(pairedUrl);
    } else if (status === "provider-blocked") {
        console.error("当前 Codex 中转不受支持。请在网页中开启 Agent 独立 KapeAI 中转并填写 API Key，或使用 ChatGPT 订阅/KapeAI。");
        process.exitCode = 1;
    } else if (status === "api-key-required") {
        console.error("Agent 独立中转尚未配置，请在网页中填写 KapeAI API Key。");
        process.exitCode = 1;
    } else if (status === "unauthorized") {
        console.error("本机端口已有 Sneeai Agent，但 Connect token 与配置不一致。请停止旧 Agent 后重新运行此命令。");
        process.exitCode = 1;
    } else if (status === "incompatible") {
        console.error("本机端口已被其他服务或不同版本的 Sneeai Agent 占用。请停止该进程后重新运行此命令。");
        process.exitCode = 1;
    } else {
        await startHttpServerWithFallback({ openCanvasUrl: canvasUrl });
    }
} else {
    ensureRuntimeConfig();
    await startHttpServerWithFallback();
}

function ensureRuntimeConfig() {
    // Insecure credentials are only available to the test harness. A user-set
    // environment variable must never downgrade a packaged Agent.
    return allowInsecureTestCredentials() ? loadConfig(true) : ensureSecureConfig();
}
