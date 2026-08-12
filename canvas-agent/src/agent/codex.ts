import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { logger } from "../utils/logger.js";
import { redactSensitiveText } from "../utils/logger.js";
import { errorMessage, field } from "../utils/value.js";
import { CodexAppClient } from "./codex-client.js";
import { summarizeCodexThread, threadMessages } from "./codex-history.js";
import { CodexProviderPolicyError } from "./codex-provider-policy.js";
import { activeCanvasCodexRuntime } from "./codex-runtime.js";
import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "./types.js";

type CodexRunOptions = { threadId?: string; cwd?: string; profileId?: string; permissionMode?: AgentPermissionMode; appEmit?: AgentEmit; onStart?: () => void; onThread?: (threadId: string) => void; onTurn?: (turnId: string) => void; onFinish?: () => void };

let codexQueue: Promise<unknown> = Promise.resolve();
let codexLifecycle: Promise<unknown> = Promise.resolve();
let codexApp: CodexAppClient | null = null;
let codexAppFingerprint = "";
let codexTurnApp: CodexAppClient | null = null;
let codexTurnProfileId = "";
let codexProviderPolicyDenial: { fingerprint: string; message: string } | null = null;
let codexThreadId = "";
let codexWorkspacePath = "";
let codexProfileId = "";
const unmaterializedThreadIds = new Set<string>();

export { summarizeCodexThread } from "./codex-history.js";

/** 将 Codex turn 加入串行队列并等待执行完成。 */
export async function runCodexTurn(prompt: string, emit: AgentEmit, attachments: AgentAttachment[] = [], options: CodexRunOptions = {}) {
    if (!prompt.trim()) return;
    codexQueue = codexQueue.catch(() => undefined).then(() => runCodexTurnNow(prompt, emit, attachments, options));
    await codexQueue;
}

/** 中断当前线程正在执行的 Codex turn。 */
export async function interruptCodexTurn(threadId?: string, profileId?: string) {
    if (!codexApp || (threadId && threadId !== codexThreadId) || (profileId && profileId !== codexProfileId)) return false;
    return await codexApp.interruptCurrentTurn();
}

/** 回复当前 app-server 的待处理权限请求。 */
export async function resolveCodexApproval(requestId: string, decision: string) {
    return Boolean(codexApp?.resolveApproval(requestId, decision));
}

/** 在网页建立 Agent 会话前验证当前 Codex 订阅或 KapeAI 中转配置。 */
export async function verifyCodexProviderAccess(emit: AgentEmit, profileId?: string) {
    selectCodexScope(undefined, profileId);
    await getCodexApp(emit);
}

/** 停止当前 Codex app-server 并清空所有进程内线程状态。 */
export async function stopCodexApp() {
    await withCodexLifecycle(async () => {
        const app = codexApp;
        codexApp = null;
        codexAppFingerprint = "";
        clearCodexThreadState();
        clearCodexScope();
        await app?.dispose();
    });
}

/** 仅当指定 profile 正在占用 app-server 时停止它。 */
export async function stopCodexProfile(profileId: string) {
    return await withCodexLifecycle(async () => {
        if (!profileId || codexProfileId !== profileId) return false;
        const app = codexApp;
        codexApp = null;
        codexAppFingerprint = "";
        clearCodexThreadState();
        clearCodexScope();
        await app?.dispose();
        return true;
    });
}

/** 创建新的 Codex 线程并记录当前线程 ID。 */
export async function startCodexThread(emit: AgentEmit, cwd?: string, permissionMode: AgentPermissionMode = "request", profileId?: string) {
    selectCodexScope(cwd, profileId);
    const app = await getCodexApp(emit);
    const thread = await app.startThread(cwd, permissionMode, profileId);
    codexThreadId = String(field(thread, "id") || "");
    if (codexThreadId) unmaterializedThreadIds.add(codexThreadId);
    return thread;
}

/** 恢复指定 Codex 线程并返回聊天历史。 */
export async function resumeCodexThread(emit: AgentEmit, threadId: string, cwd?: string, permissionMode: AgentPermissionMode = "request", profileId?: string) {
    selectCodexScope(cwd, profileId);
    const app = await getCodexApp(emit);
    await loadCodexThread(emit, threadId, cwd, false, profileId);
    const thread = await app.resumeThread(threadId, cwd, permissionMode, profileId);
    assertThreadWorkspace(thread, cwd);
    codexThreadId = String(field(thread, "id") || threadId);
    const historyThread = await loadCodexThread(emit, codexThreadId, cwd, true, profileId);
    return { thread, messages: threadMessages(historyThread, app.planUpdates(threadId)) };
}

/** 查询当前工作空间中的 Codex 线程。 */
export async function listCodexThreads(emit: AgentEmit, options: { cwd: string; searchTerm?: string; limit?: number; profileId?: string }) {
    selectCodexScope(options.cwd, options.profileId);
    const app = await getCodexApp(emit);
    const result = await app.listThreads({
        limit: options.limit || 40,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "appServer", "exec"],
        cwd: options.cwd,
        ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
    });
    const data = Array.isArray(field(result, "data")) ? (field(result, "data") as unknown[]).map(summarizeCodexThread).filter((thread) => threadInWorkspace(thread, options.cwd)) : [];
    return { data, nextCursor: field(result, "nextCursor") || null, backwardsCursor: field(result, "backwardsCursor") || null };
}

/** 读取指定 Codex 线程及其聊天历史。 */
export async function readCodexThread(emit: AgentEmit, threadId: string, cwd?: string, profileId?: string) {
    selectCodexScope(cwd, profileId);
    const app = await getCodexApp(emit);
    let thread: unknown;
    try {
        thread = await loadCodexThread(emit, threadId, cwd, !unmaterializedThreadIds.has(threadId), profileId);
    } catch (error) {
        if (!/not materialized yet.*includeTurns/i.test(errorMessage(error))) throw error;
        unmaterializedThreadIds.add(threadId);
        thread = await loadCodexThread(emit, threadId, cwd, false, profileId);
    }
    return { thread: summarizeCodexThread(thread), messages: threadMessages(thread, app.planUpdates(threadId)) };
}

/** 确认指定 Codex 线程属于当前工作空间。 */
export async function verifyCodexThreadWorkspace(emit: AgentEmit, threadId: string, cwd: string, profileId?: string) {
    selectCodexScope(cwd, profileId);
    await loadCodexThread(emit, threadId, cwd, false, profileId);
}

/** 归档指定 Codex 线程。 */
export async function archiveCodexThread(emit: AgentEmit, threadId: string, cwd?: string, profileId?: string) {
    selectCodexScope(cwd, profileId);
    const app = await getCodexApp(emit);
    await loadCodexThread(emit, threadId, cwd, false, profileId);
    await app.archiveThread(threadId);
    app.clearPlanUpdates(threadId);
    unmaterializedThreadIds.delete(threadId);
}

/** 判断线程异常是否允许自动新建线程后重试。 */
export function isRecoverableThreadError(error: unknown) {
    return /thread not loaded|no rollout found/i.test(errorMessage(error));
}

/** 执行一次 Codex turn，并负责附件临时文件和线程恢复。 */
async function runCodexTurnNow(prompt: string, emit: AgentEmit, attachments: AgentAttachment[], options: CodexRunOptions) {
    let files: string[] = [];
    let turnApp: CodexAppClient | null = null;
    try {
        options.onStart?.();
        selectCodexScope(options.cwd, options.profileId);
        files = await writeAttachmentFiles(attachments);
        const app = await getCodexApp(options.appEmit || emit, true);
        turnApp = app;
        let threadId = await ensureCodexThread(app, options, emit);
        options.onThread?.(threadId);
        unmaterializedThreadIds.delete(threadId);
        try {
            await app.startTurn(threadId, prompt, files, options.permissionMode || "request", options.cwd, options.onTurn);
        } catch (error) {
            if (!isRecoverableThreadError(error)) throw error;
            emit("agent_log", { text: `Codex 会话不可用，正在创建新会话：${redactSensitiveText(errorMessage(error))}` });
            codexThreadId = "";
            threadId = await ensureCodexThread(app, options, emit);
            options.onThread?.(threadId);
            unmaterializedThreadIds.delete(threadId);
            await app.startTurn(threadId, prompt, files, options.permissionMode || "request", options.cwd, options.onTurn);
        }
    } catch (error) {
        logger.error("Codex turn failed", error);
        emit("agent_error", { message: redactSensitiveText(errorMessage(error)) });
    } finally {
        if (codexTurnApp === turnApp) {
            codexTurnApp = null;
            codexTurnProfileId = "";
        }
        options.onFinish?.();
        await Promise.all(files.map((file) => fs.unlink(file).catch(() => undefined)));
    }
}

/** 恢复请求线程或创建新的 Codex 线程。 */
async function ensureCodexThread(app: CodexAppClient, options: CodexRunOptions, emit: AgentEmit) {
    if (options.threadId) {
        if (options.threadId === codexThreadId) return codexThreadId;
        try {
            const result = await app.readThread(options.threadId, false);
            assertThreadWorkspace(field(result, "thread") || {}, options.cwd);
            const thread = await app.resumeThread(options.threadId, options.cwd, options.permissionMode || "request", options.profileId);
            assertThreadWorkspace(thread, options.cwd);
            codexThreadId = String(field(thread, "id") || options.threadId);
            return codexThreadId;
        } catch (error) {
            if (!isRecoverableThreadError(error)) throw error;
            emit("agent_log", { text: `Codex 会话不可用，正在创建新会话：${redactSensitiveText(errorMessage(error))}` });
        }
    }
    if (!codexThreadId) {
        const thread = await app.startThread(options.cwd, options.permissionMode || "request", options.profileId);
        codexThreadId = String(field(thread, "id") || "");
        if (codexThreadId) unmaterializedThreadIds.add(codexThreadId);
    }
    return codexThreadId;
}

/** 从 app-server 读取线程并校验工作空间。 */
async function loadCodexThread(emit: AgentEmit, threadId: string, cwd: string | undefined, includeTurns: boolean, profileId?: string) {
    selectCodexScope(cwd, profileId);
    const app = await getCodexApp(emit);
    const result = await app.readThread(threadId, includeTurns);
    const thread = field(result, "thread") || {};
    assertThreadWorkspace(thread, cwd);
    return thread;
}

/** 获取已启动的 Codex app-server 客户端。 */
async function getCodexApp(emit: AgentEmit, reserveForTurn = false) {
    return await withCodexLifecycle(async () => {
        const runtime = activeCanvasCodexRuntime();
        const fingerprint = runtime.fingerprint;
        if (codexProviderPolicyDenial?.fingerprint !== fingerprint) codexProviderPolicyDenial = null;
        if (codexProviderPolicyDenial) throw new CodexProviderPolicyError(codexProviderPolicyDenial.message);
        if (codexApp && (codexAppFingerprint === fingerprint || codexTurnApp === codexApp)) {
            if (codexTurnApp === codexApp && codexTurnProfileId && codexProfileId !== codexTurnProfileId) throw new Error("Codex 正在另一个 profile 中运行");
            codexApp.setEmitter(emit);
            if (reserveForTurn) {
                codexTurnApp = codexApp;
                codexTurnProfileId = codexProfileId;
            }
            return codexApp;
        }

        const previous = codexApp;
        codexApp = null;
        codexAppFingerprint = "";
        clearCodexThreadState();
        await previous?.dispose();

        let app: CodexAppClient;
        try {
            app = await CodexAppClient.start(emit, (exited) => {
                if (codexApp !== exited) return;
                codexApp = null;
                codexAppFingerprint = "";
                clearCodexThreadState();
            }, runtime.env);
        } catch (error) {
            if (error instanceof CodexProviderPolicyError) codexProviderPolicyDenial = { fingerprint, message: error.message };
            throw error;
        }
        codexProviderPolicyDenial = null;
        codexApp = app;
        codexAppFingerprint = fingerprint;
        if (reserveForTurn) {
            codexTurnApp = app;
            codexTurnProfileId = codexProfileId;
        }
        return app;
    });
}

function withCodexLifecycle<T>(operation: () => Promise<T>) {
    const result = codexLifecycle.catch(() => undefined).then(operation);
    codexLifecycle = result.then(() => undefined, () => undefined);
    return result;
}

function clearCodexThreadState() {
    codexTurnApp = null;
    codexTurnProfileId = "";
    codexThreadId = "";
    unmaterializedThreadIds.clear();
}

function clearCodexScope() {
    codexWorkspacePath = "";
    codexProfileId = "";
}

/** 切换 profile/workspace 时丢弃进程内的默认线程指针，避免复用另一个 profile 的线程。 */
function selectCodexScope(cwd: string | undefined, profileId: string | undefined) {
    const workspacePath = cwd ? path.resolve(cwd) : "";
    const nextProfileId = profileId || "";
    if (codexTurnApp && codexTurnProfileId && nextProfileId !== codexTurnProfileId) throw new Error("Codex 正在另一个 profile 中运行");
    if (codexWorkspacePath !== workspacePath || codexProfileId !== nextProfileId) {
        codexThreadId = "";
        unmaterializedThreadIds.clear();
    }
    codexWorkspacePath = workspacePath;
    codexProfileId = nextProfileId;
}

/** 校验线程是否属于指定工作空间。 */
function assertThreadWorkspace(thread: unknown, cwd?: string) {
    if (!cwd || threadInWorkspace(thread, cwd)) return;
    throw new Error("该 Codex 会话不属于当前画布工作空间");
}

/** 判断线程工作目录是否与当前工作空间一致。 */
function threadInWorkspace(thread: unknown, cwd: string) {
    const threadCwd = String(field(thread, "cwd") || "");
    return Boolean(threadCwd && path.resolve(threadCwd) === path.resolve(cwd));
}

/** 将图片附件写入临时文件供 Codex 读取。 */
async function writeAttachmentFiles(attachments: AgentAttachment[]) {
    return await Promise.all(attachments.filter((item) => item.dataUrl?.startsWith("data:image/")).map(writeAttachmentFile));
}

/** 将单个 Data URL 图片附件写入临时文件。 */
async function writeAttachmentFile(item: AgentAttachment) {
    const [, meta = "", data = ""] = item.dataUrl?.match(/^data:([^;]+);base64,(.+)$/) || [];
    if (!data) throw new Error(`图片附件无效：${item.name || "未命名图片"}`);
    const file = path.join(os.tmpdir(), `sneeai-agent-${Date.now()}-${Math.random().toString(16).slice(2)}.${imageExt(meta || item.type)}`);
    await fs.writeFile(file, Buffer.from(data, "base64"));
    return file;
}

/** 根据图片 MIME 类型返回临时文件扩展名。 */
function imageExt(type = "") {
    if (type.includes("png")) return "png";
    if (type.includes("webp")) return "webp";
    return "jpg";
}
