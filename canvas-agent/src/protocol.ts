/**
 * HTTP bridge protocol metadata is intentionally independent from the npm
 * package version. A build can change while the wire contract remains
 * compatible, and diagnostics must not be mistaken for compatibility data.
 */
export const PROTOCOL_VERSION = 1 as const;
export const TOOL_AUTHORIZATION_CAPABILITY = "tool.authorization.v1" as const;
export const PAIRING_CHALLENGE_CAPABILITY = "pairing.challenge.v1" as const;

export const PROTOCOL_CAPABILITIES = Object.freeze([
    "health.v1",
    "pairing.v1",
    "pairing.ticket.v1",
    PAIRING_CHALLENGE_CAPABILITY,
    "events.sse-header-ticket.v1",
    "sessions.profile.v1",
    "runtime.claim.v1",
    "mcp.tools.v1",
    "entitlement.ed25519.v1",
    TOOL_AUTHORIZATION_CAPABILITY,
    "codex.prompt.v1",
]) as readonly string[];

export const REQUIRED_PAIRING_CAPABILITIES = Object.freeze([
    "health.v1",
    "pairing.v1",
    "pairing.ticket.v1",
    PAIRING_CHALLENGE_CAPABILITY,
    "events.sse-header-ticket.v1",
    "mcp.tools.v1",
    "entitlement.ed25519.v1",
    TOOL_AUTHORIZATION_CAPABILITY,
]) as readonly string[];

export const REQUIRED_RUNTIME_CAPABILITIES = Object.freeze([
    "health.v1",
    "runtime.claim.v1",
    TOOL_AUTHORIZATION_CAPABILITY,
]) as readonly string[];

export const REQUIRED_TOOL_CAPABILITIES = Object.freeze([
    "mcp.tools.v1",
    TOOL_AUTHORIZATION_CAPABILITY,
]) as readonly string[];

export type ProtocolMetadata = {
    protocolVersion: typeof PROTOCOL_VERSION;
    capabilities: readonly string[];
    buildVersion: string;
    buildId: string;
    releaseId: string;
};

export type ProtocolNegotiation =
    | { compatible: true; legacy: boolean; protocolVersion: typeof PROTOCOL_VERSION; capabilities: string[] }
    | { compatible: false; legacy: false; protocolVersion: typeof PROTOCOL_VERSION; capabilities: string[]; missingCapabilities: string[] };

/** 返回稳定的协议字段；调用方应把运行时诊断放到单独的 diagnostics 字段。 */
export function protocolMetadata(buildVersion: string, buildId = "source"): ProtocolMetadata {
    return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...PROTOCOL_CAPABILITIES],
        buildVersion,
        buildId,
        releaseId: `${buildVersion}+${buildId}`,
    };
}

/** 协商客户端显式提供的协议 offer；未提供 offer 的调用继续走旧版兼容路径。 */
export function negotiateProtocol(
    offer: { protocolVersion?: unknown; capabilities?: unknown } | null | undefined,
    requiredCapabilities: readonly string[] = ["pairing.v1"],
): ProtocolNegotiation {
    if (!offer || (offer.protocolVersion === undefined && offer.capabilities === undefined)) {
        if (requiredCapabilities.includes(TOOL_AUTHORIZATION_CAPABILITY)) {
            return { compatible: false, legacy: false, protocolVersion: PROTOCOL_VERSION, capabilities: [], missingCapabilities: [...requiredCapabilities] };
        }
        return { compatible: true, legacy: true, protocolVersion: PROTOCOL_VERSION, capabilities: [...PROTOCOL_CAPABILITIES] };
    }
    const versionMatches = offer.protocolVersion === PROTOCOL_VERSION || offer.protocolVersion === String(PROTOCOL_VERSION);
    const offeredCapabilities = Array.isArray(offer.capabilities) && offer.capabilities.every((item) => typeof item === "string")
        ? new Set(offer.capabilities)
        : null;
    const negotiated = offeredCapabilities ? PROTOCOL_CAPABILITIES.filter((capability) => offeredCapabilities.has(capability)) : [];
    const missingCapabilities = requiredCapabilities.filter((capability) => !offeredCapabilities?.has(capability));
    if (!versionMatches || !offeredCapabilities || missingCapabilities.length) {
        return { compatible: false, legacy: false, protocolVersion: PROTOCOL_VERSION, capabilities: negotiated, missingCapabilities };
    }
    return { compatible: true, legacy: false, protocolVersion: PROTOCOL_VERSION, capabilities: negotiated };
}

/**
 * 检查现代协议响应，或明确兼容的旧版响应。
 *
 * Legacy fallback is deliberately strict: callers provide the exact build
 * version they know how to speak to. A merely non-empty `version` is never
 * enough to accept a modern response.
 */
export function isProtocolCompatible(
    value: unknown,
    options: { requiredCapabilities?: readonly string[]; legacyBuildVersion?: string } = {},
) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const body = value as Record<string, unknown>;
    const hasModernMetadata = "protocolVersion" in body || "capabilities" in body || "buildVersion" in body;
    if (!hasModernMetadata) {
        if ((options.requiredCapabilities || []).includes(TOOL_AUTHORIZATION_CAPABILITY)) return false;
        return typeof options.legacyBuildVersion === "string"
            && body.version === options.legacyBuildVersion
            && options.legacyBuildVersion.length > 0;
    }

    const protocolVersion = body.protocolVersion;
    if (protocolVersion !== PROTOCOL_VERSION && protocolVersion !== String(PROTOCOL_VERSION)) return false;
    if (!Array.isArray(body.capabilities) || body.capabilities.some((item) => typeof item !== "string")) return false;
    if (typeof body.buildVersion !== "string" || !body.buildVersion.trim()) return false;
    const capabilities = new Set(body.capabilities);
    return (options.requiredCapabilities || []).every((capability) => capabilities.has(capability));
}

/** 统一 HTTP 响应头中的协议元数据，保留既有 service/version 头。 */
export function protocolHeaders(buildVersion: string, buildId = "source") {
    const metadata = protocolMetadata(buildVersion, buildId);
    return {
        "X-Canvas-Agent-Protocol-Version": String(metadata.protocolVersion),
        "X-Canvas-Agent-Capabilities": metadata.capabilities.join(","),
        "X-Canvas-Agent-Build-Version": metadata.buildVersion,
        "X-Canvas-Agent-Build-Id": metadata.buildId,
        "X-Canvas-Agent-Release-Id": metadata.releaseId,
    };
}
