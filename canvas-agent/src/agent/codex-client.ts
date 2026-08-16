import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, STABLE_USER_HOME, VERSION } from "../config.js";
import { createAgentTicket, INTERNAL_MCP_TICKET_TTL_MS } from "../pairing-ticket.js";
import { logger } from "../utils/logger.js";
import { redactSensitiveText } from "../utils/logger.js";
import { field, type JsonRecord } from "../utils/value.js";
import type { CodexNotificationParams, CodexPlanUpdate, CodexRequestMethod, CodexRequestParams, CodexRequestResult, CodexTurnInput } from "./codex-protocol.js";
import { enforceCodexProviderPolicy } from "./codex-provider-policy.js";
import { CANVAS_AGENT_INTERNAL_TICKET_ENV, canvasCodexAppServerArgs, NESTED_CANVAS_MCP_ENV } from "./codex-runtime.js";
import type { AgentEmit, AgentPermissionMode } from "./types.js";

type AgentEvent = JsonRecord & { type: string; usage?: unknown };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type ItemDeltaParams = { threadId: string; turnId: string; itemId: string; delta: string };
type PendingDelta = { delta: string; itemType: string; params: ItemDeltaParams; timer: ReturnType<typeof setTimeout> };

const canvasAgentMcp = canvasAgentMcpCommand();
const require = createRequire(import.meta.url);
const STREAM_UPDATE_INTERVAL_MS = 40;
const STOP_TIMEOUT_MS = 1_500;
const KILL_TIMEOUT_MS = 1_000;
const MCP_STARTUP_TIMEOUT_SEC = 60;
/** 单个 turn 的总运行时限；超时后主动中断并拒绝等待方。 */
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** 环境变量可覆盖 turn 总超时（毫秒）。 */
function defaultTurnTimeoutMs() {
    const value = Number(process.env.CANVAS_AGENT_TURN_TIMEOUT_MS || "");
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TURN_TIMEOUT_MS;
}

/** 明确指示 Codex turn 运行超过总时限、已由 Agent 中断的错误。 */
export class TurnTimeoutError extends Error {
    readonly code = "codex_turn_timeout";

    constructor(readonly turnId: string, readonly timeoutMs: number) {
        super(`Codex turn 运行超过 ${Math.round(timeoutMs / 1000)} 秒，已自动中断`);
        this.name = "TurnTimeoutError";
    }
}

/** 封装 Codex app-server 的 JSON-RPC 通信与事件转换。 */
export class CodexAppClient {
    private nextId = 1;
    private buffer = "";
    private currentThreadId = "";
    private currentTurnId = "";
    private textByItem = new Map<string, string>();
    private lastUsage: unknown = null;
    private pending = new Map<number, PendingRequest>();
    private activeTurns = new Map<string, PendingRequest>();
    private activeTurnTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private completedTurns = new Map<string, Error | null>();
    private pendingDeltas = new Map<string, PendingDelta>();
    private plansByTurn = new Map<string, CodexPlanUpdate>();
    private approvalRequests = new Map<string, { id: number; method: string; params: JsonRecord }>();
    private stopping = false;
    private stopPromise: Promise<void> | null = null;

    /** 保存 app-server 子进程和事件出口。 */
    private constructor(private child: ChildProcess, private emit: AgentEmit) {}

    /** app-server 空闲复用到另一个 profile 时更新通知出口。 */
    setEmitter(emit: AgentEmit) {
        this.emit = emit;
    }

    /** 启动并初始化 Codex app-server。 */
    static async start(emit: AgentEmit, onExit: (client: CodexAppClient) => void, runtimeEnv: NodeJS.ProcessEnv = process.env) {
        const codex = codexCommand();
        logger.info("Starting Codex app-server", { executable: codex.command });
        const child = spawn(codex.command, [...codex.args, ...canvasCodexAppServerArgs()], {
            env: { ...runtimeEnv, HOME: STABLE_USER_HOME, ...(process.platform === "win32" ? { USERPROFILE: STABLE_USER_HOME } : {}), [NESTED_CANVAS_MCP_ENV]: "1" },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        const client = new CodexAppClient(child, emit);
        child.stdout?.on("data", (chunk) => client.read(chunk.toString()));
        child.stderr?.on("data", (chunk) => {
            if (client.stopping) return;
            logger.warn("Codex app-server stderr", { text: redactSensitiveText(chunk.toString()) });
        });
        child.on("error", (error) => {
            if (client.stopping) return;
            logger.error("Codex app-server process error", error);
            client.failAll("Codex app-server process failed");
            emit("agent_error", { message: "Codex app-server 进程异常" });
        });
        child.on("exit", (code, signal) => {
            if (client.stopping) {
                logger.info("Codex app-server stopped", { code, signal });
            } else {
                logger.warn("Codex app-server exited", { code, signal });
                client.failAll(`Codex app-server exited: ${code ?? 0}`);
                emit("agent_log", { text: `Codex app-server exited: ${code ?? 0}` });
            }
            onExit(client);
        });
        try {
            await client.request("initialize", { clientInfo: { name: "canvas-agent", title: "Sneeai Agent", version: VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
            client.notify("initialized");
            const [account, effectiveConfig] = await Promise.all([
                client.request("account/read", { refreshToken: false }),
                client.request("config/read", { includeLayers: false }),
            ]);
            enforceCodexProviderPolicy({ account: account.account, config: effectiveConfig.config, env: runtimeEnv });
            return client;
        } catch (error) {
            await client.stop();
            throw error;
        }
    }

    /** 幂等停止 app-server，超时后升级为 SIGKILL。 */
    stop(timeoutMs = STOP_TIMEOUT_MS) {
        this.stopPromise ||= this.stopNow(timeoutMs);
        return this.stopPromise;
    }

    /** stop 的资源释放别名。 */
    dispose(timeoutMs = STOP_TIMEOUT_MS) {
        return this.stop(timeoutMs);
    }

    /** 创建新的 Codex 线程。 */
    async startThread(cwd?: string, permissionMode: AgentPermissionMode = "request", profileId?: string) {
        const { thread } = await this.request("thread/start", { ...threadSettings(permissionMode, profileId), ...(cwd ? { cwd } : {}), threadSource: "user" });
        if (!thread.id) throw new Error("Codex app-server 没有返回 thread id");
        return thread;
    }

    /** 恢复已有 Codex 线程。 */
    async resumeThread(threadId: string, cwd?: string, permissionMode: AgentPermissionMode = "request", profileId?: string) {
        const { thread } = await this.request("thread/resume", { threadId, ...threadSettings(permissionMode, profileId), ...(cwd ? { cwd } : {}) });
        if (!thread.id) throw new Error("Codex app-server 没有返回 thread id");
        return thread;
    }

    /** 查询 Codex 线程列表。 */
    listThreads(params: CodexRequestParams<"thread/list">) {
        return this.request("thread/list", params);
    }

    /** 读取指定 Codex 线程。 */
    readThread(threadId: string, includeTurns = true) {
        return this.request("thread/read", { threadId, includeTurns });
    }

    /** 归档指定 Codex 线程。 */
    archiveThread(threadId: string) {
        return this.request("thread/archive", { threadId });
    }

    /** 返回指定线程在当前进程中收到的最新任务计划。 */
    planUpdates(threadId: string) {
        return [...this.plansByTurn.values()].filter((item) => item.threadId === threadId);
    }

    /** 清理已归档线程的任务计划缓存。 */
    clearPlanUpdates(threadId: string) {
        this.plansByTurn.forEach((item, turnId) => {
            if (item.threadId === threadId) this.plansByTurn.delete(turnId);
        });
    }

    /** 启动一个 Codex turn 并等待完成通知；超过 turnTimeoutMs 后中断并抛 TurnTimeoutError。 */
    async startTurn(threadId: string, prompt: string, images: string[], permissionMode: AgentPermissionMode, cwd?: string, onTurn?: (turnId: string) => void, turnTimeoutMs = defaultTurnTimeoutMs()) {
        this.currentThreadId = threadId;
        const { turn } = await this.request("turn/start", { threadId, input: codexInput(prompt, images), ...turnSettings(permissionMode, cwd) });
        const turnId = turn.id;
        if (!turnId) throw new Error("Codex app-server 没有返回 turn id");
        this.currentTurnId = turnId;
        onTurn?.(turnId);
        const completed = this.completedTurns.get(turnId);
        if (this.completedTurns.has(turnId)) {
            this.completedTurns.delete(turnId);
            this.currentThreadId = "";
            this.currentTurnId = "";
            if (completed) throw completed;
            return;
        }
        await new Promise<unknown>((resolve, reject) => {
            this.activeTurns.set(turnId, { resolve, reject });
            const timer = setTimeout(() => this.expireTurn(threadId, turnId, turnTimeoutMs), turnTimeoutMs);
            timer.unref?.();
            this.activeTurnTimers.set(turnId, timer);
        });
    }

    /** 中断当前正在运行的 Codex turn。 */
    async interruptCurrentTurn() {
        const threadId = this.currentThreadId;
        const turnId = this.currentTurnId;
        if (!threadId || !turnId) return false;
        try {
            logger.warn("Interrupting active Codex turn", { threadId, turnId });
            await this.request("turn/interrupt", { threadId, turnId });
            return true;
        } catch (error) {
            logger.warn("Failed to interrupt Codex turn", { error, threadId, turnId });
            return false;
        }
    }

    /** turn 总超时处理：请求中断、清理 pending 与当前线程状态，并以明确错误结束等待。 */
    private expireTurn(threadId: string, turnId: string, timeoutMs: number) {
        const pending = this.activeTurns.get(turnId);
        if (!pending) return; // 已在超时前正常完成
        this.activeTurns.delete(turnId);
        this.clearTurnTimer(turnId);
        logger.error("Codex turn exceeded total timeout, interrupting", { threadId, turnId, timeoutMs });
        void this.interruptTurn(threadId, turnId).catch(() => undefined);
        if (turnId === this.currentTurnId) {
            this.currentThreadId = "";
            this.currentTurnId = "";
        }
        pending.reject(new TurnTimeoutError(turnId, timeoutMs));
    }

    /** 中断指定 turn，不依赖 currentThreadId/currentTurnId，供超时清理使用。 */
    private async interruptTurn(threadId: string, turnId: string) {
        try {
            await this.request("turn/interrupt", { threadId, turnId });
        } catch (error) {
            logger.warn("Failed to interrupt timed-out Codex turn", { error, threadId, turnId });
        }
    }

    private clearTurnTimer(turnId: string) {
        const timer = this.activeTurnTimers.get(turnId);
        if (timer) {
            clearTimeout(timer);
            this.activeTurnTimers.delete(turnId);
        }
    }

    /** 回复网页端已经确认的 Codex 权限请求。 */
    resolveApproval(requestId: string, decision: string) {
        const request = this.approvalRequests.get(requestId);
        if (!request) return false;
        this.approvalRequests.delete(requestId);
        const permissions = field(request.params, "permissions") || field(request.params, "requestedPermissions");
        const result = request.method === "item/permissions/requestApproval"
            ? { permissions: decision === "decline" ? {} : permissions || {}, scope: decision === "acceptForSession" ? "session" : "turn" }
            : { decision };
        this.write({ id: request.id, result });
        return true;
    }

    /** 发送 JSON-RPC 请求并保存待处理 Promise。 */
    private request<Method extends CodexRequestMethod>(method: Method, params: CodexRequestParams<Method>) {
        if (this.stopping) return Promise.reject(new Error("Codex app-server is stopping")) as Promise<CodexRequestResult<Method>>;
        const id = this.nextId++;
        this.write({ id, method, params });
        return new Promise<CodexRequestResult<Method>>((resolve, reject) => this.pending.set(id, { resolve: (result) => resolve(result as CodexRequestResult<Method>), reject }));
    }

    /** 发送无需响应的 JSON-RPC 通知。 */
    private notify(method: string, params?: unknown) {
        this.write(params === undefined ? { method } : { method, params });
    }

    /** 将 JSON-RPC 消息写入 app-server 标准输入。 */
    private write(value: unknown) {
        const method = String(field(value, "method") || "");
        const params = field(value, "params");
        if (method) logger.debug(`Codex ${method}`, { id: field(value, "id"), threadId: field(params, "threadId") });
        this.child.stdin?.write(`${JSON.stringify(value)}\n`);
    }

    /** 按行解析 app-server 标准输出。 */
    private read(chunk: string) {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() || "";
        lines.filter(Boolean).forEach((line) => {
            try {
                this.handle(JSON.parse(line) as JsonRecord);
            } catch (error) {
                logger.warn("Invalid Codex app-server output", { error, line: redactSensitiveText(line) });
                this.emit("agent_log", { text: "Codex 返回了无法解析的诊断信息" });
            }
        });
    }

    /** 分派单条 JSON-RPC 响应、请求或通知。 */
    private handle(message: JsonRecord) {
        const id = Number(message.id);
        if (message.error && this.pending.has(id)) {
            const error = String(field(message.error, "message") || "Codex request failed");
            if (/not materialized yet.*includeTurns/i.test(error)) logger.debug("Codex thread has no messages yet", { id });
            else logger.warn("Codex request failed", { id, error });
            return this.reject(id, error);
        }
        if (this.pending.has(id)) return this.resolve(id, message.result);
        if (typeof message.method === "string" && "id" in message) return this.answerServerRequest(message);
        if (typeof message.method === "string") this.handleNotification(message.method, (message.params || {}) as JsonRecord);
    }

    /** 转换并广播 app-server 通知。 */
    private handleNotification(method: string, params: JsonRecord) {
        if (method === "serverRequest/resolved") {
            const requestId = String(field(params, "requestId") || "");
            if (requestId) this.approvalRequests.delete(requestId);
            this.emit("codex_approval_resolved", { requestId, ...params });
            return;
        }
        if (!field(params, "threadId") && this.currentThreadId && (method === "turn/started" || method === "turn/completed" || method === "turn/plan/updated")) params = { ...params, threadId: this.currentThreadId };
        if (method === "item/agentMessage/delta") {
            const value = params as unknown as CodexNotificationParams<"item/agentMessage/delta">;
            this.textByItem.set(value.itemId, `${this.textByItem.get(value.itemId) || ""}${value.delta}`);
            return this.emitDelta("agent_message", value);
        }
        if (method === "item/plan/delta") return this.emitDelta("plan", params as unknown as CodexNotificationParams<"item/plan/delta">);
        if (method === "item/reasoning/summaryTextDelta") return this.emitDelta("reasoning", params as unknown as CodexNotificationParams<"item/reasoning/summaryTextDelta">);
        if (method === "item/commandExecution/outputDelta") return this.emitDelta("command_execution", params as unknown as CodexNotificationParams<"item/commandExecution/outputDelta">);
        if (method === "turn/plan/updated") {
            const value = params as unknown as CodexNotificationParams<"turn/plan/updated">;
            const update: CodexPlanUpdate = { ...value, threadId: value.threadId || "" };
            if (update.threadId && update.turnId) this.plansByTurn.set(update.turnId, update);
            params = update as unknown as JsonRecord;
        }
        if (method === "thread/tokenUsage/updated") {
            this.lastUsage = normalizeUsage(params as unknown as CodexNotificationParams<"thread/tokenUsage/updated">);
            this.emit("agent_event", { agent: "codex", type: "usage.updated", usage: this.lastUsage, ...codexEventScope(params) });
            return;
        }
        const event = normalizeCodexNotification(method, params);
        if (!event) return;
        if (event.type === "item.completed") {
            const item = field(event, "item") as JsonRecord | undefined;
            const id = String(field(item, "id") || "");
            this.flushDelta(id);
            const streamedText = this.textByItem.get(id);
            if (item?.type === "agent_message" && streamedText && !item.text) item.text = streamedText;
            if (id) this.textByItem.delete(id);
        }
        if (event.type === "turn.completed") {
            const turn = field(params, "turn");
            const turnId = String(field(turn, "id") || field(params, "turnId") || "");
            const plan = this.plansByTurn.get(turnId);
            if (plan) this.plansByTurn.set(turnId, { ...plan, turnStatus: String(field(turn, "status") || "completed") });
        }
        if (event.type === "turn.completed") event.usage = this.lastUsage;
        this.emit("agent_event", { agent: "codex", ...event });
        if (event.type === "turn.completed") {
            const turn = (params as unknown as CodexNotificationParams<"turn/completed">).turn;
            const turnId = turn.id;
            const pending = this.activeTurns.get(turnId);
            const error = turn.error;
            if (pending) {
                this.activeTurns.delete(turnId);
                this.clearTurnTimer(turnId);
                error ? pending.reject(new Error(error.message || "Codex turn failed")) : pending.resolve(event);
            } else if (turnId) {
                this.completedTurns.set(turnId, error ? new Error(error.message || "Codex turn failed") : null);
            }
            if (turnId === this.currentTurnId) {
                this.currentThreadId = "";
                this.currentTurnId = "";
            }
            this.emit("agent_done", { agent: "codex", usage: event.usage, ...codexEventScope(params) });
        }
    }

    /** 合并并广播 Agent 文本或执行输出增量。 */
    private emitDelta(itemType: string, params: ItemDeltaParams) {
        const id = params.itemId;
        const pending = this.pendingDeltas.get(id);
        if (pending) {
            pending.delta += params.delta;
            pending.itemType = itemType;
            pending.params = params;
            return;
        }
        this.pendingDeltas.set(id, {
            delta: params.delta,
            itemType,
            params,
            timer: setTimeout(() => this.flushDelta(id), STREAM_UPDATE_INTERVAL_MS),
        });
    }

    /** 合并短时间内的文本增量，减少 SSE 传输和前端渲染次数。 */
    private flushDelta(id: string) {
        const pending = this.pendingDeltas.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingDeltas.delete(id);
        if (pending.delta) this.emit("agent_event", { agent: "codex", type: "item.updated", item: { id, type: pending.itemType, delta: pending.delta }, ...codexEventScope(pending.params as unknown as JsonRecord) });
    }

    /** 自动回复 app-server 发起的授权或交互请求。 */
    private answerServerRequest(message: JsonRecord) {
        const method = String(message.method);
        const params = (field(message, "params") as JsonRecord) || {};
        if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(method)) {
            const requestId = String(message.id);
            this.approvalRequests.set(requestId, { id: Number(message.id), method, params });
            this.emit("codex_approval", { requestId, method, ...params });
            return;
        }
        const result = method === "mcpServer/elicitation/request" ? { action: "accept", content: {}, _meta: null } : { decision: "decline" };
        this.write({ id: message.id, result });
        this.emit("agent_event", { agent: "codex", type: "server.request", method, params, result });
    }

    /** 完成指定 JSON-RPC 请求。 */
    private resolve(id: number, result: unknown) {
        const pending = this.pending.get(id);
        if (pending) (this.pending.delete(id), pending.resolve(result));
    }

    /** 拒绝指定 JSON-RPC 请求。 */
    private reject(id: number, message: string) {
        const pending = this.pending.get(id);
        if (pending) (this.pending.delete(id), pending.reject(new Error(message)));
    }

    /** 拒绝进程退出时仍未完成的请求与 turn。 */
    private failAll(message: string) {
        [...this.pending.values(), ...this.activeTurns.values()].forEach((item) => item.reject(new Error(message)));
        this.pendingDeltas.forEach((item) => clearTimeout(item.timer));
        this.activeTurnTimers.forEach((timer) => clearTimeout(timer));
        this.pending.clear();
        this.activeTurns.clear();
        this.activeTurnTimers.clear();
        this.pendingDeltas.clear();
        this.textByItem.clear();
        this.approvalRequests.clear();
        this.currentThreadId = "";
        this.currentTurnId = "";
    }

    private async stopNow(timeoutMs: number) {
        this.stopping = true;
        this.failAll("Codex app-server stopped");
        if (this.child.exitCode !== null || this.child.signalCode !== null) return;
        const exited = waitForChildExit(this.child, Math.max(0, timeoutMs));
        this.child.stdin?.end();
        this.child.kill("SIGTERM");
        if (await exited) return;
        this.child.kill("SIGKILL");
        await waitForChildExit(this.child, KILL_TIMEOUT_MS);
    }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
        const onExit = () => {
            clearTimeout(timer);
            resolve(true);
        };
        const timer = setTimeout(() => {
            child.off("exit", onExit);
            resolve(false);
        }, timeoutMs);
        child.once("exit", onExit);
    });
}

/** 生成 Codex 调用 Sneeai Agent MCP 的启动命令。 */
function canvasAgentMcpCommand() {
    if (isStandaloneExecutable()) return { command: process.execPath, args: ["mcp"] };
    const current = process.argv.find((arg) => /index\.(t|j)s$/.test(arg)) || "";
    const entry = path.resolve(current || fileURLToPath(new URL("../index.js", import.meta.url)));
    const tsx = path.join(path.dirname(entry), "..", "node_modules", "tsx", "dist", "cli.mjs");
    return entry.endsWith(".ts") ? { command: process.execPath, args: [tsx, entry, "mcp"] } : { command: process.execPath, args: [entry, "mcp"] };
}

/** 生成 Codex app-server 使用的 MCP 配置。 */
export function codexConfig(permissionMode: AgentPermissionMode, profileId?: string) {
    const internalTicket = profileId ? createAgentTicket(loadConfig(true).token, {
        kind: "internal-mcp",
        origin: "local-internal",
        profileKey: profileId,
        clientId: "nested-mcp",
        ttlMs: INTERNAL_MCP_TICKET_TTL_MS,
    }) : "";
    const nestedEnvironment = {
        [NESTED_CANVAS_MCP_ENV]: "1",
        CANVAS_AGENT_HOME: STABLE_USER_HOME,
        ...(process.env.NODE_ENV === "test" && process.env.SNEEAI_AGENT_DISABLE_SECURE_CREDENTIALS === "1"
            ? { NODE_ENV: "test", SNEEAI_AGENT_DISABLE_SECURE_CREDENTIALS: "1" }
            : {}),
        ...(process.env.PORT ? { PORT: process.env.PORT } : {}),
        ...(internalTicket ? { [CANVAS_AGENT_INTERNAL_TICKET_ENV]: internalTicket } : {}),
    };
    return { model_reasoning_summary: "auto", ...(permissionMode === "automatic" ? { approvals_reviewer: "auto_review" } : {}), mcp_servers: { "sneeai-agent": { command: canvasAgentMcp.command, args: canvasAgentMcp.args, env: nestedEnvironment, default_tools_approval_mode: "approve", startup_timeout_sec: MCP_STARTUP_TIMEOUT_SEC, tool_timeout_sec: 90, required: true } } };
}

function threadSettings(permissionMode: AgentPermissionMode, profileId?: string) {
    return { approvalPolicy: permissionMode === "full" ? "never" as const : "on-request" as const, sandbox: permissionMode === "full" ? "danger-full-access" as const : "workspace-write" as const, config: codexConfig(permissionMode, profileId) };
}

export function turnSettings(permissionMode: AgentPermissionMode, cwd?: string) {
    return {
        approvalPolicy: permissionMode === "full" ? "never" as const : "on-request" as const,
        sandboxPolicy: permissionMode === "full"
            ? { type: "dangerFullAccess" as const }
            : { type: "workspaceWrite" as const, writableRoots: cwd ? [path.resolve(cwd)] : [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    };
}

/** 将文本和本地图片转换为 Codex turn 输入。 */
function codexInput(prompt: string, images: string[]): CodexTurnInput[] {
    return [{ type: "text", text: prompt, text_elements: [] }, ...images.map<CodexTurnInput>((file) => ({ type: "localImage", path: file }))];
}

/** 将 app-server 通知转换为前端使用的 Agent 事件。 */
function normalizeCodexNotification(method: string, params: JsonRecord): AgentEvent | null {
    const scope = codexEventScope(params);
    if (method === "thread/started") return { type: "thread.started", ...scope };
    if (method === "turn/started") return { type: "turn.started", ...scope };
    if (method === "turn/completed") return { type: "turn.completed", status: field(field(params, "turn"), "status"), error: field(field(params, "turn"), "error"), usage: null, duration_ms: field(field(params, "turn"), "durationMs"), ...scope };
    if (method === "turn/plan/updated") return { type: "plan.updated", explanation: field(params, "explanation"), plan: field(params, "plan"), ...scope };
    if (method === "item/started") return { type: "item.started", item: normalizeItem(field(params, "item")), ...scope };
    if (method === "item/completed") return { type: "item.completed", item: normalizeItem(field(params, "item")), ...scope };
    if (method === "error") return { type: "error", message: field(field(params, "error"), "message"), ...scope };
    return null;
}

/** 提取 Codex 事件所属的线程和 turn。 */
function codexEventScope(params: JsonRecord) {
    const threadId = String(field(params, "threadId") || field(field(params, "thread"), "id") || "");
    const turnId = String(field(params, "turnId") || field(field(params, "turn"), "id") || "");
    return { ...(threadId ? { thread_id: threadId } : {}), ...(turnId ? { turn_id: turnId } : {}) };
}

/** 统一 app-server item 的类型和参数格式。 */
function normalizeItem(item: unknown) {
    const value = item && typeof item === "object" ? { ...(item as JsonRecord) } : {};
    if (value.type === "agentMessage") value.type = "agent_message";
    if (value.type === "mcpToolCall") value.type = "mcp_tool_call";
    if (value.type === "commandExecution") value.type = "command_execution";
    if (value.type === "fileChange") value.type = "file_change";
    if (value.type === "dynamicToolCall") value.type = "dynamic_tool_call";
    if (value.type === "collabToolCall") value.type = "collab_tool_call";
    if (value.type === "webSearch") value.type = "web_search";
    if (value.type === "imageView") value.type = "image_view";
    if (value.type === "imageGeneration") value.type = "image_generation";
    if (value.type === "contextCompaction") value.type = "context_compaction";
    if (value.type === "agent_message" && typeof value.id === "string") value.text = String(value.text || "");
    if ("arguments" in value) value.arguments = parseMaybeJson(value.arguments);
    return value;
}

/** 将 Codex token usage 转换为前端字段。 */
function normalizeUsage(params: CodexNotificationParams<"thread/tokenUsage/updated">) {
    const last = params.tokenUsage.last;
    return {
        input_tokens: last.inputTokens,
        cached_input_tokens: last.cachedInputTokens,
        output_tokens: last.outputTokens,
        reasoning_output_tokens: last.reasoningOutputTokens,
    };
}

/** 尝试将字符串解析为 JSON，失败时保留原值。 */
function parseMaybeJson(value: unknown) {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

/** Release bundles place the target-platform Codex binary beside the Agent executable. */
function codexCommand() {
    if (isStandaloneExecutable()) {
        const executable = path.join(path.dirname(process.execPath), "codex-runtime", "bin", process.platform === "win32" ? "codex.exe" : "codex");
        if (!fs.existsSync(executable)) throw new Error(`Sneeai Agent 缺少 Codex 运行组件：${executable}`);
        return { command: executable, args: [] as string[] };
    }
    return { command: process.execPath, args: [path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js")] };
}

function isStandaloneExecutable() {
    return !process.argv.some((arg) => /index\.(t|j)s$/.test(arg));
}
