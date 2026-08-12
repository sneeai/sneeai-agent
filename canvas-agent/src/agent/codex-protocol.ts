import type { JsonRecord } from "../utils/value.js";

export type CodexThread = JsonRecord & { id: string; cwd: string; turns?: CodexTurn[] };
export type CodexTurn = JsonRecord & { id: string; error?: CodexTurnError | null; durationMs?: number | null };
export type CodexTurnError = JsonRecord & { message: string };
export type CodexItem = JsonRecord & { id: string; type: string; text?: string };
export type CodexPlanStep = { step: string; status: "pending" | "inProgress" | "completed" };
export type CodexPlanUpdate = { threadId: string; turnId: string; explanation?: string | null; plan: CodexPlanStep[]; turnStatus?: string };

export type CodexTurnInput =
    | { type: "text"; text: string; text_elements: [] }
    | { type: "localImage"; path: string };

type ThreadOptions = {
    approvalPolicy: "never" | "on-request";
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    config: JsonRecord;
    cwd?: string;
    model?: string;
    ephemeral?: boolean;
};

type CodexRequestSpec = {
    initialize: {
        params: {
            clientInfo: { name: string; title: string; version: string };
            capabilities: { experimentalApi: boolean; requestAttestation: boolean };
        };
        result: JsonRecord;
    };
    "account/read": {
        params: { refreshToken?: boolean };
        result: { account: { type?: string } | null; requiresOpenaiAuth: boolean };
    };
    "config/read": {
        params: { includeLayers?: boolean; cwd?: string | null };
        result: { config: JsonRecord; origins: JsonRecord; layers?: unknown[] | null };
    };
    "thread/start": {
        params: ThreadOptions & { threadSource: "user" };
        result: { thread: CodexThread };
    };
    "thread/resume": {
        params: ThreadOptions & { threadId: string };
        result: { thread: CodexThread };
    };
    "thread/list": {
        params: {
            limit: number;
            sortKey: "updated_at";
            sortDirection: "desc";
            sourceKinds: Array<"cli" | "vscode" | "appServer" | "exec">;
            cwd: string;
            searchTerm?: string;
        };
        result: { data: CodexThread[]; nextCursor: string | null; backwardsCursor: string | null };
    };
    "thread/read": {
        params: { threadId: string; includeTurns: boolean };
        result: { thread: CodexThread };
    };
    "thread/archive": {
        params: { threadId: string };
        result: Record<string, never>;
    };
    "turn/start": {
        params: { threadId: string; input: CodexTurnInput[]; model?: string; approvalPolicy: "never" | "on-request"; sandboxPolicy: { type: "readOnly"; networkAccess: boolean } | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean } | { type: "dangerFullAccess" } };
        result: { turn: CodexTurn };
    };
    "turn/interrupt": {
        params: { threadId: string; turnId: string };
        result: Record<string, never>;
    };
};

export type CodexRequestMethod = keyof CodexRequestSpec;
export type CodexRequestParams<Method extends CodexRequestMethod> = CodexRequestSpec[Method]["params"];
export type CodexRequestResult<Method extends CodexRequestMethod> = CodexRequestSpec[Method]["result"];

type TokenUsageBreakdown = {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
};

type CodexNotificationSpec = {
    "thread/started": { thread: CodexThread };
    "turn/started": { threadId?: string; turn: CodexTurn };
    "turn/completed": { threadId?: string; turn: CodexTurn };
    "turn/plan/updated": { threadId?: string; turnId: string; explanation?: string | null; plan: CodexPlanStep[] };
    "item/started": { threadId: string; turnId: string; item: CodexItem };
    "item/completed": { threadId: string; turnId: string; item: CodexItem };
    "item/agentMessage/delta": { threadId: string; turnId: string; itemId: string; delta: string };
    "item/plan/delta": { threadId: string; turnId: string; itemId: string; delta: string };
    "item/reasoning/summaryTextDelta": { threadId: string; turnId: string; itemId: string; delta: string; summaryIndex: number };
    "item/commandExecution/outputDelta": { threadId: string; turnId: string; itemId: string; delta: string };
    "thread/tokenUsage/updated": { threadId: string; turnId: string; tokenUsage: { last: TokenUsageBreakdown } };
    error: { threadId: string; turnId: string; error: CodexTurnError; willRetry: boolean };
};

export type CodexNotificationMethod = keyof CodexNotificationSpec;
export type CodexNotificationParams<Method extends CodexNotificationMethod> = CodexNotificationSpec[Method];
