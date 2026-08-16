import crypto from "node:crypto";

import { externalFetch } from "./network/external-fetch.js";

const OFFICIAL_ORIGINS = new Set(["https://sneeai.com"]);
const DEFAULT_DEVELOPMENT_ORIGINS = new Set([
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://127.0.0.1:3100",
    "http://localhost:3100",
]);
const PUBLIC_KEY_PATH = "/api/v1/agent/entitlement/public-key";
const MAX_TOKEN_LENGTH = 8192;

export type PlatformEntitlementClaims = {
    version: 1;
    iss: string;
    aud: "sneeai-agent";
    sub: string;
    scope: "agent:connect";
    origin: string;
    profile_id: string;
    client_id: string;
    device_id: string;
    instance_key: string;
    authorization_version: number;
    minimum_agent_version: string;
    iat: number;
    exp: number;
    jti: string;
};

type PublicKeyDocument = {
    issuer?: unknown;
    key_id?: unknown;
    algorithm?: unknown;
    public_key?: unknown;
};

export class EntitlementVerificationError extends Error {
    constructor(readonly code: string, message: string, readonly statusCode = 403) {
        super(message);
        this.name = "EntitlementVerificationError";
    }
}

export function entitlementRequired(origin: string) {
    if (OFFICIAL_ORIGINS.has(origin)) return true;
    if (process.env.CANVAS_AGENT_REQUIRE_ENTITLEMENT === "true") return true;
    return !isKnownDevelopmentOrigin(origin);
}

export function canResolveEntitlementAuthority(origin: string) {
    return OFFICIAL_ORIGINS.has(origin) || isKnownDevelopmentOrigin(origin);
}

/** 长期 Connect token 仅供本机进程和无需网站授权的开发页面使用。 */
export function canUsePersistentToken(origin: string) {
    return !origin || !entitlementRequired(origin);
}

export async function verifyPlatformEntitlement(
    token: string,
    expected: { origin: string; profileId: string; clientId: string; deviceId: string; instanceKey: string; agentVersion: string },
    options: { now?: number; resolvePublicKey?: (origin: string, keyId: string) => Promise<PublicKeyMaterial> } = {},
) {
    if (!canResolveEntitlementAuthority(expected.origin)) {
        throw new EntitlementVerificationError("agent_entitlement_origin_not_allowed", "entitlement authority origin is not allowed");
    }
    const parts = token.split(".");
    if (token.length > MAX_TOKEN_LENGTH || parts.length !== 3) {
        throw new EntitlementVerificationError("agent_entitlement_invalid", "Agent entitlement is invalid");
    }
    const header = parseObject(parts[0]);
    const claims = parseObject(parts[1]);
    if (header.alg !== "EdDSA" || header.typ !== "JWT" || typeof header.kid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(header.kid)) {
        throw new EntitlementVerificationError("agent_entitlement_invalid", "Agent entitlement algorithm is invalid");
    }
    const resolve = options.resolvePublicKey || resolveEntitlementPublicKey;
    let publicKey: PublicKeyMaterial;
    try {
        publicKey = await resolve(expected.origin, header.kid);
    } catch {
        throw new EntitlementVerificationError("agent_entitlement_authority_unavailable", "无法验证网站 Agent 授权，请检查网站连接", 503);
    }
    if (publicKey.keyId !== header.kid || publicKey.algorithm !== "EdDSA") {
        throw new EntitlementVerificationError("agent_entitlement_key_mismatch", "Agent entitlement key is invalid");
    }
    const signature = decodeBase64Url(parts[2]);
    if (!signature || signature.length !== 64) {
        throw new EntitlementVerificationError("agent_entitlement_invalid", "Agent entitlement signature is invalid");
    }
    let verified = false;
    try {
        verified = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey.keyObject, signature);
    } catch {
        verified = false;
    }
    if (!verified) throw new EntitlementVerificationError("agent_entitlement_invalid", "Agent entitlement signature is invalid");
    const parsedClaims = validateClaims(claims, expected, options.now ?? Date.now());
    if (parsedClaims.iss !== publicKey.issuer) throw new EntitlementVerificationError("agent_entitlement_key_mismatch", "Agent entitlement key is invalid");
    return parsedClaims;
}

export type PublicKeyMaterial = { keyId: string; algorithm: "EdDSA"; issuer: string; keyObject: crypto.KeyObject };

/** 解析网站发布的 Ed25519 entitlement 公钥，供连接票据和单次操作许可共同使用。 */
export async function resolveEntitlementPublicKey(origin: string, keyId: string): Promise<PublicKeyMaterial> {
    const configured = process.env.CANVAS_AGENT_ENTITLEMENT_PUBLIC_KEY?.trim();
    if (configured) {
        const issuer = process.env.CANVAS_AGENT_ENTITLEMENT_ISSUER?.trim() || origin;
        return materialFromRaw(configured, keyId, issuer);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
        const response = await externalFetch(`${origin}${PUBLIC_KEY_PATH}`, { signal: controller.signal, cache: "no-store", redirect: "error" });
        if (!response.ok) throw new Error("public key unavailable");
        const body = await response.json() as PublicKeyDocument;
        if (body.algorithm !== "EdDSA" || body.key_id !== keyId || typeof body.issuer !== "string" || typeof body.public_key !== "string") throw new Error("public key invalid");
        return materialFromRaw(body.public_key, keyId, body.issuer);
    } finally {
        clearTimeout(timer);
    }
}

function materialFromRaw(value: string, keyId: string, issuer: string): PublicKeyMaterial {
    if (!isExactOrigin(issuer)) throw new Error("issuer invalid");
    const raw = decodeBase64Url(value) || decodeBase64(value);
    if (!raw || raw.length !== 32) throw new Error("public key invalid");
    const digest = crypto.createHash("sha256").update(raw).digest("base64url").slice(0, 16);
    if (digest !== keyId) throw new Error("public key id invalid");
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    return { keyId, algorithm: "EdDSA", issuer, keyObject: crypto.createPublicKey({ key: der, format: "der", type: "spki" }) };
}

function validateClaims(value: Record<string, unknown>, expected: { origin: string; profileId: string; clientId: string; deviceId: string; instanceKey: string; agentVersion: string }, nowMs: number): PlatformEntitlementClaims {
    const requiredStrings = ["iss", "sub", "origin", "profile_id", "client_id", "device_id", "instance_key", "minimum_agent_version", "jti"];
    if (value.version !== 1 || value.aud !== "sneeai-agent" || value.scope !== "agent:connect" || requiredStrings.some((key) => typeof value[key] !== "string")) {
        throw new EntitlementVerificationError("agent_entitlement_invalid", "Agent entitlement claims are invalid");
    }
    const claims = value as unknown as PlatformEntitlementClaims;
    if (!isExactOrigin(claims.origin)
        || claims.origin !== expected.origin
        || claims.profile_id !== expected.profileId
        || claims.profile_id !== `v1:user:${claims.sub}`
        || claims.client_id !== expected.clientId
        || claims.device_id !== expected.deviceId
        || claims.instance_key !== expected.instanceKey
        || !claims.sub
        || !claims.jti) {
        throw new EntitlementVerificationError("agent_entitlement_binding_mismatch", "Agent entitlement does not match this page");
    }
    if (!isExactOrigin(claims.iss) || !Number.isSafeInteger(claims.authorization_version) || claims.authorization_version <= 0 || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp <= claims.iat) {
        throw new EntitlementVerificationError("agent_entitlement_invalid", "Agent entitlement time claims are invalid");
    }
    const now = Math.floor(nowMs / 1000);
    if (claims.exp <= now || claims.iat > now + 30 || claims.exp - claims.iat > 10 * 60 || claims.iat < now - 10 * 60) {
        throw new EntitlementVerificationError("agent_entitlement_expired", "Agent entitlement has expired");
    }
    const currentVersion = parseSemver(expected.agentVersion);
    const minimumVersion = parseSemver(claims.minimum_agent_version);
    if (!currentVersion || !minimumVersion) throw new EntitlementVerificationError("agent_entitlement_invalid", "Agent entitlement version is invalid");
    if (compareSemver(currentVersion, minimumVersion) < 0) {
        throw new EntitlementVerificationError("agent_entitlement_agent_version_too_old", `Sneeai Agent 版本过低，请升级到 ${claims.minimum_agent_version} 或更高版本`);
    }
    return claims;
}

type ParsedSemver = { core: [bigint, bigint, bigint]; prerelease: Array<string> };

function parseSemver(value: string): ParsedSemver | null {
    if (typeof value !== "string" || value.length > 64) return null;
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
    if (!match) return null;
    const core = match.slice(1, 4);
    if (core.some((part) => part.length > 1 && part.startsWith("0"))) return null;
    const prerelease = match[4]?.split(".") || [];
    if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
    return { core: core.map((part) => BigInt(part)) as [bigint, bigint, bigint], prerelease };
}

function compareSemver(left: ParsedSemver, right: ParsedSemver) {
    for (let index = 0; index < left.core.length; index++) {
        if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
    }
    if (!left.prerelease.length || !right.prerelease.length) return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1;
    const length = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < length; index++) {
        const leftPart = left.prerelease[index];
        const rightPart = right.prerelease[index];
        if (leftPart === undefined || rightPart === undefined) return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
        if (leftPart === rightPart) continue;
        const leftNumeric = /^\d+$/.test(leftPart);
        const rightNumeric = /^\d+$/.test(rightPart);
        if (leftNumeric && rightNumeric) return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftPart > rightPart ? 1 : -1;
    }
    return 0;
}

function parseObject(segment: string): Record<string, unknown> {
    const decoded = decodeBase64Url(segment);
    if (!decoded) throw new EntitlementVerificationError("agent_entitlement_invalid", "Agent entitlement is invalid");
    try {
        const value = JSON.parse(decoded.toString("utf8")) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
        return value as Record<string, unknown>;
    } catch {
        throw new EntitlementVerificationError("agent_entitlement_invalid", "Agent entitlement is invalid");
    }
}

function decodeBase64Url(value: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    try {
        return Buffer.from(value, "base64url");
    } catch {
        return null;
    }
}

function decodeBase64(value: string) {
    if (!/^[A-Za-z0-9+/=]+$/.test(value)) return null;
    try {
        return Buffer.from(value, "base64");
    } catch {
        return null;
    }
}

function isKnownDevelopmentOrigin(origin: string) {
    if (DEFAULT_DEVELOPMENT_ORIGINS.has(origin)) return true;
    const configured = (process.env.CANVAS_AGENT_PAIR_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
    return configured.some((value) => value === origin && isLoopbackOrigin(origin));
}

function isLoopbackOrigin(origin: string) {
    try {
        const url = new URL(origin);
        return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
    } catch {
        return false;
    }
}

function isExactOrigin(value: string) {
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && url.origin === value;
    } catch {
        return false;
    }
}
