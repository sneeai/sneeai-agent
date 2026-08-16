import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";

import { runClaudeTurn } from "../agent/claude.js";
import { archiveCodexThread, interruptCodexTurn, isRecoverableThreadError, listCodexThreads, readCodexThread, resolveCodexApproval, resumeCodexThread, runCodexTurn, startCodexThread, stopCodexApp, stopCodexProfile, summarizeCodexThread, verifyCodexProviderAccess, verifyCodexThreadWorkspace } from "../agent/codex.js";
import { CodexProviderPolicyError } from "../agent/codex-provider-policy.js";
import { canvasCodexConnectionStatus, canvasCodexMode, CodexConnectionInputError, CodexRelayApiKeyRequiredError, configureCanvasCodexConnection, codexRuntimeFingerprint } from "../agent/codex-runtime.js";
import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "../agent/types.js";
import { CanvasCodexControlError, CanvasSession, CanvasToolDecisionError, type CanvasClientAuthorization, type PendingToolProposal } from "../canvas/session.js";
import { CanvasSessionRegistry, CanvasSessionRoutingError } from "../canvas/session-registry.js";
import { AGENT_SERVICE, BUILD_ID, canvasAgentDeviceId, canvasAgentPortCandidates, CONFIG_DIR, DEFAULT_PORT, ensureProfileWorkspace, ensureSiteWorkspace, loadConfig, saveConfig, updateProfileWorkspace, updateSiteWorkspace, VERSION, type CanvasAgentConfig } from "../config.js";
import { EntitlementLeaseRegistry } from "../entitlement-lease.js";
import { canUsePersistentToken, entitlementRequired, EntitlementVerificationError, verifyPlatformEntitlement } from "../entitlement.js";
import { createAgentPairingIdentity } from "../pairing-identity.js";
import { createAgentTicket, EventTicketReplayGuard, EVENT_TICKET_TTL_MS, PAIRING_TICKET_TTL_MS, verifyAgentTicket, type AgentTicketAuthorization, type AgentTicketClaims } from "../pairing-ticket.js";
import { canvasConnectionUrl, openExternalUrl } from "../pairing.js";
import { ProfileInputError, resolveClientId, resolveProfile, type AgentProfile } from "../profile.js";
import { negotiateProtocol, protocolHeaders, protocolMetadata, REQUIRED_PAIRING_CAPABILITIES, REQUIRED_TOOL_CAPABILITIES } from "../protocol.js";
import { ToolAuthorizationVerificationError, verifyToolAuthorization } from "../tool-authorization.js";
import { logger } from "../utils/logger.js";
import { resolveExternalNetworkDiagnostics } from "../network/external-fetch.js";
import { authorizeAutomaticPairing, authorizeRequestOrigin } from "./cors.js";
import { LocalFileCapabilityError, LocalFileCapabilityRegistry } from "./local-file-capabilities.js";
import { compareRuntimeClaims, createRuntimeClaim, isRuntimeClaim } from "./runtime-claim.js";

type CodexTurnOptions = {
    threadId?: string;
    cwd?: string;
    profileId?: string;
    permissionMode?: AgentPermissionMode;
    appEmit?: AgentEmit;
    onStart?: () => void;
    onThread?: (threadId: string) => void;
    onTurn?: (turnId: string) => void;
    onFinish?: () => void;
};

type HttpCodexDependencies = {
    verifyProviderAccess: (emit: AgentEmit, profileId?: string) => Promise<void>;
    stopProfile: (profileId: string) => Promise<boolean>;
    startThread: (emit: AgentEmit, cwd?: string, permissionMode?: AgentPermissionMode, profileId?: string) => Promise<unknown>;
    runTurn: (prompt: string, emit: AgentEmit, attachments?: AgentAttachment[], options?: CodexTurnOptions) => Promise<void>;
    resolveApproval: (requestId: string, decision: string) => Promise<boolean>;
    interruptTurn: (threadId?: string, profileId?: string) => Promise<boolean>;
};

export type HttpServerOptions = {
    port?: number;
    portCandidates?: readonly number[];
    openCanvasUrl?: string;
    silent?: boolean;
    runtimeFingerprint?: string;
    runtimeClaim?: string;
    now?: () => number;
    codex?: Partial<HttpCodexDependencies>;
};

type RequestAuthorization = {
    origin: string;
    profile: AgentProfile;
    clientId: string;
    session: CanvasSession;
    ticket?: AgentTicketClaims;
    ticketAuthorization?: AgentTicketAuthorization;
    persistent: boolean;
    internalMcp: boolean;
};

type RequestWithAuthorization = Request & { canvasAuthorization?: RequestAuthorization };

class FullPermissionModeError extends Error {
    readonly statusCode = 403;
    readonly code = "full_permission_disabled";

    constructor() {
        super("网页不能启用 Codex 完全访问权限");
        this.name = "FullPermissionModeError";
    }
}

/** 启动仅监听本机的 Sneeai Agent HTTP 服务。 */
export function startHttpServer(options: HttpServerOptions = {}) {
    const config = loadConfig(true);
    const port = options.port || Number(process.env.PORT) || Number(new URL(config.url).port) || DEFAULT_PORT;
    config.url = `http://127.0.0.1:${port}`;
    const runtimeFingerprint = options.runtimeFingerprint || codexRuntimeFingerprint();
    const runtimeClaim = isRuntimeClaim(options.runtimeClaim) ? options.runtimeClaim : createRuntimeClaim();
    const now = options.now || Date.now;
    const codex: HttpCodexDependencies = {
        verifyProviderAccess: verifyCodexProviderAccess,
        stopProfile: stopCodexProfile,
        startThread: startCodexThread,
        runTurn: runCodexTurn,
        resolveApproval: resolveCodexApproval,
        interruptTurn: interruptCodexTurn,
        ...options.codex,
    };

    const sessions = new CanvasSessionRegistry({ now });
    const pairingIdentity = createAgentPairingIdentity(config.token);
    const eventTicketReplay = new EventTicketReplayGuard();
    const knownProfiles = new Map<string, AgentProfile>();
    const localFiles = new LocalFileCapabilityRegistry({ now });
    const leases = new EntitlementLeaseRegistry((profileKey, reason) => {
        sessions.disposeProfile(profileKey, `网站 Agent 授权${reason === "expired" ? "已过期" : "已失效"}`);
        localFiles.revokeProfile(profileKey);
        void codex.stopProfile(profileKey);
    }, now);
    let server: Server;
    let handoffAccepted = false;
    let handoffStop: Promise<void> | null = null;
    let mcpLastSeenAt: number | null = null;
    let pluginVersion: string | null = null;
    let mcpActiveBinding: string | null = null;
    const rememberProfile = (profile: AgentProfile) => {
        knownProfiles.set(profile.key, profile);
        return profile;
    };
    const sessionFor = (profile: AgentProfile) => sessions.session(profile.key);
    const workspaceFor = (profile: AgentProfile) => ensureProfileWorkspace(config, profile.key);
    /** 将 Agent 事件广播到指定 profile 的线程或全部网页。 */
    const emitFor = (profile: AgentProfile) => (type: string, payload: unknown) => {
        const session = sessionFor(profile);
        const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
        const workspace = workspaceFor(profile);
        const protectedData = localFiles.protectPayload(profile.key, workspace.workspacePath, data) as Record<string, unknown>;
        const threadId = String(protectedData.threadId || protectedData.thread_id || workspace.activeThreadId || "");
        threadId ? session.emitThread(type, threadId, protectedData) : session.emitAll(type, protectedData);
    };
    /** 将 provider 预检纳入运行时忙碌状态，避免配置交接中断检查。 */
    const verifyCodexAccess = async (profile: AgentProfile) => {
        const session = sessionFor(profile);
        const release = session.beginCodexOperation();
        try {
            await codex.verifyProviderAccess(emitFor(profile), profile.key);
        } finally {
            release();
        }
    };
    /** 保存并广播指定 profile 的活跃线程。 */
    const setActiveThread = (profile: AgentProfile, activeThreadId: string, payload: Record<string, unknown> = {}) => {
        const workspace = updateProfileWorkspace(config, profile.key, { activeThreadId: activeThreadId || undefined });
        sessionFor(profile).emitThread("workspace_changed", activeThreadId, { ...payload, activeThreadId });
        return workspace;
    };
    const authenticateRequest = (req: Request, res: Response, next: NextFunction) => {
        leases.expire(now());
        const origin = req.headers.origin || "";
        const url = requestUrl(req, config);
        const requestedProfile = resolveProfile({ origin, headers: req.headers, query: Object.fromEntries(url.searchParams) });
        const requestedClientId = resolveClientId({ origin, headers: req.headers, query: Object.fromEntries(url.searchParams) });
        const internalMcpTicket = headerValue(req, "x-canvas-agent-internal-ticket");
        const requestedTicket = headerValue(req, "x-canvas-agent-ticket") || headerValue(req, "x-canvas-agent-token");
        const required = Boolean(origin) && entitlementRequired(origin);
        const eventRequest = url.pathname === "/events";
        let profile = requestedProfile;
        let clientId = requestedClientId;
        let ticket: AgentTicketClaims | undefined;
        let ticketAuthorization: AgentTicketAuthorization | undefined;
        let persistent = false;
        let internalMcp = false;

        if (internalMcpTicket) {
            if (origin || url.pathname !== "/api/tools" || requestedTicket || requestedProfile.explicit || requestedClientId) return void res.status(401).json({ ok: false, error: "invalid token" });
            const verified = verifyAgentTicket(config.token, internalMcpTicket, { kind: "internal-mcp", origin: "local-internal" }, now());
            if (!verified.ok) return void res.status(401).json({ ok: false, error: "invalid token" });
            ticket = verified.claims;
            profile = knownProfiles.get(ticket.profileKey) || { key: ticket.profileKey, id: ticket.profileKey, source: "profile", explicit: true };
            clientId = "";
            internalMcp = true;
        } else if (requestedTicket === config.token) {
            if (eventRequest || required || (origin && !canUsePersistentToken(origin))) return void res.status(401).json({ ok: false, error: "invalid token" });
            if (requestedProfile.explicit) return void res.status(401).json({ ok: false, error: "invalid token" });
            persistent = true;
        } else {
            const verified = verifyAgentTicket(config.token, requestedTicket, {
                kind: eventRequest ? "events" : "pairing",
                ...(origin ? { origin } : {}),
                ...(requestedProfile.explicit ? { profileKey: requestedProfile.key } : {}),
                ...(requestedClientId ? { clientId: requestedClientId } : {}),
            }, now());
            if (!verified.ok || (eventRequest && !eventTicketReplay.consume(verified.claims, now()))) return void res.status(401).json({ ok: false, error: "invalid token" });
            ticket = verified.claims;
            profile = knownProfiles.get(ticket.profileKey) || (requestedProfile.explicit ? requestedProfile : { key: ticket.profileKey, id: ticket.profileKey, source: "profile", explicit: true });
            clientId ||= ticket.clientId;
            ticketAuthorization = ticket.authorization;
            if (required && !leases.authorize(profile.key, origin, ticketAuthorization)) return void res.status(401).json({ ok: false, error: "invalid token" });
        }

        rememberProfile(profile);
        (req as RequestWithAuthorization).canvasAuthorization = {
            origin,
            profile,
            clientId,
            session: sessionFor(profile),
            ticket,
            ticketAuthorization,
            persistent,
            internalMcp,
        };
        next();
    };
    const requestAuthorization = (req: Request) => {
        const authorization = (req as RequestWithAuthorization).canvasAuthorization;
        if (!authorization) throw new Error("Sneeai Agent request was not authenticated");
        return authorization;
    };
    const canvasClientAuthorization = (authorization: RequestAuthorization): CanvasClientAuthorization | undefined => {
        if (!authorization.ticketAuthorization) return undefined;
        return {
            origin: authorization.origin,
            profileId: authorization.profile.id,
            profileKey: authorization.profile.key,
            clientId: authorization.clientId,
            subject: authorization.ticketAuthorization.subject,
            deviceId: authorization.ticketAuthorization.deviceId,
            authorizationVersion: authorization.ticketAuthorization.authorizationVersion,
            expiresAt: authorization.ticketAuthorization.expiresAt,
        };
    };
    const app = express();
    const activeResponses = new Set<Response>();
    const requestDrainWaiters = new Set<() => void>();
    const waitForRequestDrain = () => {
        if (!activeResponses.size) return Promise.resolve();
        return new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout>;
            const done = () => {
                clearTimeout(timer);
                requestDrainWaiters.delete(done);
                resolve();
            };
            timer = setTimeout(done, 1_000);
            requestDrainWaiters.add(done);
        });
    };
    app.disable("x-powered-by");
    app.use((_req, res, next) => {
        activeResponses.add(res);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            activeResponses.delete(res);
            if (!activeResponses.size) [...requestDrainWaiters].forEach((waiter) => waiter());
        };
        res.once("finish", release);
        res.once("close", release);
        next();
    });
    app.use((_req, res, next) => {
        res.setHeader("X-Canvas-Agent-Service", AGENT_SERVICE);
        res.setHeader("X-Canvas-Agent-Version", VERSION);
        Object.entries(protocolHeaders(VERSION, BUILD_ID)).forEach(([key, value]) => res.setHeader(key, value));
        next();
    });
    app.use((req, res, next) => {
        if (!logger.enabled) return next();
        const startedAt = Date.now();
        const url = requestUrl(req, config);
        res.on("finish", () => {
            if (req.method === "OPTIONS" || (res.statusCode < 400 && ["/health", "/canvas/state", "/canvas/activate"].includes(url.pathname))) return;
            logger.debug(`HTTP ${req.method} ${url.pathname}`, { status: res.statusCode, durationMs: Date.now() - startedAt });
        });
        next();
    });
    app.use((req, res, next) => {
        const url = requestUrl(req, config);
        if (!setCors(req, res, url, config)) return void res.status(403).json({ ok: false, error: "origin not allowed" });
        if (req.method === "OPTIONS") return void res.json({});
        next();
    });
    app.get("/health", route(async (_req, res) => {
        const diagnostics = sessions.health();
        const network = await resolveExternalNetworkDiagnostics("https://sneeai.com/agent-release.json");
        res.json({
            ...diagnostics,
            ...protocolMetadata(VERSION, BUILD_ID),
            service: AGENT_SERVICE,
            version: VERSION,
            agentOnline: true,
            sitePaired: diagnostics.clients > 0,
            pluginInstalled: mcpLastSeenAt !== null,
            pluginVersion,
            mcpActiveCanvas: mcpLastSeenAt !== null && mcpActiveBinding !== null && mcpActiveBinding === sessions.activeBindingKey(),
            mcpLastSeenAt,
            proxyMode: network.proxyMode,
            proxyDiagnosticCode: network.diagnosticCode || null,
            diagnostics,
        });
    }));
    app.get("/config", (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        const origin = req.headers.origin || "";
        const trusted = !origin || authorizeAutomaticPairing(origin, process.env.CANVAS_AGENT_PAIR_ORIGINS || "", config.origins || []);
        res.json({ ok: true, url: config.url, ...protocolMetadata(VERSION, BUILD_ID), ...(trusted ? {
            deviceId: canvasAgentDeviceId(config),
            instanceKey: pairingIdentity.instanceKey,
            instancePublicKey: pairingIdentity.instancePublicKey,
            ...publicCodexConnection(config),
        } : {}) });
    });
    app.post("/pairing/proof", express.json({ limit: "16kb" }), route(async (req, res) => {
        const origin = req.headers.origin || "";
        if (!authorizeAutomaticPairing(origin, process.env.CANVAS_AGENT_PAIR_ORIGINS || "", config.origins || [])) return res.status(403).json({ ok: false, error: "origin not allowed" });
        const negotiation = negotiateProtocol(req.body, REQUIRED_PAIRING_CAPABILITIES);
        if (!negotiation.compatible) return res.status(426).json({ ok: false, code: "protocol_incompatible", missingCapabilities: negotiation.missingCapabilities });
        const profile = rememberProfile(resolveProfile({ origin, body: req.body, headers: req.headers }));
        const clientId = resolveClientId({ origin, body: req.body, headers: req.headers });
        if (!clientId) return res.status(400).json({ ok: false, error: "invalid client id" });
        const proof = await pairingIdentity.prove(String(req.body?.challenge || ""), {
            origin,
            profileId: profile.id,
            clientId,
            deviceId: canvasAgentDeviceId(config),
            agentVersion: VERSION,
        }, { now: now() });
        res.setHeader("Cache-Control", "no-store");
        res.json({ ok: true, service: AGENT_SERVICE, proof, deviceId: canvasAgentDeviceId(config), instanceKey: pairingIdentity.instanceKey, instancePublicKey: pairingIdentity.instancePublicKey, ...protocolMetadata(VERSION, BUILD_ID), negotiatedCapabilities: negotiation.capabilities });
    }));
    app.post("/pair", express.json({ limit: "16kb" }), route(async (req, res) => {
        const origin = req.headers.origin || "";
        if (!authorizeAutomaticPairing(origin, process.env.CANVAS_AGENT_PAIR_ORIGINS || "", config.origins || [])) return res.status(403).json({ ok: false, error: "origin not allowed" });
        const negotiation = negotiateProtocol(req.body, REQUIRED_PAIRING_CAPABILITIES);
        if (!negotiation.compatible) return res.status(426).json({ ok: false, code: "protocol_incompatible", missingCapabilities: negotiation.missingCapabilities });
        const profile = rememberProfile(resolveProfile({ origin, body: req.body, headers: req.headers }));
        const clientId = resolveClientId({ origin, body: req.body, headers: req.headers });
        if (!clientId) return res.status(400).json({ ok: false, error: "invalid client id" });
        const deviceId = canvasAgentDeviceId(config);
        const entitlementToken = String(req.headers["x-canvas-agent-entitlement"] || "");
        let entitlement = "";
        let authorization: AgentTicketAuthorization | undefined;
        const requiresEntitlement = entitlementRequired(origin);
        if (entitlementToken) {
            entitlement = entitlementToken;
            const claims = await verifyPlatformEntitlement(entitlementToken, { origin, profileId: profile.id, clientId, deviceId, instanceKey: pairingIdentity.instanceKey, agentVersion: VERSION }, { now: now() });
            authorization = leases.renew(profile.key, claims);
        } else if (requiresEntitlement) {
            throw new EntitlementVerificationError("agent_entitlement_required", "Agent entitlement is required");
        }
        let previousMode: "inherit" | "isolated" | null = null;
        let modeChanged = false;
        const session = sessionFor(profile);
        if (req.body?.mode !== undefined) {
            if (session.runtimeBusy) return res.status(409).json({ ok: false, error: "Codex 正在运行，暂时不能切换 Agent 中转" });
            const mode = String(req.body.mode || "");
            if (mode !== "inherit" && mode !== "isolated") return res.status(400).json({ ok: false, error: "Codex 连接模式无效" });
            previousMode = canvasCodexMode(config);
            modeChanged = previousMode !== mode;
            configureCanvasCodexConnection(config, { mode, ...(typeof req.body.apiKey === "string" ? { apiKey: req.body.apiKey } : {}) });
        }
        try {
            await verifyCodexAccess(profile);
        } catch (error) {
            if (modeChanged && previousMode) configureCanvasCodexConnection(config, { mode: previousMode });
            throw error;
        }
        if (modeChanged) setActiveThread(profile, "", { emptyThread: true, draftThread: true });
        config.origins ||= [];
        if (!config.origins.includes(origin)) {
            config.origins.push(origin);
            saveConfig(config);
        }
        const pairingIssuedAt = now();
        const pairingTtlMs = Math.min(PAIRING_TICKET_TTL_MS, authorization ? Math.max(1, authorization.expiresAt - pairingIssuedAt) : PAIRING_TICKET_TTL_MS);
        const pairingTicketExpiresAt = pairingIssuedAt + pairingTtlMs;
        const pairingTicket = createAgentTicket(config.token, {
            kind: "pairing",
            origin,
            profileKey: profile.key,
            clientId,
            now: pairingIssuedAt,
            ttlMs: pairingTtlMs,
            authorization,
        });
        res.setHeader("Cache-Control", "no-store");
        res.json({ ok: true, url: config.url, token: pairingTicket, pairingTicket, pairingTicketExpiresAt, profileKey: profile.key, deviceId, instanceKey: pairingIdentity.instanceKey, instancePublicKey: pairingIdentity.instancePublicKey, service: AGENT_SERVICE, version: VERSION, ...protocolMetadata(VERSION, BUILD_ID), negotiatedCapabilities: negotiation.capabilities, ...(authorization ? { pairingConfirmation: pairingIdentity.confirm(String(req.body?.pairingNonce || ""), entitlement, pairingTicket) } : {}), ...publicCodexConnection(config) });
    }));
    app.use(authenticateRequest);
    app.use(express.json({ limit: "30mb" }));
    app.use((req, res, next) => {
        if (!handoffAccepted || req.path === "/agent/runtime" || req.path === "/agent/runtime/handoff") return next();
        res.status(503).json({ ok: false, error: "Sneeai Agent bridge is restarting" });
    });
    app.post("/agent/events-ticket", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
        const hasRequestedClientId = Object.prototype.hasOwnProperty.call(body, "clientId") || Object.prototype.hasOwnProperty.call(body, "client_id");
        const requestedClientId = resolveClientId({ body: req.body });
        if (hasRequestedClientId && !requestedClientId) return res.status(400).json({ ok: false, error: "invalid client id" });
        const clientId = requestedClientId || authorization.clientId;
        if (!clientId) return res.status(400).json({ ok: false, error: "invalid client id" });
        if (authorization.clientId && authorization.clientId !== clientId) return res.status(401).json({ ok: false, error: "invalid token" });
        await verifyCodexAccess(authorization.profile);
        const ticket = createAgentTicket(config.token, {
            kind: "events",
            origin: authorization.origin,
            profileKey: authorization.profile.key,
            clientId,
            now: now(),
            ttlMs: Math.min(EVENT_TICKET_TTL_MS, authorization.ticketAuthorization ? Math.max(1, authorization.ticketAuthorization.expiresAt - now()) : EVENT_TICKET_TTL_MS),
            authorization: authorization.ticketAuthorization,
        });
        res.setHeader("Cache-Control", "no-store");
        res.json({ ok: true, ticket });
    }));
    app.get("/events", (req, res) => {
        const authorization = requestAuthorization(req);
        authorization.session.openEvents(requestUrl(req, config), res, authorization.clientId, canvasClientAuthorization(authorization));
    });
    app.post("/canvas/state", (req, res) => {
        const authorization = requestAuthorization(req);
        const clientId = authorizedClientId(authorization, String(req.query.clientId || ""));
        authorization.session.updateState(req.body, clientId || undefined);
        if (clientId) sessions.touchCanvas(authorization.profile.key, clientId);
        res.json({ ok: true });
    });
    app.post("/canvas/activate", (req, res) => {
        const authorization = requestAuthorization(req);
        sessions.activateCanvas(authorization.profile.key, authorizedClientId(authorization, String(req.query.clientId || "")));
        res.json({ ok: true });
    });
    app.post("/canvas/tool-decision", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        if (!authorization.ticketAuthorization || authorization.persistent) return res.status(401).json({ ok: false, error: "invalid token" });
        const clientId = authorizedClientId(authorization, String(req.query.clientId || ""));
        const decision = {
            operationId: String(req.body?.operationId || ""),
            decision: String(req.body?.decision || "") as "approve" | "reject",
            error: typeof req.body?.error === "string" ? req.body.error : undefined,
        };
        if (!decision.operationId || (decision.decision !== "approve" && decision.decision !== "reject")) return res.status(400).json({ ok: false, error: "invalid tool decision" });
        const accepted = await authorization.session.decideTool(clientId, decision, async (proposal) => await verifyToolPermit(req, authorization, clientId, proposal, now));
        res.status(accepted ? 200 : 409).json({ ok: accepted });
    }));
    app.post("/canvas/result", (req, res) => {
        const authorization = requestAuthorization(req);
        const ok = authorization.session.resolveResult(authorizedClientId(authorization, String(req.query.clientId || "")), req.body);
        res.status(ok ? 200 : 409).json({ ok });
    });
    app.get("/agent/attachments/:attachmentId", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        const attachment = authorization.session.getTurnAttachment(authorizedClientId(authorization, String(req.query.clientId || "")), routeParam(req.params.attachmentId));
        const data = attachment.dataUrl.split(",", 2)[1];
        if (!data) throw new Error("图片附件内容无效");
        res.setHeader("Cache-Control", "no-store");
        res.type(attachment.type).send(Buffer.from(data, "base64"));
    }));
    app.post("/agent/local-file/reveal", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        const entry = localFiles.resolve(authorization.profile.key, String(req.body?.handle || ""));
        await revealLocalFile(entry.filePath, entry.isDirectory);
        res.json({ ok: true });
    }));
    app.post("/agent/local-image", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        const reference = String(req.body?.handle || "");
        const entry = localFiles.resolve(authorization.profile.key, reference);
        if (entry.isDirectory || !/\.(?:avif|gif|jpe?g|png|webp)$/i.test(entry.filePath)) return res.status(400).json({ ok: false, error: "图片文件无效" });
        const image = await localFiles.readFile(authorization.profile.key, reference, 25 * 1024 * 1024);
        res.setHeader("Cache-Control", "no-store");
        res.type(path.extname(entry.filePath)).send(image.data);
    }));
    app.post("/api/tools", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        if (!requestHasToolProtocol(req)) return res.status(426).json({ ok: false, code: "protocol_incompatible" });
        const localPlugin = authorization.persistent && !authorization.internalMcp && !authorization.profile.explicit && !authorization.clientId;
        if (localPlugin) {
            mcpLastSeenAt = now();
            pluginVersion = boundedPluginVersion(req.headers["x-canvas-plugin-version"]);
        }
        const session = localPlugin
            ? sessions.resolveLocalToolSession()
            : authorization.session;
        if (localPlugin) mcpActiveBinding = sessions.activeBindingKey();
        res.json({ ok: true, result: await session.callTool(req.body?.name, req.body?.input || {}, {
            ...(localPlugin ? { routing: "active" as const } : {}),
            operationId: typeof req.body?.operationId === "string" ? req.body.operationId : undefined,
        }) });
    }));
    app.get("/agent/codex/workspace", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        await verifyCodexAccess(authorization.profile);
        const workspace = workspaceFor(authorization.profile);
        res.json({ ok: true, workspace });
    }));
    app.use("/agent/codex", (_req, res, next) => {
        const release = requestAuthorization(_req).session.beginCodexOperation();
        res.once("finish", release);
        res.once("close", release);
        next();
    });
    app.get("/agent/runtime", (_req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.json({ ok: true, fingerprint: runtimeFingerprint, claim: runtimeClaim, busy: sessions.runtimeBusy });
    });
    app.post("/agent/runtime/handoff", (req, res) => {
        if (req.headers.origin) return res.status(403).json({ ok: false, error: "browser handoff forbidden" });
        const requestedFingerprint = String(req.body?.fingerprint || "");
        if (!/^v1:[a-f0-9]{64}$/.test(requestedFingerprint)) return res.status(400).json({ ok: false, error: "invalid runtime fingerprint" });
        if (requestedFingerprint === runtimeFingerprint) return res.json({ ok: true, handoff: false });
        const requestedClaim = String(req.body?.claim || "");
        if (!isRuntimeClaim(requestedClaim) || compareRuntimeClaims(requestedClaim, runtimeClaim) <= 0) return res.status(409).json({ ok: false, stale: true });
        if (sessions.runtimeBusy) return res.status(409).json({ ok: false, busy: true });
        if (!handoffAccepted) {
            handoffAccepted = true;
            res.once("finish", () => {
                setImmediate(() => {
                    handoffStop ||= stopHttpBridge(server, sessions, leases, waitForRequestDrain);
                    void handoffStop.catch(() => logger.error("Sneeai Agent bridge handoff failed"));
                });
            });
        }
        return res.status(202).json({ ok: true, handoff: true });
    });
    app.get("/agent/codex/threads", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        const workspace = workspaceFor(authorization.profile);
        const result = await listCodexThreads(emitFor(authorization.profile), { cwd: workspace.workspacePath, searchTerm: String(req.query.searchTerm || ""), profileId: authorization.profile.key });
        res.json({ ok: true, workspace, ...result });
    }));
    app.post("/agent/codex/threads/new", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        const requestedPermissionMode = permissionMode(req.body?.permissionMode);
        if (authorization.session.codexBusy) return res.status(409).json({ ok: false, error: "Codex 正在运行，请等待当前任务完成" });
        const workspace = workspaceFor(authorization.profile);
        const thread = await codex.startThread(emitFor(authorization.profile), workspace.workspacePath, requestedPermissionMode, authorization.profile.key);
        const activeThreadId = String((thread as Record<string, unknown>).id || "");
        const nextWorkspace = setActiveThread(authorization.profile, activeThreadId, { emptyThread: true });
        res.json({ ok: true, workspace: nextWorkspace, thread: summarizeCodexThread(thread), messages: [] });
    }));
    app.post("/agent/codex/threads/reset", (req, res) => {
        const authorization = requestAuthorization(req);
        if (authorization.session.codexBusy) return res.status(409).json({ ok: false, error: "Codex 正在运行，请等待当前任务完成" });
        res.json({ ok: true, workspace: setActiveThread(authorization.profile, "", { emptyThread: true, draftThread: true }) });
    });
    app.get("/agent/codex/threads/:threadId", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        const workspace = workspaceFor(authorization.profile);
        const threadId = routeParam(req.params.threadId);
        try {
            res.json({ ok: true, workspace, ...(await readCodexThread(emitFor(authorization.profile), threadId, workspace.workspacePath, authorization.profile.key)) });
        } catch (error) {
            if (workspace.activeThreadId !== threadId || !isRecoverableThreadError(error)) throw error;
            res.json({ ok: true, workspace, thread: { id: threadId, preview: "", cwd: workspace.workspacePath }, messages: [] });
        }
    }));
    app.post("/agent/codex/threads/:threadId/resume", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        const requestedPermissionMode = permissionMode(req.body?.permissionMode);
        if (authorization.session.codexBusy) return res.status(409).json({ ok: false, error: "Codex 正在运行，请等待当前任务完成" });
        const workspace = workspaceFor(authorization.profile);
        const threadId = routeParam(req.params.threadId);
        const result = await resumeCodexThread(emitFor(authorization.profile), threadId, workspace.workspacePath, requestedPermissionMode, authorization.profile.key);
        const nextWorkspace = setActiveThread(authorization.profile, threadId);
        res.json({ ok: true, workspace: nextWorkspace, ...result });
    }));
    app.post("/agent/codex/threads/:threadId/delete", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        if (authorization.session.codexBusy) return res.status(409).json({ ok: false, error: "Codex 正在运行，请等待当前任务完成" });
        const workspace = workspaceFor(authorization.profile);
        const threadId = routeParam(req.params.threadId);
        await archiveCodexThread(emitFor(authorization.profile), threadId, workspace.workspacePath, authorization.profile.key);
        setActiveThread(authorization.profile, workspace.activeThreadId === threadId ? "" : workspace.activeThreadId || "");
        res.json({ ok: true });
    }));
    app.post("/agent/codex/turn", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        const session = authorization.session;
        const requestedPermissionMode = permissionMode(req.body?.permissionMode);
        if (session.codexBusy) return res.status(409).json({ ok: false, error: "Codex 正在运行，请等待当前任务完成" });
        const attachments = Array.isArray(req.body?.attachments) ? (req.body.attachments as AgentAttachment[]) : [];
        const workspace = workspaceFor(authorization.profile);
        const prompt = String(req.body?.prompt || "");
        if (!prompt.trim()) return res.status(400).json({ ok: false, error: "请输入任务内容" });
        const clientId = authorizedClientId(authorization, String(req.body?.clientId || ""));
        logger.info("Codex turn accepted", { threadId: req.body?.threadId, promptLength: prompt.length, attachmentCount: attachments.length });
        session.setCodexState({ busy: true, threadId: String(req.body?.threadId || workspace.activeThreadId || ""), turnId: "" });
        try {
            let threadId = String(req.body?.threadId || workspace.activeThreadId || "");
            let turnId = "";
            if (!threadId) {
                const thread = await codex.startThread(emitFor(authorization.profile), workspace.workspacePath, requestedPermissionMode, authorization.profile.key);
                threadId = String((thread as Record<string, unknown>).id || "");
                setActiveThread(authorization.profile, threadId, { emptyThread: true });
            } else if (threadId !== workspace.activeThreadId) {
                await verifyCodexThreadWorkspace(emitFor(authorization.profile), threadId, workspace.workspacePath, authorization.profile.key);
                setActiveThread(authorization.profile, threadId);
            }
            const attachmentRefs = session.setTurnAttachments(clientId, attachments);
            const chatMessage = {
                sourceClientId: clientId,
                message: { id: String(req.body?.messageId || Date.now()), role: "user", text: String(req.body?.messageText || prompt || `发送了 ${attachments.length} 张图片`) },
            };
            let chatThreadId = "";
            /** 将当前 turn 事件固定广播到实际线程。 */
            const turnEmit = (type: string, payload: unknown) => {
                const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
                session.emitThread(type, threadId, { ...data, ...(turnId ? { turn_id: turnId } : {}) });
            };
            void codex.runTurn(withAttachmentContext(prompt, attachmentRefs), turnEmit, attachments, {
                threadId,
                cwd: workspace.workspacePath,
                profileId: authorization.profile.key,
                permissionMode: requestedPermissionMode,
                appEmit: emitFor(authorization.profile),
                onStart: clientId ? () => session.bindClient(clientId) : undefined,
                onThread: (actualThreadId) => {
                    if (actualThreadId !== threadId) {
                        threadId = actualThreadId;
                        setActiveThread(authorization.profile, threadId, { emptyThread: true });
                    }
                    session.setCodexState({ busy: true, threadId, turnId: "" });
                    if (chatThreadId !== threadId) {
                        chatThreadId = threadId;
                        session.emitThread("chat_message", threadId, chatMessage);
                    }
                },
                onTurn: (actualTurnId) => {
                    turnId = actualTurnId;
                    logger.info("Codex turn started", { threadId, turnId });
                    session.setCodexState({ busy: true, threadId, turnId });
                },
                onFinish: () => {
                    logger.info("Codex turn finished", { threadId, turnId });
                    session.clearTurnAttachments(clientId);
                    if (clientId) session.releaseClient(clientId);
                    session.setCodexState({ busy: false, threadId, turnId });
                },
            });
            res.json({ ok: true, threadId });
        } catch (error) {
            session.setCodexState({ busy: false, threadId: String(req.body?.threadId || workspace.activeThreadId || ""), turnId: "" });
            throw error;
        }
    }));
    app.post("/agent/codex/approval", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        const decision = String(req.body?.decision || "");
        if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return res.status(400).json({ ok: false, error: "无效的审批决定" });
        const requestId = String(req.body?.requestId || "");
        if (!requestId) return res.status(400).json({ ok: false, error: "审批请求无效" });
        const scope = codexControlScope(authorization, req.body);
        const claimed = authorization.session.claimCodexApproval(requestId, scope);
        if (!claimed) return res.status(409).json({ ok: false, error: "审批请求已失效" });
        let resolved = false;
        try {
            resolved = await codex.resolveApproval(requestId, decision);
            authorization.session.finishCodexApproval(requestId, true);
        } catch (error) {
            authorization.session.finishCodexApproval(requestId, false);
            throw error;
        }
        const ok = resolved;
        res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "审批请求已失效" }) });
    }));
    app.post("/agent/codex/interrupt", route(async (req, res) => {
        const authorization = requestAuthorization(req);
        const active = authorization.session.authorizeCodexInterrupt(codexControlScope(authorization, req.body));
        const ok = await codex.interruptTurn(active.threadId, authorization.profile.key);
        res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "Codex 任务已结束" }) });
    }));
    app.post("/agent/claude/turn", (req, res) => {
        runClaudeTurn(String(req.body?.prompt || ""), emitFor(requestAuthorization(req).profile));
        res.json({ ok: true });
    });
    app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));
    app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
        logger.error("HTTP request failed", { method: req.method, path: req.path, error });
        const providerBlocked = error instanceof CodexProviderPolicyError;
        const apiKeyRequired = error instanceof CodexRelayApiKeyRequiredError;
        const invalidInput = error instanceof CodexConnectionInputError;
        const profileInputError = error instanceof ProfileInputError;
        const entitlementError = error instanceof EntitlementVerificationError;
        const toolAuthorizationError = error instanceof ToolAuthorizationVerificationError;
        const toolDecisionError = error instanceof CanvasToolDecisionError;
        const codexControlError = error instanceof CanvasCodexControlError;
        const localFileError = error instanceof LocalFileCapabilityError;
        const fullPermissionError = error instanceof FullPermissionModeError;
        const canvasRoutingError = error instanceof CanvasSessionRoutingError;
        const typedError = apiKeyRequired || invalidInput || profileInputError || entitlementError || toolAuthorizationError || toolDecisionError || codexControlError || localFileError || fullPermissionError || canvasRoutingError;
        const status = providerBlocked ? 403 : typedError ? error.statusCode : 500;
        const code = providerBlocked ? "codex_provider_not_allowed" : apiKeyRequired ? "relay_api_key_required" : entitlementError || toolAuthorizationError || toolDecisionError || codexControlError || localFileError || fullPermissionError || canvasRoutingError ? error.code : "";
        res.status(status).json({ ok: false, ...(code ? { code } : {}), ...((providerBlocked || apiKeyRequired) ? publicCodexConnection(config) : {}), error: error.message });
    });

    server = app.listen(port, "127.0.0.1", () => {
        saveConfig(config);
        if (!options.silent) {
            console.log("Sneeai Agent");
            console.log(`Local URL: ${config.url}`);
            console.log("Codex MCP is not installed by this command.");
            console.log("Install the Sneeai plugin in Codex to connect Codex with this Agent.");
            if (logger.enabled) console.log(`Debug log: ${logger.filePath}`);
        }
        logger.info("Sneeai Agent started", { url: config.url, workspace: ensureSiteWorkspace(config).workspacePath, debugLog: logger.filePath });
        if (options.openCanvasUrl) {
            const url = canvasConnectionUrl(options.openCanvasUrl, config);
            console.log(`Canvas URL: ${url}`);
            void openExternalUrl(url).catch((error) => console.error(`无法自动打开画布，请手动访问上面的 Canvas URL：${error instanceof Error ? error.message : String(error)}`));
        }
    });
    return server;
}

/** 在约定的本机端口范围内选择可用端口；不扫描用户任意端口。 */
export async function startHttpServerWithFallback(options: HttpServerOptions = {}) {
    const releaseInstanceLock = acquireAgentInstanceLock();
    try {
        const config = loadConfig(true);
        const configuredPort = options.port || Number(process.env.PORT) || Number(new URL(config.url).port) || DEFAULT_PORT;
        const candidates = options.portCandidates?.length
            ? options.portCandidates
            : Number.isInteger(options.port) || process.env.PORT
              ? [configuredPort]
              : canvasAgentPortCandidates(config);
        let lastError: unknown;
        for (const port of [...new Set(candidates)]) {
            const server = startHttpServer({ ...options, port });
            try {
                const listening = await waitForHttpServer(server);
                listening.once("close", releaseInstanceLock);
                return listening;
            } catch (error) {
                lastError = error;
                if (!isAddressInUse(error)) throw error;
                await closeHttpServer(server);
            }
        }
        throw lastError instanceof Error ? lastError : new Error("Sneeai Agent 没有可用的本机端口");
    } catch (error) {
        releaseInstanceLock();
        throw error;
    }
}

export class AgentInstanceLockError extends Error {
    readonly code = "EAGENTLOCKED";

    constructor() {
        super("另一个 Sneeai Agent 进程正在启动或运行");
        this.name = "AgentInstanceLockError";
    }
}

function acquireAgentInstanceLock() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const lockFile = path.join(CONFIG_DIR, "agent-instance.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
        const nonce = crypto.randomUUID();
        let descriptor: number;
        try {
            descriptor = fs.openSync(lockFile, "wx", 0o600);
        } catch (error) {
            if (!isFileExists(error)) throw error;
            const owner = readInstanceLock(lockFile);
            if (owner && processIsAlive(owner.pid)) throw new AgentInstanceLockError();
            try {
                fs.unlinkSync(lockFile);
            } catch (removeError) {
                if (!isFileMissing(removeError)) throw new AgentInstanceLockError();
            }
            continue;
        }
        const identity = JSON.stringify({ pid: process.pid, nonce });
        fs.writeFileSync(descriptor, identity);
        fs.fsyncSync(descriptor);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            fs.closeSync(descriptor);
            try {
                if (fs.readFileSync(lockFile, "utf8") === identity) fs.unlinkSync(lockFile);
            } catch (error) {
                if (!isFileMissing(error)) logger.warn("Unable to remove Agent instance lock", { error });
            }
        };
    }
    throw new AgentInstanceLockError();
}

function readInstanceLock(lockFile: string) {
    try {
        const value = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: unknown };
        return Number.isInteger(value.pid) && Number(value.pid) > 0 ? { pid: Number(value.pid) } : null;
    } catch {
        return null;
    }
}

function processIsAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error instanceof Error && "code" in error && error.code === "EPERM";
    }
}

function isFileExists(error: unknown) {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isFileMissing(error: unknown) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** 等待 HTTP Server 确认监听成功，并将端口错误交给调用方处理。 */
export function waitForHttpServer(server: Server) {
    if (server.listening) return Promise.resolve(server);
    return new Promise<Server>((resolve, reject) => {
        const onListening = () => {
            cleanup();
            resolve(server);
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const cleanup = () => {
            server.off("listening", onListening);
            server.off("error", onError);
        };
        server.once("listening", onListening);
        server.once("error", onError);
    });
}

async function stopHttpBridge(server: Server, sessions: CanvasSessionRegistry, leases: EntitlementLeaseRegistry, waitForRequestDrain: () => Promise<void>) {
    sessions.dispose();
    leases.dispose();
    await waitForRequestDrain();
    await Promise.all([stopCodexApp(), closeHttpServer(server)]);
}

function closeHttpServer(server: Server) {
    if (!server.listening) return Promise.resolve();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    return new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

function isAddressInUse(error: unknown) {
    return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

/** 将异步 Express 路由异常交给统一错误处理中间件。 */
function route(handler: (req: Request, res: Response) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
}

/** 从 Express 路由参数中读取单个字符串。 */
function routeParam(value: string | string[]) {
    return Array.isArray(value) ? value[0] || "" : value;
}

function permissionMode(value: unknown): AgentPermissionMode {
    if (value === "full" || value === "danger-full-access" || value === "dangerFullAccess") throw new FullPermissionModeError();
    return value === "automatic" ? value : "request";
}

function headerValue(req: Request, name: string) {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] || "" : value || "";
}

function authorizedClientId(authorization: RequestAuthorization, requested: string) {
    if (authorization.clientId && requested && authorization.clientId !== requested) throw new Error("invalid client id");
    return authorization.clientId || requested;
}

function codexControlScope(authorization: RequestAuthorization, body: unknown) {
    const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const requestedClientId = typeof value.clientId === "string" ? value.clientId : "";
    if (authorization.clientId && requestedClientId && authorization.clientId !== requestedClientId) {
        throw new CanvasCodexControlError("codex_control_scope_mismatch", "Codex 任务不属于当前网页");
    }
    return {
        profileKey: authorization.profile.key,
        clientId: authorization.clientId || requestedClientId,
        ...(typeof value.threadId === "string" && value.threadId ? { threadId: value.threadId } : {}),
        ...(typeof value.turnId === "string" && value.turnId ? { turnId: value.turnId } : {}),
    };
}

function requestHasToolProtocol(req: Request) {
    const version = headerValue(req, "x-canvas-agent-protocol-version");
    const capabilities = headerValue(req, "x-canvas-agent-capabilities").split(",").map((value) => value.trim()).filter(Boolean);
    return version === "1" && REQUIRED_TOOL_CAPABILITIES.every((capability) => capabilities.includes(capability));
}

function boundedPluginVersion(value: unknown) {
    const version = Array.isArray(value) ? value[0] : value;
    return typeof version === "string" && /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(version) ? version : null;
}

async function verifyToolPermit(
    req: Request,
    authorization: RequestAuthorization,
    clientId: string,
    proposal: PendingToolProposal,
    now: () => number,
) {
    if (!authorization.ticketAuthorization) throw new ToolAuthorizationVerificationError("tool_authorization_required", "Tool authorization is required");
    const token = typeof req.body?.authorization === "string" ? req.body.authorization : "";
    const claims = await verifyToolAuthorization(token, {
        origin: authorization.origin,
        profileId: proposal.authorization?.profileId || authorization.profile.id,
        clientId,
        deviceId: authorization.ticketAuthorization.deviceId,
        subject: authorization.ticketAuthorization.subject,
        authorizationVersion: authorization.ticketAuthorization.authorizationVersion,
        operationId: proposal.operationId,
        commitment: proposal.commitment,
    }, { now: now() });
    return { jti: claims.jti, expiresAt: claims.exp * 1000 };
}

/** 使用当前操作系统的文件管理器定位本地文件。 */
function revealLocalFile(filePath: string, isDirectory: boolean) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    const args = process.platform === "darwin"
        ? ["-R", filePath]
        : process.platform === "win32"
            ? [isDirectory ? filePath : `/select,${filePath}`]
            : [isDirectory ? filePath : path.dirname(filePath)];
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
        child.once("error", reject);
    });
}

/** 结合服务配置解析当前请求 URL。 */
function requestUrl(req: Request, config: CanvasAgentConfig) {
    return new URL(req.originalUrl || req.url || "/", config.url);
}

function publicCodexConnection(config: CanvasAgentConfig) {
    const status = canvasCodexConnectionStatus(config);
    return { codexMode: status.mode, hasRelayApiKey: status.hasRelayApiKey };
}

/** 设置跨域响应头，并在首次配对时锁定网页来源。 */
function setCors(req: Request, res: Response, url: URL, config: CanvasAgentConfig) {
    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-canvas-agent-token,x-canvas-agent-ticket,x-canvas-agent-entitlement,x-canvas-profile-id,x-canvas-client-id,x-canvas-agent-protocol-version,x-canvas-agent-capabilities,x-canvas-plugin-version");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (origin) res.setHeader("Vary", "Origin");
    if (!origin || req.method === "OPTIONS" || url.pathname === "/health" || url.pathname === "/config") return true;
    if (url.pathname === "/pair" || url.pathname === "/pairing/proof") return authorizeAutomaticPairing(origin, process.env.CANVAS_AGENT_PAIR_ORIGINS || "", config.origins || []);
    config.origins ||= [];
    if (!config.origins.includes(origin)) {
        const persistedOrigins = loadConfig().origins || [];
        if (persistedOrigins.includes(origin)) config.origins = persistedOrigins;
    }
    const previousCount = config.origins.length;
    const allowed = authorizeRequestOrigin(config.origins, origin, validToken(req, config.token));
    if (config.origins.length !== previousCount) saveConfig(config);
    return allowed;
}

/** 只从请求头校验连接 token，避免凭据进入 URL 日志。 */
function validToken(req: Request, token: string) {
    const header = req.headers["x-canvas-agent-token"];
    return header === token || (Array.isArray(header) && header.includes(token));
}

/** 向 Agent 提示词追加本轮图片附件引用说明。 */
function withAttachmentContext(prompt: string, attachments: Array<{ id: string; name: string }>) {
    if (!attachments.length) return prompt;
    const list = attachments.map((item, index) => `${index + 1}. attachmentId=${item.id}, name=${JSON.stringify(item.name)}`).join("\n");
    return `${prompt}\n\n本轮可用图片附件（顺序与图片输入一致）：\n${list}\n需要把附件放入画布或作为生成参考图时，先调用 canvas_create_attachment_nodes，再使用返回的画布节点 ID 创建生成流程。`;
}
