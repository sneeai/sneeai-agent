import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 17371;
export const AGENT_SERVICE = "sneeai-agent";
export const STABLE_USER_HOME = path.resolve(process.env.CANVAS_AGENT_HOME?.trim() || os.userInfo().homedir);
export const CONFIG_DIR = path.join(STABLE_USER_HOME, ".sneeai-agent");
export const CONFIG_FILE = path.join(CONFIG_DIR, "sneeai-agent.json");
export const VERSION = readPackageVersion();
export const BUILD_ID = readBuildId();
export const RELEASE_ID = `${VERSION}+${BUILD_ID}`;
export const AGENT_PROMPT = readBundledText("../agent-instructions.md", process.env.SNEEAI_AGENT_INSTRUCTIONS, "");
const DEVICE_ID_PATTERN = /^d1:[A-Za-z0-9_-]{43}$/;
const initializedWorkspaces = new Set<string>();
const CONFIG_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;

export type SiteWorkspaceConfig = { workspacePath: string; activeThreadId?: string; pinnedThreadIds?: string[] };
export type CanvasCodexMode = "inherit" | "isolated";
export type CanvasAgentProfileConfig = { workspace?: SiteWorkspaceConfig };
export type CanvasAgentConfig = {
    url: string;
    token: string;
    deviceId?: string;
    origins?: string[];
    workspace?: SiteWorkspaceConfig;
    profiles?: Record<string, CanvasAgentProfileConfig>;
    codex?: { mode?: CanvasCodexMode };
};

/** 读取本地 Sneeai Agent 配置，不存在时生成默认配置。 */
export function loadConfig(create = false): CanvasAgentConfig {
    try {
        const config = readConfig();
        const needsUrlMigration = config.url === "local";
        if (needsUrlMigration) config.url = effectiveCanvasAgentUrl(config.url);
        const needsDeviceId = !config.deviceId;
        if (needsDeviceId) config.deviceId = legacyDeviceId(config.token);
        if (create) {
            secureConfigPaths();
            if (needsUrlMigration || needsDeviceId) saveConfig(config);
        }
        return config;
    } catch (error) {
        if (!isFileMissing(error)) throw error;
        const config = defaultConfig();
        return create ? createConfig(config) : config;
    }
}

/** 将 Sneeai Agent 配置写入用户配置目录。 */
export function saveConfig(config: CanvasAgentConfig) {
    ensureConfigDir();
    const temporaryFile = configTemporaryFile();
    try {
        writeConfigFile(temporaryFile, config);
        fs.renameSync(temporaryFile, CONFIG_FILE);
        if (process.platform !== "win32") fs.chmodSync(CONFIG_FILE, CONFIG_MODE);
    } finally {
        fs.rmSync(temporaryFile, { force: true });
    }
}

/** 通过排他创建保证多个 Agent/MCP 进程共享同一份首次配置。 */
function createConfig(config: CanvasAgentConfig) {
    ensureConfigDir();
    const temporaryFile = configTemporaryFile();
    try {
        writeConfigFile(temporaryFile, config);
        try {
            fs.linkSync(temporaryFile, CONFIG_FILE);
            return config;
        } catch (error) {
            if (!isFileExists(error)) throw error;
            return readConfigWithRetry();
        }
    } finally {
        fs.rmSync(temporaryFile, { force: true });
    }
}

function readConfig() {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch (error) {
        if (isFileMissing(error)) throw error;
        throw new Error(`Sneeai Agent 配置文件无效，请检查或删除 ${CONFIG_FILE}`, { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as CanvasAgentConfig).url !== "string" || typeof (parsed as CanvasAgentConfig).token !== "string" || !(parsed as CanvasAgentConfig).token) {
        throw new Error(`Sneeai Agent 配置文件无效，请检查或删除 ${CONFIG_FILE}`);
    }
    const config = parsed as CanvasAgentConfig;
    if (config.url !== "local") parseLoopbackAgentUrl(config.url);
    if (config.deviceId !== undefined && !DEVICE_ID_PATTERN.test(config.deviceId)) throw new Error(`Sneeai Agent 配置文件无效，请检查或删除 ${CONFIG_FILE}`);
    return config;
}

function readConfigWithRetry() {
    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            return readConfig();
        } catch (error) {
            lastError = error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
    }
    throw lastError;
}

function writeConfigFile(file: string, config: CanvasAgentConfig) {
    const descriptor = fs.openSync(file, "wx", CONFIG_MODE);
    try {
        fs.writeFileSync(descriptor, JSON.stringify(config, null, 2));
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function defaultConfig(): CanvasAgentConfig {
    return {
        url: effectiveCanvasAgentUrl("local"),
        token: crypto.randomBytes(18).toString("hex"),
        deviceId: `d1:${crypto.randomBytes(32).toString("base64url")}`,
    };
}

/** 将已验证的本机地址统一为 MCP/HTTP 桥接实际使用的 IPv4 回环地址。 */
export function effectiveCanvasAgentUrl(value: string) {
    const configuredPort = validAgentPort(process.env.PORT);
    if (value === "local") return `http://127.0.0.1:${configuredPort || DEFAULT_PORT}`;
    const parsed = parseLoopbackAgentUrl(value);
    return `http://127.0.0.1:${configuredPort || validAgentPort(parsed.port) || DEFAULT_PORT}`;
}

function parseLoopbackAgentUrl(value: string) {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch (error) {
        throw invalidConfigError(error);
    }
    if (parsed.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
        parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash ||
        parsed.port && !validAgentPort(parsed.port)) {
        throw invalidConfigError();
    }
    return parsed;
}

function validAgentPort(value: string | undefined) {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 0;
}

function invalidConfigError(cause?: unknown) {
    return new Error(`Sneeai Agent 配置文件无效，请检查或删除 ${CONFIG_FILE}`, cause === undefined ? undefined : { cause });
}

/** 返回稳定的本机设备 ID；旧配置按现有随机 token 确定性回填。 */
export function canvasAgentDeviceId(config: CanvasAgentConfig) {
    config.deviceId ||= legacyDeviceId(config.token);
    return config.deviceId;
}

function legacyDeviceId(token: string) {
    return `d1:${crypto.createHmac("sha256", token).update("sneeai-agent-device-id-v1").digest("base64url")}`;
}

function ensureConfigDir() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: CONFIG_DIR_MODE });
    if (process.platform !== "win32") fs.chmodSync(CONFIG_DIR, CONFIG_DIR_MODE);
}

function secureConfigPaths() {
    ensureConfigDir();
    if (process.platform !== "win32") fs.chmodSync(CONFIG_FILE, CONFIG_MODE);
}

function configTemporaryFile() {
    return path.join(CONFIG_DIR, `.canvas-agent.${process.pid}.${crypto.randomUUID()}.tmp`);
}

function isFileMissing(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isFileExists(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** 确保站点级 Codex 工作空间存在并已初始化。 */
export function ensureSiteWorkspace(config: CanvasAgentConfig) {
    const current = config.workspace;
    if (current?.workspacePath) {
        const workspacePath = resolveWorkspacePath(current.workspacePath);
        initializeWorkspace(workspacePath);
        return { ...current, workspacePath };
    }
    const workspacePath = path.join(CONFIG_DIR, "codex-workspaces", "site");
    config.workspace = { workspacePath };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return { workspacePath };
}

/** 更新站点级 Codex 工作空间配置。 */
export function updateSiteWorkspace(config: CanvasAgentConfig, patch: Partial<SiteWorkspaceConfig>) {
    const current = ensureSiteWorkspace(config);
    const workspacePath = patch.workspacePath ? resolveWorkspacePath(patch.workspacePath) : current.workspacePath;
    const next = { ...current, ...patch, workspacePath };
    config.workspace = { workspacePath: next.workspacePath, activeThreadId: next.activeThreadId, pinnedThreadIds: next.pinnedThreadIds };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return config.workspace;
}

/** 确保指定网站账号或匿名设备 profile 使用独立的 Codex 工作空间。 */
export function ensureProfileWorkspace(config: CanvasAgentConfig, profileKey: string) {
    if (!profileKey || profileKey === "legacy") return ensureSiteWorkspace(config);
    const current = config.profiles?.[profileKey]?.workspace;
    if (current?.workspacePath) {
        const workspacePath = resolveWorkspacePath(current.workspacePath);
        initializeWorkspace(workspacePath);
        return { ...current, workspacePath };
    }
    const workspacePath = path.join(CONFIG_DIR, "codex-workspaces", "profiles", profileDirectoryName(profileKey));
    config.profiles ||= {};
    config.profiles[profileKey] = { workspace: { workspacePath } };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return { workspacePath };
}

/** 更新单个 profile 的工作空间和活跃线程，不影响其他 profile。 */
export function updateProfileWorkspace(config: CanvasAgentConfig, profileKey: string, patch: Partial<SiteWorkspaceConfig>) {
    if (!profileKey || profileKey === "legacy") return updateSiteWorkspace(config, patch);
    const current = ensureProfileWorkspace(config, profileKey);
    const workspacePath = patch.workspacePath ? resolveWorkspacePath(patch.workspacePath) : current.workspacePath;
    const next = { ...current, ...patch, workspacePath };
    config.profiles ||= {};
    config.profiles[profileKey] = {
        workspace: { workspacePath: next.workspacePath, activeThreadId: next.activeThreadId, pinnedThreadIds: next.pinnedThreadIds },
    };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return config.profiles[profileKey].workspace as SiteWorkspaceConfig;
}

/** 创建工作空间目录并写入默认 AGENTS.md。 */
function initializeWorkspace(workspacePath: string) {
    if (initializedWorkspaces.has(workspacePath)) return;
    fs.mkdirSync(workspacePath, { recursive: true });
    const instructionsFile = path.join(workspacePath, "AGENTS.md");
    const current = fs.existsSync(instructionsFile) ? fs.readFileSync(instructionsFile, "utf8") : "";
    if (!current || current.startsWith("# Sneeai Agent")) fs.writeFileSync(instructionsFile, AGENT_PROMPT);
    initializedWorkspaces.add(workspacePath);
}

/** 将用户输入的工作空间路径解析为绝对路径。 */
function resolveWorkspacePath(value: string) {
    if (value === "~") return STABLE_USER_HOME;
    if (value.startsWith("~/")) return path.join(STABLE_USER_HOME, value.slice(2));
    return path.resolve(value);
}

function profileDirectoryName(profileKey: string) {
    if (!/^p1:[a-f0-9]{64}$/.test(profileKey)) throw new Error("Sneeai Agent profile key 无效");
    return profileKey.replace(":", "-");
}

/** 从当前包信息中读取 Sneeai Agent 版本号。 */
function readPackageVersion() {
    const pkg = JSON.parse(readBundledText("../package.json", process.env.SNEEAI_AGENT_PACKAGE_JSON, '{"version":"0.0.0"}')) as { version?: string };
    return pkg.version || "0.0.0";
}

/** 生成可区分同版本构建的安全标识；发行构建应显式注入不变的 commit/digest。 */
function readBuildId() {
    const configured = process.env.SNEEAI_AGENT_BUILD_ID?.trim() || "source";
    return /^[A-Za-z0-9._-]{1,128}$/.test(configured) ? configured : "source";
}

/** Release builds inject text assets so the standalone executable has no source-tree dependency. */
function readBundledText(relativePath: string, bundled: string | undefined, fallback: string) {
    if (bundled !== undefined) return bundled;
    try {
        return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
    } catch {
        return fallback;
    }
}
