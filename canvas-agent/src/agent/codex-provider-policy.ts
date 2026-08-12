import { field, type JsonRecord } from "../utils/value.js";

export const KAPEAI_RELAY_BASE_URL = "https://api.kapeai.cn/v1";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type CodexAccount = { type?: string } | null;
export type CodexProviderPolicyDecision = { kind: "subscription" } | { kind: "relay" } | { kind: "blocked"; message: string };
export type CodexProviderPolicyOptions = { account: CodexAccount; config: JsonRecord; env?: RuntimeEnvironment };

const BASE_URL_ENV_KEYS = ["CODEX_BASE_URL", "OPENAI_BASE_URL"] as const;
const BLOCKED_MESSAGE = "当前 Codex 使用的是其他中转。请在网页中为 Agent 开启独立 KapeAI 中转并填写 API Key，或让当前 Codex 使用 ChatGPT 订阅/KapeAI。";

export class CodexProviderPolicyError extends Error {
    readonly statusCode = 403;

    constructor(message = BLOCKED_MESSAGE) {
        super(message);
        this.name = "CodexProviderPolicyError";
    }
}

/** 判断当前 Codex 凭据和 provider 是否符合 Sneeai 的接入策略。 */
export function evaluateCodexProviderPolicy(options: CodexProviderPolicyOptions): CodexProviderPolicyDecision {
    const env = options.env || process.env;
    const providerId = stringField(options.config, "model_provider") || "openai";
    const provider = field(field(options.config, "model_providers"), providerId);
    const configuredBaseUrl = providerId === "openai" ? stringField(options.config, "openai_base_url") : stringField(provider, "base_url");
    const baseUrls = [configuredBaseUrl, ...BASE_URL_ENV_KEYS.map((key) => env[key])].filter((value): value is string => Boolean(value?.trim()));

    if (options.account?.type === "chatgpt" && providerId === "openai" && baseUrls.length === 0) return { kind: "subscription" };
    if (baseUrls.length === 0 || baseUrls.some((value) => !isAllowedRelayBaseUrl(value))) return { kind: "blocked", message: BLOCKED_MESSAGE };
    return { kind: "relay" };
}

/** 拒绝非 ChatGPT 订阅直连或非 KapeAI 中转的 Codex 配置。 */
export function enforceCodexProviderPolicy(options: CodexProviderPolicyOptions) {
    const decision = evaluateCodexProviderPolicy(options);
    if (decision.kind === "blocked") throw new CodexProviderPolicyError(decision.message);
    return decision;
}

/** 校验中转地址必须是精确的 HTTPS API 根路径，拒绝相似域名、查询参数和额外路径。 */
function isAllowedRelayBaseUrl(value: string) {
    try {
        const url = new URL(value);
        const pathName = url.pathname.replace(/\/+$/, "");
        return url.protocol === "https:"
            && url.hostname === "api.kapeai.cn"
            && !url.port
            && !url.username
            && !url.password
            && !url.search
            && !url.hash
            && pathName === "/v1";
    } catch {
        return false;
    }
}

function stringField(value: unknown, key: string) {
    const result = field(value, key);
    return typeof result === "string" ? result : "";
}
