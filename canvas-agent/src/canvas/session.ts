import crypto from "node:crypto";
import type { ServerResponse } from "node:http";

import type { AgentAttachment } from "../agent/types.js";
import { ToolAuthorizationReplayGuard } from "../tool-authorization.js";
import { logger } from "../utils/logger.js";
import { buildCanvasToolRequest, fitAttachmentNodeSize } from "./operations.js";
import type { ToolName } from "./schemas.js";
import { compactCanvasState, compactNode, isToolName, nextCanvasX, parseToolInput } from "./tools.js";
import type { CanvasSnapshot } from "./types.js";

type ToolOperationState = "proposed" | "authorized" | "dispatched";
type ClientConnection = { response: ServerResponse; connectionId: string; authorization?: CanvasClientAuthorization };
type PendingRequest = {
    operationId: string;
    clientId: string;
    connectionId: string;
    state: ToolOperationState;
    originalName: ToolName;
    originalInput: Record<string, unknown>;
    dispatchName: ToolName;
    dispatchInput: Record<string, unknown>;
    authorization?: CanvasClientAuthorization;
    authorizationJti?: string;
    commitment?: string;
    timer?: ReturnType<typeof setTimeout>;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
};
type TurnAttachment = { clientId: string; id: string; name: string; type: string; size: number; width: number; height: number; dataUrl: string };
type PendingCodexApproval = { profileKey: string; clientId: string; threadId: string; turnId: string; claimed: boolean };
type ToolCallOptions = { routing?: "bound" | "active"; operationId?: string };
type CachedToolOperation = { fingerprint: string; promise: Promise<unknown>; expiresAt: number; settled: boolean };
export type CodexState = { busy: boolean; threadId: string; turnId: string };
export type CodexControlScope = { profileKey: string; clientId: string; threadId?: string; turnId?: string };
export type CanvasClientAuthorization = {
    origin: string;
    profileId: string;
    profileKey: string;
    clientId: string;
    subject: string;
    deviceId: string;
    authorizationVersion: number;
    expiresAt: number;
};
export type PendingToolProposal = {
    protocol: "tool.authorization.v1";
    operationId: string;
    operationClass: "agent_write";
    commitment: string;
    name: ToolName;
    input: Record<string, unknown>;
    dispatchName?: ToolName;
    dispatchInput?: Record<string, unknown>;
    authorization?: CanvasClientAuthorization;
};
export type VerifiedToolAuthorization = { jti: string; expiresAt: number };

const DIRECT_SITE_TOOLS = new Set<ToolName>([
    "site_navigate",
    "canvas_list_projects",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_list",
    "assets_add",
    "generation_get_status",
]);
export const READ_ONLY_TOOL_NAMES = Object.freeze([
    "site_navigate",
    "canvas_list_projects",
    "canvas_get_state",
    "canvas_get_selection",
    "canvas_export_snapshot",
    "canvas_select_nodes",
    "canvas_set_viewport",
    "generation_get_status",
    "workbench_image_get_config",
    "workbench_video_get_config",
    "prompts_search",
    "assets_list",
]) as readonly ToolName[];
const READ_ONLY_TOOLS = new Set<ToolName>(READ_ONLY_TOOL_NAMES);
const TOOL_REQUEST_TIMEOUT_MS = 30_000;
const TOOL_OPERATION_CACHE_TTL_MS = 10 * 60_000;
const MAX_TOOL_OPERATION_CACHE = 256;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CanvasToolDecisionError extends Error {
    constructor(readonly code: string, message: string, readonly statusCode = 409) {
        super(message);
        this.name = "CanvasToolDecisionError";
    }
}

export class CanvasCodexControlError extends Error {
    constructor(readonly code: string, message: string, readonly statusCode = 403) {
        super(message);
        this.name = "CanvasCodexControlError";
    }
}

export class CanvasSessionRoutingError extends Error {
    readonly statusCode = 409;

    constructor(readonly code: "canvas_not_connected" | "canvas_binding_ambiguous" | "canvas_binding_expired", message: string) {
        super(message);
        this.name = "CanvasSessionRoutingError";
    }
}

/** 管理网页画布连接、状态、附件和工具请求。 */
export class CanvasSession {
    private clients = new Map<string, ClientConnection>();
    private eventStreams = new Map<ServerResponse, ReturnType<typeof setInterval>>();
    private clientFocusOrder = new Map<string, number>();
    private pending = new Map<string, PendingRequest>();
    private canvasStates = new Map<string, CanvasSnapshot>();
    private turnAttachments = new Map<string, TurnAttachment>();
    private codexApprovals = new Map<string, PendingCodexApproval>();
    private toolOperations = new Map<string, CachedToolOperation>();
    private activeClientId = "";
    private boundClientId = "";
    private focusSequence = 0;
    private codexState: CodexState = { busy: false, threadId: "", turnId: "" };
    private codexOperations = 0;
    private disposed = false;
    private readonly replayGuard: ToolAuthorizationReplayGuard;

    constructor(private readonly options: { profileKey?: string; now?: () => number; requestTimeoutMs?: number; replayGuard?: ToolAuthorizationReplayGuard } = {}) {
        this.replayGuard = options.replayGuard || new ToolAuthorizationReplayGuard();
    }

    /** 获取当前目标网页的画布状态。 */
    private get canvasState() {
        return this.canvasStates.get(this.targetClientId) || null;
    }

    /** 获取当前 turn 绑定或最近激活的网页客户端。 */
    private get targetClientId() {
        return this.boundClientId || this.activeClientId;
    }

    /** 返回 Sneeai Agent 当前连接状态。 */
    health() {
        return { ok: true, hasCanvas: Boolean(this.canvasState), clients: this.clients.size, codexBusy: this.codexState.busy };
    }

    /** 仅供 registry 校验本机 MCP 目标，不暴露给远程请求。 */
    hasConnectedClient(clientId: string) {
        return this.clients.has(clientId);
    }

    /** 返回当前真实建立 SSE 的网页客户端。 */
    connectedClientIds() {
        return [...this.clients.keys()];
    }

    /** 返回 session 内当前活动画布，用于 registry 路由验证。 */
    activeCanvasClientId() {
        return this.activeClientId;
    }

    /** 返回 Codex 是否正在执行任务。 */
    get codexBusy() {
        return this.codexState.busy;
    }

    /** 交接只允许在 turn 和线程管理 RPC 都空闲时发生。 */
    get runtimeBusy() {
        return this.codexState.busy || this.codexOperations > 0 || this.pending.size > 0;
    }

    /** 标记一个可能启动或调用 app-server 的 HTTP 请求，并返回幂等释放函数。 */
    beginCodexOperation() {
        this.codexOperations += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.codexOperations = Math.max(0, this.codexOperations - 1);
        };
    }

    /** 更新并广播 Codex 运行状态。 */
    setCodexState(patch: Partial<CodexState>) {
        const next = { ...this.codexState, ...patch };
        if (next.busy === this.codexState.busy && next.threadId === this.codexState.threadId && next.turnId === this.codexState.turnId) return;
        this.codexState = next;
        if (!next.busy) this.codexApprovals.clear();
        logger.debug("Codex state changed", this.codexState);
        this.emitAll("codex_state", this.codexState);
    }

    /** Claim one pending Codex approval only for its exact profile, client, thread, and turn. */
    claimCodexApproval(requestId: string, scope: CodexControlScope) {
        const approval = this.codexApprovals.get(requestId);
        if (!approval || approval.claimed) return null;
        if (!this.matchesCodexScope(approval, scope)) {
            throw new CanvasCodexControlError("codex_control_scope_mismatch", "Codex 审批不属于当前网页任务");
        }
        approval.claimed = true;
        return { threadId: approval.threadId, turnId: approval.turnId };
    }

    /** Complete a claim, or release it when the downstream resolver failed before consuming it. */
    finishCodexApproval(requestId: string, consumed: boolean) {
        const approval = this.codexApprovals.get(requestId);
        if (!approval) return;
        if (consumed) this.codexApprovals.delete(requestId);
        else approval.claimed = false;
    }

    /** Resolve the exact active turn that an authorized client is allowed to interrupt. */
    authorizeCodexInterrupt(scope: CodexControlScope) {
        const active = {
            profileKey: this.options.profileKey || "legacy",
            clientId: this.boundClientId,
            threadId: this.codexState.threadId,
            turnId: this.codexState.turnId,
        };
        if (!this.matchesCodexScope(active, scope)) {
            throw new CanvasCodexControlError("codex_control_scope_mismatch", "Codex 任务不属于当前网页");
        }
        return { threadId: active.threadId, turnId: active.turnId };
    }

    /** 建立网页与 Sneeai Agent 之间的 SSE 连接。 */
    openEvents(url: URL, res: ServerResponse, authenticatedClientId = "", authorization?: CanvasClientAuthorization) {
        if (this.disposed) {
            res.writeHead(503);
            res.end();
            return;
        }
        const clientId = authenticatedClientId || url.searchParams.get("clientId") || crypto.randomUUID();
        const statusOnly = url.searchParams.get("role") === "status";
        logger.info("SSE client connected", { clientId, statusOnly });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        if (!statusOnly) {
            const previous = this.clients.get(clientId);
            if (previous && previous.response !== res) this.rejectClientPending(clientId, previous.connectionId, "请求页面已重新连接");
            this.clients.set(clientId, { response: res, connectionId: crypto.randomUUID(), ...(authorization ? { authorization: { ...authorization, clientId } } : {}) });
            if (!this.clientFocusOrder.has(clientId)) this.clientFocusOrder.set(clientId, 0);
            if (!this.activeClientId) {
                this.activeClientId = clientId;
                this.clientFocusOrder.set(clientId, ++this.focusSequence);
            }
        }
        sendEvent(res, "hello", { ok: true, clientId, codex: this.codexState });
        const timer = setInterval(() => sendEvent(res, "ping", { time: Date.now() }), 15000);
        this.eventStreams.set(res, timer);
        res.on("close", () => {
            clearInterval(timer);
            this.eventStreams.delete(res);
            logger.info("SSE client disconnected", { clientId, statusOnly });
            const connection = this.clients.get(clientId);
            if (statusOnly || connection?.response !== res) return;
            this.clients.delete(clientId);
            this.clientFocusOrder.delete(clientId);
            this.canvasStates.delete(clientId);
            if (this.boundClientId === clientId) {
                this.boundClientId = "";
                this.clearCodexApprovalsForClient(clientId);
            }
            this.rejectClientPending(clientId, connection.connectionId, "请求页面已断开");
            if (this.activeClientId === clientId) this.activeClientId = [...this.clients.keys()].sort((a, b) => (this.clientFocusOrder.get(b) || 0) - (this.clientFocusOrder.get(a) || 0))[0] || "";
        });
    }

    /** 关闭全部 SSE，并拒绝交接时仍待处理的画布请求。 */
    dispose(reason = "Sneeai Agent bridge is restarting") {
        if (this.disposed) return;
        this.disposed = true;
        this.pending.forEach((item) => {
            if (item.timer) clearTimeout(item.timer);
            item.reject(new Error(reason));
        });
        this.pending.clear();
        this.eventStreams.forEach((timer, response) => {
            clearInterval(timer);
            if (!response.writableEnded) response.end();
        });
        this.eventStreams.clear();
        this.clients.clear();
        this.clientFocusOrder.clear();
        this.canvasStates.clear();
        this.turnAttachments.clear();
        this.codexApprovals.clear();
        this.toolOperations.clear();
        this.codexOperations = 0;
        this.activeClientId = "";
        this.boundClientId = "";
    }

    /** 保存指定网页上报的最新画布快照。 */
    updateState(body: unknown, clientId?: string) {
        const targetClientId = clientId || this.activeClientId;
        if (!targetClientId) return;
        const state = { ...((body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>), clientId: targetClientId } as CanvasSnapshot;
        this.canvasStates.set(targetClientId, state);
        logger.debug("Canvas state updated", { clientId: targetClientId, nodes: state.nodes?.length || 0, connections: state.connections?.length || 0 });
    }

    /** 将指定网页设为最近激活的工具目标。 */
    activateClient(clientId: string) {
        if (!this.clients.has(clientId)) throw new Error("当前网页未连接");
        this.activeClientId = clientId;
        this.clientFocusOrder.set(clientId, ++this.focusSequence);
        logger.debug("Canvas client activated", { clientId });
    }

    /** 将当前 Agent turn 固定绑定到指定网页。 */
    bindClient(clientId: string) {
        if (!this.clients.has(clientId)) throw new Error("当前网页未连接");
        this.boundClientId = clientId;
        logger.debug("Canvas client bound to turn", { clientId });
    }

    /** 解除当前 Agent turn 的网页绑定。 */
    releaseClient(clientId: string) {
        if (this.boundClientId === clientId) {
            this.boundClientId = "";
            this.clearCodexApprovalsForClient(clientId);
        }
        logger.debug("Canvas client released from turn", { clientId });
    }

    /** 保存当前 turn 可用的图片附件并返回安全引用。 */
    setTurnAttachments(clientId: string, attachments: AgentAttachment[]) {
        this.turnAttachments.clear();
        return attachments.flatMap((item, index) => {
            if (!item.dataUrl?.startsWith("data:image/")) return [];
            const id = item.id?.trim() || `attachment-${crypto.randomUUID()}`;
            const attachment: TurnAttachment = {
                clientId,
                id,
                name: item.name?.trim() || `图片 ${index + 1}`,
                type: item.type?.startsWith("image/") ? item.type : item.dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png",
                size: positiveNumber(item.size, 0),
                width: positiveNumber(item.width, 1024),
                height: positiveNumber(item.height, 1024),
                dataUrl: item.dataUrl,
            };
            this.turnAttachments.set(id, attachment);
            return [{ id, name: attachment.name, type: attachment.type, size: attachment.size, width: attachment.width, height: attachment.height }];
        });
    }

    /** 清理指定网页或全部 turn 附件。 */
    clearTurnAttachments(clientId?: string) {
        this.turnAttachments.forEach((item, id) => {
            if (!clientId || item.clientId === clientId) this.turnAttachments.delete(id);
        });
    }

    /** 获取属于指定网页 turn 的图片附件。 */
    getTurnAttachment(clientId: string, attachmentId: string) {
        const attachment = this.turnAttachments.get(attachmentId);
        if (!attachment) throw new Error(`找不到本轮图片附件：${attachmentId}`);
        if (attachment.clientId !== clientId) throw new Error("图片附件不属于当前 turn 的发起标签页");
        return attachment;
    }

    /** 接收网页返回的工具调用结果。 */
    resolveResult(clientId: string, body: { requestId?: string; error?: string; result?: unknown }) {
        const item = body.requestId ? this.pending.get(body.requestId) : null;
        if (!item || !body.requestId || item.clientId !== clientId || item.state !== "dispatched") return false;
        this.pending.delete(body.requestId);
        if (item.timer) clearTimeout(item.timer);
        logger.debug("Canvas tool result received", { clientId, requestId: body.requestId, error: body.error, result: body.result });
        body.error ? item.reject(new Error(body.error)) : item.resolve(body.result);
        return true;
    }

    /** 向全部已连接网页广播事件。 */
    emitAll(type: string, payload: unknown) {
        this.clients.forEach((client) => sendEvent(client.response, type, payload));
    }

    /** 向全部网页广播带线程归属的事件。 */
    emitThread(type: string, threadId: string, payload: Record<string, unknown> = {}) {
        const event = { ...payload, threadId };
        this.trackCodexApproval(type, event);
        this.emitAll(type, event);
    }

    /** 校验工具参数并将调用分派到当前目标网页。 */
    callTool(name: unknown, rawInput: unknown, options: ToolCallOptions = {}) {
        if (!isToolName(name)) throw new Error(`未知工具：${String(name)}`);
        const input = parseToolInput(name, rawInput) as Record<string, unknown>;
        const operationId = options.operationId?.trim() || "";
        if (!operationId) return this.executeTool(name, input, options);
        if (!OPERATION_ID_PATTERN.test(operationId)) throw new CanvasToolDecisionError("operation_id_invalid", "operationId 格式无效", 400);

        this.pruneToolOperations();
        const fingerprint = toolOperationFingerprint(name, input);
        const existing = this.toolOperations.get(operationId);
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new CanvasToolDecisionError("operation_id_conflict", "operationId 已用于其他工具调用");
            return existing.promise;
        }
        if (this.toolOperations.size >= MAX_TOOL_OPERATION_CACHE) {
            throw new CanvasToolDecisionError("operation_cache_full", "当前画布操作过多，请稍后重试", 429);
        }

        const operation: CachedToolOperation = {
            fingerprint,
            promise: Promise.resolve(),
            expiresAt: this.now() + TOOL_OPERATION_CACHE_TTL_MS,
            settled: false,
        };
        operation.promise = this.executeTool(name, input, options);
        this.toolOperations.set(operationId, operation);
        void operation.promise.then(
            () => {
                operation.settled = true;
                this.pruneToolOperations();
            },
            (error) => {
                operation.settled = true;
                // A disconnected or ambiguous canvas is a readiness failure,
                // not an executed operation. Let the same caller retry after
                // the browser reconnects instead of replaying stale failure.
                if (error instanceof CanvasSessionRoutingError) this.toolOperations.delete(operationId);
                this.pruneToolOperations();
            },
        );
        return operation.promise;
    }

    private async executeTool(name: ToolName, input: Record<string, unknown>, options: ToolCallOptions) {
        const clientId = options.routing === "active" ? this.activeClientId : this.targetClientId;
        const canvasState = this.canvasStates.get(clientId) || null;
        logger.info("MCP tool called", { name, input, targetClientId: clientId, operationId: options.operationId });
        if (DIRECT_SITE_TOOLS.has(name)) {
            if (!clientId || !this.clients.has(clientId)) throw new CanvasSessionRoutingError("canvas_not_connected", "当前没有已连接网页");
            return await this.requestCanvasTool(name, input, name, input, clientId, options.operationId);
        }
        const snapshotReadTool = name === "canvas_get_state" || name === "canvas_get_selection" || name === "canvas_export_snapshot";
        if (snapshotReadTool && (!clientId || !this.clients.has(clientId) || !canvasState)) throw new CanvasSessionRoutingError("canvas_not_connected", "当前没有已连接画布");
        if (name === "canvas_get_state" || name === "canvas_export_snapshot") return compactCanvasState(canvasState);
        if (name === "canvas_get_selection") {
            const ids = new Set(canvasState?.selectedNodeIds || []);
            return { nodes: (canvasState?.nodes || []).filter((node) => ids.has(node.id)).map(compactNode) };
        }
        if (name === "canvas_create_attachment_nodes") return await this.createAttachmentNodes(input as { attachmentIds: string[]; x?: number; y?: number; gap?: number; direction?: "row" | "column" }, clientId, canvasState, options.operationId);
        if (!clientId || !this.clients.has(clientId)) throw new CanvasSessionRoutingError("canvas_not_connected", "当前没有已连接画布");
        const request = buildCanvasToolRequest(name, input, canvasState);
        return await this.requestCanvasTool(name, input, request.name, request.input, clientId, options.operationId);
    }

    /** 消费网页对单个写工具 proposal 的决定。 */
    async decideTool(
        clientId: string,
        decision: { operationId: string; decision: "approve" | "reject"; error?: string },
        verify: (proposal: PendingToolProposal) => Promise<VerifiedToolAuthorization>,
    ) {
        const item = this.pending.get(decision.operationId);
        if (!item || item.clientId !== clientId || item.state !== "proposed") return false;
        const connection = this.clients.get(clientId);
        if (!connection || connection.connectionId !== item.connectionId) {
            this.failPending(item, new Error("请求页面已断开"));
            return false;
        }
        if (decision.decision === "reject") {
            this.failPending(item, new Error(decision.error?.trim() || "网页拒绝了画布操作"));
            return true;
        }

        let permit: VerifiedToolAuthorization;
        try {
            permit = await verify({
                protocol: "tool.authorization.v1",
                operationId: item.operationId,
                operationClass: "agent_write",
                commitment: item.commitment || "",
                name: item.originalName,
                input: item.originalInput,
                authorization: item.authorization ? { ...item.authorization } : undefined,
            });
        } catch (error) {
            if (this.pending.get(item.operationId) === item && item.state === "proposed") {
                this.failPending(item, error instanceof Error ? error : new Error("工具许可验证失败"));
            }
            throw error;
        }

        if (this.pending.get(item.operationId) !== item || item.state !== "proposed") return false;
        if (!permit.jti || !Number.isFinite(permit.expiresAt) || permit.expiresAt <= this.now()) {
            const error = new CanvasToolDecisionError("tool_authorization_invalid", "Tool authorization is invalid", 403);
            this.failPending(item, error);
            throw error;
        }
        if (!this.replayGuard.consume(permit.jti, permit.expiresAt, this.now())) {
            const error = new CanvasToolDecisionError("tool_authorization_replayed", "Tool authorization has already been used");
            this.failPending(item, error);
            throw error;
        }

        item.state = "authorized";
        item.authorizationJti = permit.jti;
        return this.dispatchPending(item);
    }

    /** 将当前 turn 的附件转换为画布图片节点。 */
    private async createAttachmentNodes(input: { attachmentIds: string[]; x?: number; y?: number; gap?: number; direction?: "row" | "column" }, clientId: string, canvasState: CanvasSnapshot | null, operationId?: string) {
        if (!this.clients.has(clientId)) throw new CanvasSessionRoutingError("canvas_not_connected", "当前没有已连接画布");
        const attachments = input.attachmentIds.map((id) => this.getTurnAttachment(clientId, id));
        const x = Number(input.x ?? nextCanvasX(canvasState));
        const y = Number(input.y ?? 0);
        const gap = Number(input.gap ?? 40);
        const direction = input.direction || "row";
        let offset = 0;
        const nodes = attachments.map((attachment) => {
            const size = fitAttachmentNodeSize(attachment.width, attachment.height);
            const node = {
                id: `image-${crypto.randomUUID()}`,
                attachmentId: attachment.id,
                title: attachment.name,
                position: { x: direction === "row" ? x + offset : x, y: direction === "column" ? y + offset : y },
                width: size.width,
                height: size.height,
            };
            offset += (direction === "row" ? size.width : size.height) + gap;
            return node;
        });
        await this.requestCanvasTool("canvas_create_attachment_nodes", input, "canvas_create_attachment_nodes", { nodes }, clientId, operationId);
        return { nodes: nodes.map(({ id, attachmentId, title }) => ({ id, attachmentId, title })) };
    }

    /** 为工具请求创建 pending 状态；只读立即分派，写操作先发送 proposal。 */
    private requestCanvasTool(originalName: ToolName, originalInput: Record<string, unknown>, dispatchName: ToolName, dispatchInput: Record<string, unknown>, clientId: string, callerOperationId?: string) {
        const operationId = callerOperationId || crypto.randomUUID();
        const connection = this.clients.get(clientId);
        if (!connection) throw new CanvasSessionRoutingError("canvas_not_connected", "当前没有已连接画布");
        const readOnly = READ_ONLY_TOOLS.has(originalName);
        return new Promise<unknown>((resolve, reject) => {
            const commitment = readOnly ? "" : crypto.randomBytes(32).toString("base64url");
            const item: PendingRequest = {
                operationId,
                clientId,
                connectionId: connection.connectionId,
                state: readOnly ? "dispatched" : "proposed",
                originalName,
                originalInput,
                dispatchName,
                dispatchInput,
                authorization: connection.authorization ? { ...connection.authorization } : undefined,
                resolve,
                reject,
                ...(commitment ? { commitment } : {}),
            };
            item.timer = this.pendingTimer(item);
            this.pending.set(operationId, item);
            if (readOnly) {
                sendEvent(connection.response, "tool_call", { requestId: operationId, name: dispatchName, input: dispatchInput });
                logger.debug("Canvas read-only tool request sent", { requestId: operationId, name: dispatchName, clientId });
                return;
            }
            sendEvent(connection.response, "tool_proposal", {
                protocol: "tool.authorization.v1",
                operationId,
                operationClass: "agent_write",
                commitment,
                name: originalName,
                input: originalInput,
                dispatchName,
                dispatchInput,
                ...(connection.authorization ? { authorization: { ...connection.authorization } } : {}),
            });
            logger.debug("Canvas tool proposal sent", { operationId, name: originalName, clientId });
        });
    }

    private dispatchPending(item: PendingRequest) {
        const connection = this.clients.get(item.clientId);
        if (!connection || connection.connectionId !== item.connectionId || item.state !== "authorized") {
            this.failPending(item, new Error("请求页面已断开"));
            return false;
        }
        item.state = "dispatched";
        if (item.timer) clearTimeout(item.timer);
        item.timer = this.pendingTimer(item);
        sendEvent(connection.response, "tool_call", {
            requestId: item.operationId,
            name: item.dispatchName,
            input: item.dispatchInput,
            ...(item.authorizationJti ? { authorizationJti: item.authorizationJti } : {}),
        });
        logger.debug("Authorized Canvas tool request sent", { requestId: item.operationId, name: item.dispatchName, clientId: item.clientId, authorizationJti: item.authorizationJti });
        return true;
    }

    private pendingTimer(item: PendingRequest) {
        return setTimeout(() => {
            if (this.pending.get(item.operationId) !== item) return;
            this.pending.delete(item.operationId);
            const proposed = item.state === "proposed";
            logger.warn("Canvas tool request timed out", { requestId: item.operationId, name: item.originalName, clientId: item.clientId, state: item.state });
            item.reject(new Error(proposed ? "画布操作许可超时" : "画布操作超时"));
        }, this.options.requestTimeoutMs ?? TOOL_REQUEST_TIMEOUT_MS);
    }

    private failPending(item: PendingRequest, error: Error) {
        if (this.pending.get(item.operationId) !== item) return;
        this.pending.delete(item.operationId);
        if (item.timer) clearTimeout(item.timer);
        item.reject(error);
    }

    private rejectClientPending(clientId: string, connectionId: string, reason: string) {
        this.pending.forEach((item) => {
            if (item.clientId === clientId && item.connectionId === connectionId) this.failPending(item, new Error(reason));
        });
    }

    private trackCodexApproval(type: string, payload: Record<string, unknown>) {
        const requestId = String(payload.requestId || "");
        if (type === "codex_approval_resolved") {
            if (requestId) this.codexApprovals.delete(requestId);
            return;
        }
        if (type !== "codex_approval" || !requestId) return;
        const approval = {
            profileKey: this.options.profileKey || "legacy",
            clientId: this.boundClientId,
            threadId: String(payload.threadId || this.codexState.threadId || ""),
            turnId: String(payload.turnId || payload.turn_id || this.codexState.turnId || ""),
            claimed: false,
        };
        if (!this.matchesCodexScope(approval, approval)) {
            logger.warn("Ignored unbound Codex approval", { requestId, clientId: approval.clientId, threadId: approval.threadId, turnId: approval.turnId });
            return;
        }
        this.codexApprovals.set(requestId, approval);
    }

    private matchesCodexScope(expected: { profileKey: string; clientId: string; threadId: string; turnId: string }, actual: CodexControlScope) {
        return Boolean(
            this.codexState.busy
            && expected.profileKey
            && expected.profileKey === (this.options.profileKey || "legacy")
            && actual.profileKey === expected.profileKey
            && expected.clientId
            && this.boundClientId === expected.clientId
            && actual.clientId === expected.clientId
            && expected.threadId
            && this.codexState.threadId === expected.threadId
            && (!actual.threadId || actual.threadId === expected.threadId)
            && expected.turnId
            && this.codexState.turnId === expected.turnId
            && (!actual.turnId || actual.turnId === expected.turnId)
        );
    }

    private clearCodexApprovalsForClient(clientId: string) {
        this.codexApprovals.forEach((approval, requestId) => {
            if (approval.clientId === clientId) this.codexApprovals.delete(requestId);
        });
    }

    private pruneToolOperations() {
        const now = this.now();
        this.toolOperations.forEach((operation, operationId) => {
            if (operation.settled && operation.expiresAt <= now) this.toolOperations.delete(operationId);
        });
    }

    private now() {
        return (this.options.now || Date.now)();
    }
}

function toolOperationFingerprint(name: ToolName, input: Record<string, unknown>) {
    return crypto.createHash("sha256").update(`${name}\0${stableJson(input)}`).digest("base64url");
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

/** 向 SSE 连接写入一个事件。 */
function sendEvent(res: ServerResponse, type: string, payload: unknown) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
/** 将未知数值转换为正数，否则使用默认值。 */
function positiveNumber(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}
