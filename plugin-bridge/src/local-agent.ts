import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGENT_PROTOCOL_VERSION = 1;
export const REQUIRED_AGENT_CAPABILITIES = ["mcp.tools.v1", "tool.authorization.v1"] as const;
export const PLUGIN_VERSION = "0.1.0";

type LocalAgentConfig = { url: string; token: string };
type LocalAgentHealth = { ok?: boolean; service?: string; protocolVersion?: unknown; capabilities?: unknown };

export class LocalAgentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LocalAgentError";
    }
}

export function localAgentConfigPath(home = process.env.CANVAS_AGENT_HOME?.trim() || os.homedir()) {
    return path.join(home, ".sneeai-agent", "sneeai-agent.json");
}

export function readLocalAgentConfig(home = process.env.CANVAS_AGENT_HOME?.trim() || os.homedir()): LocalAgentConfig {
    let value: unknown;
    try {
        value = JSON.parse(fs.readFileSync(localAgentConfigPath(home), "utf8"));
    } catch {
        throw new LocalAgentError("未检测到本机 Sneeai Agent。请先从 sneeai.com 下载并启动 Agent。");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalAgentError("本机 Sneeai Agent 配置无效，请重新启动 Agent。");
    const config = value as Partial<LocalAgentConfig>;
    if (typeof config.url !== "string" || typeof config.token !== "string" || !config.token.trim()) throw new LocalAgentError("本机 Sneeai Agent 配置无效，请重新启动 Agent。");
    let url: URL;
    try {
        url = new URL(config.url);
    } catch {
        throw new LocalAgentError("本机 Sneeai Agent 地址无效，请重新启动 Agent。");
    }
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
        throw new LocalAgentError("本机 Sneeai Agent 必须运行在本机回环地址。");
    }
    return { url: url.origin, token: config.token };
}

export async function callLocalAgent(config: LocalAgentConfig, name: string, input: unknown): Promise<unknown> {
    await assertCompatibleAgent(config);
    let response: Response;
    try {
        response = await fetch(`${config.url}/api/tools`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-canvas-agent-token": config.token,
                "x-canvas-agent-protocol-version": String(AGENT_PROTOCOL_VERSION),
                "x-canvas-agent-capabilities": REQUIRED_AGENT_CAPABILITIES.join(","),
                "x-canvas-plugin-version": PLUGIN_VERSION,
            },
            body: JSON.stringify({ name, input }),
        });
    } catch {
        throw new LocalAgentError("无法连接本机 Sneeai Agent。请确认 Agent 正在运行。");
    }
    const body = await response.json().catch(() => null) as { ok?: boolean; result?: unknown; error?: unknown } | null;
    if (!response.ok || body?.ok !== true) throw new LocalAgentError(typeof body?.error === "string" ? body.error : "本机 Sneeai Agent 未能完成请求。");
    return body.result;
}

async function assertCompatibleAgent(config: LocalAgentConfig) {
    let response: Response;
    try {
        response = await fetch(`${config.url}/health`);
    } catch {
        throw new LocalAgentError("无法连接本机 Sneeai Agent。请确认 Agent 正在运行。");
    }
    const health = await response.json().catch(() => null) as LocalAgentHealth | null;
    const capabilities = Array.isArray(health?.capabilities) ? new Set(health.capabilities.filter((value): value is string => typeof value === "string")) : new Set<string>();
    if (!response.ok || health?.ok !== true || health.service !== "sneeai-agent" || Number(health.protocolVersion) !== AGENT_PROTOCOL_VERSION || !REQUIRED_AGENT_CAPABILITIES.every((capability) => capabilities.has(capability))) {
        throw new LocalAgentError("本机 Sneeai Agent 版本不兼容，请在 sneeai.com 更新 Agent 后重试。");
    }
}
