import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CANVAS_AGENT_PROFILE_ENV, codexRuntimeFingerprint, NESTED_CANVAS_MCP_ENV } from "../agent/codex-runtime.js";
import { toolDescriptions, toolInputSchemas, toolNames, type ToolName } from "../canvas/schemas.js";
import { AGENT_PROMPT, AGENT_SERVICE, effectiveCanvasAgentUrl, loadConfig, saveConfig, type CanvasAgentConfig, VERSION } from "../config.js";
import { probeAgentRuntime, requestAgentHandoff, type AgentRuntimeProbeResult } from "../pairing.js";
import { isProtocolCompatible, PROTOCOL_VERSION, REQUIRED_TOOL_CAPABILITIES } from "../protocol.js";
import { CANVAS_PROFILE_HEADER } from "../profile.js";
import { startHttpServer, waitForHttpServer } from "./http.js";
import { compareRuntimeClaims, createRuntimeClaim } from "./runtime-claim.js";

type CanvasAgentToolResponse = { ok?: boolean; result?: unknown; error?: string };
const HTTP_RACE_TIMEOUT_MS = 4_000;
const HTTP_RACE_RETRY_MS = 50;
const HTTP_BUSY_RETRY_MS = 250;
const WEB_CANVAS_WAIT_MS = 8_000;
const WEB_CANVAS_RETRY_MS = 100;
const WEB_CANVAS_NOT_READY_ERRORS = new Set(["当前没有已连接画布", "当前没有已连接网页"]);
let deferredHandoff: Promise<void> | null = null;
const runtimeClaim = createRuntimeClaim();
type ClaimHttpBridgeResult = Server | null | "busy";

/** 启动通过标准输入输出通信的 MCP 服务。 */
export async function startMcpServer() {
    await ensurePluginHttpServer();
    const server = new McpServer({ name: "canvas-agent", version: VERSION }, { instructions: AGENT_PROMPT });
    toolNames.forEach((name) => registerCanvasTool(server, name));
    await server.connect(new StdioServerTransport());
}

/** 复用兼容的本机桥接，或由当前 MCP 进程启动并拥有一个桥接。 */
export async function ensurePluginHttpServer(): Promise<Server | null> {
    const fingerprint = codexRuntimeFingerprint();
    const current = await probeEffectiveAgent();
    if (process.env[NESTED_CANVAS_MCP_ENV] === "1") {
        if (current.status === "ready") return null;
        throw agentStatusError(current);
    }
    if (current.status === "ready" && current.fingerprint === fingerprint) return null;
    if (current.status === "ready" && current.busy) {
        scheduleDeferredHandoff(fingerprint);
        return null;
    }
    const claimed = await claimHttpBridge(fingerprint, current);
    if (claimed === "busy") {
        scheduleDeferredHandoff(fingerprint);
        return null;
    }
    return claimed;
}

/** 向 MCP Server 注册单个 Sneeai Agent 工具。 */
function registerCanvasTool(server: McpServer, name: ToolName) {
    const schema = toolInputSchemas[name];
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (input: unknown) => {
        const result = await postCanvasAgentTool(loadConfig(true), name, schema.parse(input));
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    });
}

/** 将 MCP 工具调用转发到本地 Sneeai Agent HTTP 服务。 */
export async function postCanvasAgentTool(config: CanvasAgentConfig, name: ToolName, input: unknown, profileId = process.env[CANVAS_AGENT_PROFILE_ENV] || "") {
    await requireCompatibleToolBridge(config);
    const deadline = Date.now() + WEB_CANVAS_WAIT_MS;
    while (true) {
        const res = await fetch(`${config.url}/api/tools`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-canvas-agent-token": config.token,
                "x-canvas-agent-protocol-version": String(PROTOCOL_VERSION),
                "x-canvas-agent-capabilities": REQUIRED_TOOL_CAPABILITIES.join(","),
                ...(profileId ? { [CANVAS_PROFILE_HEADER]: profileId } : {}),
            },
            body: JSON.stringify({ name, input }),
        });
        const service = res.headers.get("x-canvas-agent-service");
        const version = res.headers.get("x-canvas-agent-version");
        const protocolVersion = res.headers.get("x-canvas-agent-protocol-version");
        const capabilities = res.headers.get("x-canvas-agent-capabilities");
        const buildVersion = res.headers.get("x-canvas-agent-build-version");
        const protocol = protocolVersion || capabilities || buildVersion
            ? { version, protocolVersion, capabilities: capabilities?.split(",").map((item) => item.trim()).filter(Boolean), buildVersion }
            : { version };
        if (service !== AGENT_SERVICE || !isProtocolCompatible(protocol, { requiredCapabilities: REQUIRED_TOOL_CAPABILITIES, legacyBuildVersion: VERSION })) {
            throw new Error(`Sneeai Agent 协议不兼容：MCP ${VERSION}，HTTP Agent ${buildVersion || version || "未知"}。请停止旧 Agent 后重新启动。`);
        }
        const body = (await res.json()) as CanvasAgentToolResponse;
        if (body.ok) return body.result;
        const error = body.error || "tool call failed";
        if (!WEB_CANVAS_NOT_READY_ERRORS.has(error) || Date.now() >= deadline) throw new Error(error);
        await new Promise((resolve) => setTimeout(resolve, WEB_CANVAS_RETRY_MS));
    }
}

async function requireCompatibleToolBridge(config: CanvasAgentConfig) {
    let response: Response;
    try {
        response = await fetch(`${config.url}/health`);
    } catch {
        throw new Error("Sneeai Agent 本机桥接不可用，请重新启动 Agent。");
    }
    const body = await response.json().catch(() => null) as { ok?: boolean; service?: string; version?: string; protocolVersion?: unknown; capabilities?: unknown; buildVersion?: string } | null;
    if (!response.ok || body?.ok !== true || body.service !== AGENT_SERVICE || !isProtocolCompatible(body, { requiredCapabilities: REQUIRED_TOOL_CAPABILITIES, legacyBuildVersion: VERSION })) {
        throw new Error(`Sneeai Agent 协议不兼容：MCP ${VERSION}，HTTP Agent ${body?.buildVersion || body?.version || "未知"}。请升级或停止旧 Agent 后重新启动。`);
    }
}

async function claimHttpBridge(fingerprint: string, initial?: AgentRuntimeProbeResult): Promise<ClaimHttpBridgeResult> {
    const deadline = Date.now() + HTTP_RACE_TIMEOUT_MS;
    let current = initial || await probeEffectiveAgent();
    while (Date.now() < deadline) {
        if (current.status === "ready") {
            if (current.fingerprint === fingerprint) return null;
            if (current.claim && compareRuntimeClaims(runtimeClaim, current.claim) <= 0) return null;
            if (current.busy) return "busy";
            const handoff = await requestAgentHandoff(effectiveConfig(), fingerprint, runtimeClaim);
            if (handoff === "busy") return "busy";
            if (handoff === "unauthorized" || handoff === "incompatible") throw agentStatusError({ status: handoff });
            if (handoff === "same" || handoff === "stale") return null;
            if (handoff === "accepted") await waitForAgentOffline();
        } else if (current.status !== "offline") {
            throw agentStatusError(current);
        }

        try {
            return await waitForHttpServer(startHttpServer({ silent: true, runtimeFingerprint: fingerprint, runtimeClaim }));
        } catch (error) {
            if (!isAddressInUse(error)) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, HTTP_RACE_RETRY_MS));
        current = await probeEffectiveAgent();
    }
    throw new Error("Sneeai Agent 本机桥接启动失败");
}

function effectiveConfig() {
    const config = loadConfig(true);
    const url = effectiveCanvasAgentUrl(config.url);
    if (config.url !== url) {
        config.url = url;
        saveConfig(config);
    }
    return config;
}

function probeEffectiveAgent() {
    return probeAgentRuntime(effectiveConfig());
}

async function waitForAgentOffline() {
    const deadline = Date.now() + HTTP_RACE_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if ((await probeEffectiveAgent()).status === "offline") return;
        await new Promise((resolve) => setTimeout(resolve, HTTP_RACE_RETRY_MS));
    }
}

function scheduleDeferredHandoff(fingerprint: string) {
    if (deferredHandoff) return;
    deferredHandoff = (async () => {
        try {
            while (true) {
                await new Promise((resolve) => setTimeout(resolve, HTTP_BUSY_RETRY_MS));
                const current = await probeEffectiveAgent();
                if (current.status === "ready" && current.fingerprint === fingerprint) return;
                if (current.status === "ready" && current.busy) continue;
                if (current.status !== "ready" && current.status !== "offline") return;
                const claimed = await claimHttpBridge(fingerprint, current);
                if (claimed === "busy") continue;
                return;
            }
        } catch {
            return;
        } finally {
            deferredHandoff = null;
        }
    })();
}

function agentStatusError(result: { status: string }) {
    if (result.status === "provider-blocked") return new Error("当前 Codex 使用其他中转；可在网页中为 Agent 配置独立 KapeAI 中转");
    if (result.status === "unauthorized") return new Error("本机端口已有 Sneeai Agent，但 Connect token 与当前插件配置不一致。请停止旧 Agent 后重试。");
    if (result.status === "incompatible") return new Error("本机端口被其他服务或不同版本的 Sneeai Agent 占用。请停止该进程后重试。");
    return new Error("Sneeai Agent 本机桥接启动失败");
}

function isAddressInUse(error: unknown) {
    return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}
