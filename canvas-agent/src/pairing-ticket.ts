import crypto from "node:crypto";

export const PAIRING_TICKET_TTL_MS = 5 * 60 * 1000;
export const EVENT_TICKET_TTL_MS = 30 * 1000;
const TICKET_PREFIX = "cat1";
const MAX_TICKET_LENGTH = 4096;

export type AgentTicketKind = "pairing" | "events";
export type AgentTicketAuthorization = {
    subject: string;
    deviceId: string;
    authorizationVersion: number;
    expiresAt: number;
};
export type AgentTicketClaims = {
    version: 1;
    kind: AgentTicketKind;
    origin: string;
    profileKey: string;
    clientId: string;
    issuedAt: number;
    expiresAt: number;
    nonce: string;
    authorization?: AgentTicketAuthorization;
};

export type TicketVerification =
    | { ok: true; claims: AgentTicketClaims }
    | { ok: false; reason: "invalid" | "expired" | "origin" | "profile" | "client" | "kind" | "replayed" };

/** 使用本机 Connect token 派生的密钥签发短期、无对话内容的绑定票据。 */
export function createAgentTicket(
    secret: string,
    input: { kind: AgentTicketKind; origin: string; profileKey: string; clientId: string; now?: number; ttlMs?: number; nonce?: string; authorization?: AgentTicketAuthorization },
) {
    if (!validClientId(input.clientId)) throw new Error("invalid client id");
    const issuedAt = input.now ?? Date.now();
    const claims: AgentTicketClaims = {
        version: 1,
        kind: input.kind,
        origin: input.origin,
        profileKey: input.profileKey,
        clientId: input.clientId,
        issuedAt,
        expiresAt: issuedAt + (input.ttlMs ?? (input.kind === "events" ? EVENT_TICKET_TTL_MS : PAIRING_TICKET_TTL_MS)),
        nonce: input.nonce || crypto.randomBytes(16).toString("hex"),
        ...(input.authorization ? { authorization: { ...input.authorization } } : {}),
    };
    const payload = encode(JSON.stringify(claims));
    const unsigned = `${TICKET_PREFIX}.${payload}`;
    const signature = sign(secret, unsigned);
    return `${unsigned}.${signature}`;
}

/** 校验签名、时间和请求上下文；错误不会泄露具体票据状态给 HTTP 客户端。 */
export function verifyAgentTicket(
    secret: string,
    ticket: string,
    expected: { kind: AgentTicketKind; origin?: string; profileKey?: string; clientId?: string },
    now = Date.now(),
): TicketVerification {
    if (typeof ticket !== "string" || ticket.length === 0 || ticket.length > MAX_TICKET_LENGTH) return { ok: false, reason: "invalid" };
    const parts = ticket.split(".");
    if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) return { ok: false, reason: "invalid" };
    const unsigned = `${parts[0]}.${parts[1]}`;
    const expectedSignature = sign(secret, unsigned);
    if (!safeEqual(parts[2], expectedSignature)) return { ok: false, reason: "invalid" };

    let claims: AgentTicketClaims;
    try {
        const parsed = JSON.parse(decode(parts[1])) as Partial<AgentTicketClaims>;
        if (parsed.version !== 1 || (parsed.kind !== "pairing" && parsed.kind !== "events") || typeof parsed.origin !== "string" || typeof parsed.profileKey !== "string" || !validClientId(parsed.clientId) || typeof parsed.issuedAt !== "number" || typeof parsed.expiresAt !== "number" || typeof parsed.nonce !== "string" || !validAuthorization(parsed.authorization)) return { ok: false, reason: "invalid" };
        claims = parsed as AgentTicketClaims;
    } catch {
        return { ok: false, reason: "invalid" };
    }
    if (claims.kind !== expected.kind) return { ok: false, reason: "kind" };
    if (!Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= claims.issuedAt || claims.expiresAt <= now || claims.issuedAt > now + 30_000) return { ok: false, reason: claims.expiresAt <= now ? "expired" : "invalid" };
    if (claims.authorization && claims.authorization.expiresAt < claims.expiresAt) return { ok: false, reason: "invalid" };
    if (expected.origin !== undefined && claims.origin !== expected.origin) return { ok: false, reason: "origin" };
    if (expected.profileKey !== undefined && claims.profileKey !== expected.profileKey) return { ok: false, reason: "profile" };
    // 调用方声明 clientId 时票据必须严格相等；票据为空 clientId 同样拒绝（不匹配任何声明）。
    if (expected.clientId !== undefined && claims.clientId !== expected.clientId) return { ok: false, reason: "client" };
    return { ok: true, claims };
}

function validClientId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validAuthorization(value: unknown) {
    if (value === undefined) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const authorization = value as Partial<AgentTicketAuthorization>;
    return typeof authorization.subject === "string"
        && authorization.subject.length > 0
        && authorization.subject.length <= 200
        && typeof authorization.deviceId === "string"
        && authorization.deviceId.length > 0
        && authorization.deviceId.length <= 200
        && Number.isSafeInteger(authorization.authorizationVersion)
        && Number(authorization.authorizationVersion) > 0
        && Number.isSafeInteger(authorization.expiresAt)
        && Number(authorization.expiresAt) > 0;
}

/** 一次性事件票据的服务端重放保护。 */
export class EventTicketReplayGuard {
    private used = new Map<string, number>();

    consume(claims: AgentTicketClaims, now = Date.now()) {
        this.prune(now);
        if (this.used.has(claims.nonce)) return false;
        this.used.set(claims.nonce, claims.expiresAt);
        return true;
    }

    private prune(now: number) {
        this.used.forEach((expiresAt, nonce) => {
            if (expiresAt < now) this.used.delete(nonce);
        });
    }
}

function sign(secret: string, value: string) {
    return crypto.createHmac("sha256", `canvas-agent-ticket\0${secret}`).update(value).digest("hex");
}

function safeEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left, "utf8");
    const rightBuffer = Buffer.from(right, "utf8");
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function encode(value: string) {
    return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string) {
    return Buffer.from(value, "base64url").toString("utf8");
}
