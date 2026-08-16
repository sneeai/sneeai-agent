import fs from "node:fs";
import path from "node:path";
import {inspect} from "node:util";

import winston, {format, transports, type Logger as WinstonLogger} from "winston";

import {CONFIG_DIR} from "../config.js";
import {formatDateForFilename} from "./date.js";

/** 单个日志文件上限 10MB，最多保留 5 个轮转文件。 */
const FILE_MAXSIZE_BYTES = 10 * 1024 * 1024;
const FILE_MAX_FILES = 5;
/** 单条日志文本最长保留长度，超长截断。 */
const MAX_LOG_TEXT_LENGTH = 4_000;

/** 管理 Sneeai Agent 的终端与文件 Debug 日志。 */
export class Logger {
    readonly enabled = process.argv.includes("--debug");
    readonly filePath = this.enabled ? path.join(CONFIG_DIR, "logs", `canvas-agent-${formatDateForFilename()}.log`) : "";
    private readonly logger: WinstonLogger | null;

    /** 根据命令行 Debug 参数初始化日志输出。 */
    constructor() {
        if (!this.enabled) {
            this.logger = null;
            return;
        }
        fs.mkdirSync(path.dirname(this.filePath), {recursive: true});
        const line = format.printf(({level, message, timestamp, details}) => `${timestamp} ${level.toUpperCase()} ${message}${formatDetails(details)}`);
        const mcpMode = process.argv.slice(2).filter((arg) => arg !== "--debug")[0] === "mcp";
        this.logger = winston.createLogger({
            level: "debug",
            transports: [
                new transports.Console({
                    format: format.combine(format.timestamp({format: "HH:mm:ss"}), line),
                    ...(mcpMode ? {stderrLevels: ["debug", "info", "warn", "error"]} : {}),
                }),
                new transports.File({
                    filename: this.filePath,
                    maxsize: FILE_MAXSIZE_BYTES,
                    maxFiles: FILE_MAX_FILES,
                    options: {mode: 0o600},
                    format: format.combine(format.timestamp({format: "HH:mm:ss"}), line),
                }),
            ],
        });
    }

    /** 输出 Debug 级别日志。 */
    debug(message: string, details?: unknown) {
        const safeMessage = sanitizeMessage(message);
        if (details === undefined) this.logger?.debug(safeMessage);
        else this.logger?.debug(safeMessage, {details: sanitize(details)});
    }

    /** 输出 Info 级别日志。 */
    info(message: string, details?: unknown) {
        const safeMessage = sanitizeMessage(message);
        if (details === undefined) this.logger?.info(safeMessage);
        else this.logger?.info(safeMessage, {details: sanitize(details)});
    }

    /** 输出 Warn 级别日志。 */
    warn(message: string, details?: unknown) {
        const safeMessage = sanitizeMessage(message);
        if (details === undefined) this.logger?.warn(safeMessage);
        else this.logger?.warn(safeMessage, {details: sanitize(details)});
    }

    /** 输出 Error 级别日志。 */
    error(message: string, details?: unknown) {
        const safeMessage = sanitizeMessage(message);
        if (details === undefined) this.logger?.error(safeMessage);
        else this.logger?.error(safeMessage, {details: sanitize(details)});
    }
}

/** 将日志详情格式化为紧凑的单行文本。 */
function formatDetails(details: unknown) {
    if (details === undefined) return "";
    if (!details || typeof details !== "object" || Array.isArray(details)) return ` ${inspect(details, {depth: null, breakLength: Infinity})}`;
    const text = Object.entries(details).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${inspect(value, {depth: null, breakLength: Infinity})}`).join(" ");
    return text ? ` ${text}` : "";
}

/** 单条日志 message 的脱敏 + 截断。 */
function sanitizeMessage(message: string) {
    return truncateText(redactSensitiveText(message));
}

/** 超长文本截断，保留长度信息。 */
function truncateText(value: string) {
    if (value.length <= MAX_LOG_TEXT_LENGTH) return value;
    return `${value.slice(0, MAX_LOG_TEXT_LENGTH)}…[truncated ${value.length - MAX_LOG_TEXT_LENGTH} chars]`;
}

/** 清理日志内容中的敏感数据和不可序列化引用。 */
function sanitize(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
    if (/token|authorization|api.?key|dataurl/i.test(key)) return "[REDACTED]";
    if (typeof value === "string") {
        if (value.startsWith("data:")) return `[DATA URL ${value.length} chars]`;
        return truncateText(redactSensitiveText(value));
    }
    if (value instanceof Error) return {name: value.name, message: truncateText(redactSensitiveText(value.message)), stack: value.stack ? truncateText(redactSensitiveText(value.stack)) : undefined};
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => sanitize(item, key, seen));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([field, item]) => [field, sanitize(item, field, seen)]));
}

export const logger = new Logger();

/** Redact credential-shaped values before diagnostics can leave the local process. */
export function redactSensitiveText(value: string) {
    return value
        .replace(/\b((?:https?|socks(?:4a?|5h?)):\/\/)[^\s/?#]*@/gi, "$1[REDACTED]@")
        .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
        .replace(/([?&](?:api[_-]?key|token|secret|password|authorization)=)[^&#\s]+/gi, "$1[REDACTED]")
        .replace(/(\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*)(["']?)[^\s,;"'}]+/gi, "$1$2[REDACTED]")
        .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
        .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]");
}
