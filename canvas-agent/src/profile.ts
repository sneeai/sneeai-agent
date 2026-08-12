import crypto from "node:crypto";

export const CANVAS_PROFILE_HEADER = "x-canvas-profile-id";
export const CANVAS_AGENT_PROFILE_HEADER = "x-canvas-agent-profile";
export const CANVAS_AGENT_PROFILE_ID_HEADER = "x-canvas-agent-profile-id";
export const CANVAS_ACCOUNT_HEADER = "x-canvas-account-id";
export const CANVAS_DEVICE_HEADER = "x-canvas-device-id";
export const CANVAS_CLIENT_HEADER = "x-canvas-client-id";
export const CANVAS_AGENT_PROFILE_ENV = "CANVAS_AGENT_PROFILE_ID";
export const LEGACY_PROFILE_KEY = "legacy";
export const MAX_PROFILE_ID_LENGTH = 200;
export const MAX_CLIENT_ID_LENGTH = 200;

export type ProfileSource = "profile" | "account" | "device" | "legacy";
export type AgentProfile = {
    key: string;
    id: string;
    source: ProfileSource;
    explicit: boolean;
};

export type ProfileInput = {
    origin?: string;
    headers?: Record<string, string | string[] | undefined>;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
};

export class ProfileInputError extends Error {
    readonly statusCode = 400;

    constructor(message: string) {
        super(message);
        this.name = "ProfileInputError";
    }
}

/** 从 HTTP/MCP 输入中提取稳定的 profile 和 client 标识。 */
export function resolveProfile(input: ProfileInput): AgentProfile {
    const headers = normalizeHeaders(input.headers || {});
    const candidates: Array<[ProfileSource, unknown]> = [
        ["profile", firstValue(headers, [CANVAS_PROFILE_HEADER, CANVAS_AGENT_PROFILE_HEADER, CANVAS_AGENT_PROFILE_ID_HEADER])],
        ["account", firstValue(headers, [CANVAS_ACCOUNT_HEADER])],
        ["device", firstValue(headers, [CANVAS_DEVICE_HEADER])],
        ["profile", firstValue(input.query, ["profileId", "profile", "profile_id"])],
        ["account", firstValue(input.query, ["accountId", "account_id"])],
        ["device", firstValue(input.query, ["deviceId", "device_id", "deviceProfileId"])],
        ["profile", firstValue(input.body, ["profileId", "profile", "profile_id"])],
        ["account", firstValue(input.body, ["accountId", "account_id"])],
        ["device", firstValue(input.body, ["deviceId", "device_id", "deviceProfileId"])],
    ];
    const selected = candidates.find(([, value]) => value !== undefined && value !== null && String(value).trim());
    if (!selected) return { key: LEGACY_PROFILE_KEY, id: "anonymous", source: "legacy", explicit: false };

    const [source, rawValue] = selected;
    const id = normalizeIdentifier(rawValue, "profile");
    if (source === "profile" && id === LEGACY_PROFILE_KEY) return { key: LEGACY_PROFILE_KEY, id: "anonymous", source: "legacy", explicit: true };
    if (source === "profile" && /^p1:[a-f0-9]{64}$/.test(id)) return { key: id, id, source, explicit: true };
    const origin = normalizeOrigin(input.origin) || "local";
    const key = `p1:${crypto.createHash("sha256").update(`${origin}\0${source}\0${id}`).digest("hex")}`;
    return { key, id, source, explicit: true };
}

/** 读取请求中的 client ID；缺失时返回空字符串以兼容旧 MCP/CLI 调用。 */
export function resolveClientId(input: ProfileInput) {
    const headers = normalizeHeaders(input.headers || {});
    const value = firstValue(headers, [CANVAS_CLIENT_HEADER])
        ?? firstValue(input.query, ["clientId", "client_id"])
        ?? firstValue(input.body, ["clientId", "client_id"]);
    if (value === undefined || value === null || !String(value).trim()) return "";
    return normalizeIdentifier(value, "client");
}

/** 将 profile identity 投影为只包含稳定字段的票据绑定值。 */
export function profileBinding(profile: AgentProfile) {
    return profile.key;
}

function normalizeIdentifier(value: unknown, kind: "profile" | "client") {
    if (typeof value !== "string" && typeof value !== "number") throw new ProfileInputError(`invalid ${kind} id`);
    const text = String(value ?? "").trim();
    const limit = kind === "profile" ? MAX_PROFILE_ID_LENGTH : MAX_CLIENT_ID_LENGTH;
    if (!text || text.length > limit || /[\u0000-\u001f\u007f]/.test(text)) throw new ProfileInputError(`invalid ${kind} id`);
    return text;
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>) {
    return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]));
}

function firstValue(source: Record<string, unknown> | undefined, keys: string[]) {
    if (!source) return undefined;
    for (const key of keys) {
        const value = source[key] ?? source[key.toLowerCase()];
        if (value !== undefined && value !== null && String(value).trim()) return value;
    }
    return undefined;
}

function normalizeOrigin(value: string | undefined) {
    if (!value) return "";
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
        return url.origin === value ? url.origin : "";
    } catch {
        return "";
    }
}
