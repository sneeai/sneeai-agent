import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCredentialStore, CredentialStoreError, isCredentialReference, type CredentialReference, type CredentialStore } from "./credential-store.js";

export const DEFAULT_PORT = 17371;
export const FALLBACK_PORTS = Object.freeze(Array.from({ length: 8 }, (_, index) => DEFAULT_PORT + index + 1));
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
    credential?: CredentialReference;
    deviceId?: string;
    origins?: string[];
    workspace?: SiteWorkspaceConfig;
    profiles?: Record<string, CanvasAgentProfileConfig>;
    codex?: { mode?: CanvasCodexMode };
};

type ConfigOptions = { credentialStore?: CredentialStore };

/** Insecure plaintext credentials are available only to source-tree tests. */
export function allowInsecureTestCredentials(
    environment: NodeJS.ProcessEnv = process.env,
    buildId = BUILD_ID,
    execArguments: readonly string[] = process.execArgv,
) {
    const runningThroughTsx = execArguments.some((argument, index) => argument === "tsx" || argument.endsWith("/tsx") || (argument === "--import" && execArguments[index + 1]?.includes("tsx")));
    return buildId === "source" && runningThroughTsx && environment.NODE_ENV === "test" && environment.SNEEAI_AGENT_DISABLE_SECURE_CREDENTIALS === "1";
}

/** 读取本地 Sneeai Agent 配置，不存在时生成默认配置。 */
export function loadConfig(create = false, options: ConfigOptions = {}): CanvasAgentConfig {
    try {
        const config = readConfig(options.credentialStore);
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

function readConfig(credentialStore?: CredentialStore) {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch (error) {
        if (isFileMissing(error)) throw error;
        throw new Error(`Sneeai Agent 配置文件无效，请检查或删除 ${CONFIG_FILE}`, { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as CanvasAgentConfig).url !== "string") {
        throw new Error(`Sneeai Agent 配置文件无效，请检查或删除 ${CONFIG_FILE}`);
    }
    const config = parsed as CanvasAgentConfig;
    if (isCredentialReference(config.credential)) {
        try {
            config.token = (credentialStore || createCredentialStore()).read(config.credential);
        } catch (error) {
            const code = error instanceof CredentialStoreError ? error.code : "credential_store_read_failed";
            throw new Error(`Sneeai Agent 无法读取当前系统用户的 Connect token (${code})；请使用 doctor 查看 credential 诊断`, { cause: error });
        }
    } else if (config.credential !== undefined || typeof config.token !== "string" || !config.token) {
        throw new Error(`Sneeai Agent 配置文件无效，请检查或删除 ${CONFIG_FILE}`);
    }
    if (config.url !== "local") parseLoopbackAgentUrl(config.url);
    if (config.deviceId !== undefined && !DEVICE_ID_PATTERN.test(config.deviceId)) throw new Error(`Sneeai Agent 配置文件无效，请检查或删除 ${CONFIG_FILE}`);
    return config;
}

function readConfigWithRetry(credentialStore?: CredentialStore) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            return readConfig(credentialStore);
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
        const persisted = config.credential
            ? Object.fromEntries(Object.entries(config).filter(([key]) => key !== "token"))
            : config;
        fs.writeFileSync(descriptor, JSON.stringify(persisted, null, 2));
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

/**
 * Ensures runtime credentials use the current user's operating-system store.
 * Fresh Windows/macOS installs never persist a plaintext token; legacy config
 * is migrated without rotating the existing token.
 */
export function ensureSecureConfig(credentialStore = createCredentialStore()) {
    if (credentialStore.backend === "unsupported") return loadConfig(true, { credentialStore });
    if (fs.existsSync(CONFIG_FILE)) {
        const config = loadConfig(true, { credentialStore });
        if (!config.credential) migrateConfigCredential(config, credentialStore);
        return config;
    }

    const config = defaultConfig();
    const reference = credentialStore.store(config.token);
    config.credential = reference;
    try {
        const created = createSecureConfig(config, credentialStore);
        if (created !== config) credentialStore.remove(reference);
        return created;
    } catch (error) {
        try {
            credentialStore.remove(reference);
        } catch {
            // Preserve the original configuration error. The unreferenced
            // credential can still be removed by credential diagnostics.
        }
        throw error;
    }
}

function createSecureConfig(config: CanvasAgentConfig, credentialStore: CredentialStore) {
    ensureConfigDir();
    const temporaryFile = configTemporaryFile();
    try {
        writeConfigFile(temporaryFile, config);
        try {
            fs.linkSync(temporaryFile, CONFIG_FILE);
            return config;
        } catch (error) {
            if (!isFileExists(error)) throw error;
            return readConfigWithRetry(credentialStore);
        }
    } finally {
        fs.rmSync(temporaryFile, { force: true });
    }
}

/** 将已验证的本机地址统一为 MCP/HTTP 桥接实际使用的 IPv4 回环地址。 */
export function effectiveCanvasAgentUrl(value: string) {
    const configuredPort = validAgentPort(process.env.PORT);
    if (value === "local") return `http://127.0.0.1:${configuredPort || DEFAULT_PORT}`;
    const parsed = parseLoopbackAgentUrl(value);
    return `http://127.0.0.1:${configuredPort || validAgentPort(parsed.port) || DEFAULT_PORT}`;
}

/** Returns deterministic candidates: explicit/persisted port, default, then fixed fallbacks. */
export function canvasAgentPortCandidates(config: Pick<CanvasAgentConfig, "url">, configuredPort = process.env.PORT) {
    const explicit = validAgentPort(configuredPort);
    const persisted = config.url === "local" ? 0 : validAgentPort(parseLoopbackAgentUrl(config.url).port);
    return [...new Set([explicit, persisted, DEFAULT_PORT, ...FALLBACK_PORTS].filter(Boolean))];
}

/** Selects the first candidate not known to be occupied; listening remains the HTTP server's responsibility. */
export function selectCanvasAgentPort(config: Pick<CanvasAgentConfig, "url">, occupiedPorts: ReadonlySet<number>, configuredPort = process.env.PORT) {
    const selected = canvasAgentPortCandidates(config, configuredPort).find((port) => !occupiedPorts.has(port));
    if (!selected) throw new Error(`Sneeai Agent 固定备用端口 ${DEFAULT_PORT}-${FALLBACK_PORTS.at(-1)} 全部被占用`);
    return selected;
}

/** Persists a port only after the caller has successfully bound it. */
export function persistCanvasAgentPort(config: CanvasAgentConfig, port: number) {
    if (!validAgentPort(String(port))) throw new Error("Sneeai Agent 端口无效");
    config.url = `http://127.0.0.1:${port}`;
    saveConfig(config);
    return config.url;
}

/** Moves the current plaintext token into the current-user secure store without changing it. */
export function migrateConfigCredential(config: CanvasAgentConfig, credentialStore = createCredentialStore()) {
    if (config.credential) return { migrated: false, backend: config.credential.backend };
    const reference = credentialStore.store(config.token);
    const previous = config.credential;
    try {
        config.credential = reference;
        saveConfig(config);
    } catch (error) {
        config.credential = previous;
        throw error;
    }
    return { migrated: true, backend: reference.backend };
}

/** Explicitly rotates the local token; callers must stop a running Agent first. */
export function rotateConfigToken(config: CanvasAgentConfig, credentialStore = createCredentialStore()) {
    const token = crypto.randomBytes(32).toString("base64url");
    const reference = credentialStore.store(token);
    const previous = { token: config.token, credential: config.credential };
    try {
        config.token = token;
        config.credential = reference;
        saveConfig(config);
    } catch (error) {
        config.token = previous.token;
        config.credential = previous.credential;
        throw error;
    }
    if (previous.credential?.backend === "macos-keychain") {
        try {
            credentialStore.remove(previous.credential);
        } catch (error) {
            // The new config is committed and is the only valid token. Surface
            // cleanup failure so the orphaned keychain item can be removed.
            throw new Error("Sneeai Agent token 已轮换，但旧 macOS Keychain 凭据清理失败", { cause: error });
        }
    }
    return { rotated: true, backend: reference.backend, previousCredentialRemoved: Boolean(previous.credential) };
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
