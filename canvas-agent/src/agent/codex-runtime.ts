import crypto, { type Hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CONFIG_DIR, loadConfig, saveConfig, STABLE_USER_HOME, type CanvasAgentConfig, type CanvasCodexMode } from "../config.js";
import { CANVAS_AGENT_PROFILE_ENV } from "../profile.js";
import { KAPEAI_RELAY_BASE_URL } from "./codex-provider-policy.js";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export type CodexRuntimeFingerprintOptions = { env?: RuntimeEnvironment; homeDir?: string };
type RuntimeFile = { state: "present"; contents: Buffer } | { state: "missing" } | { state: "error"; code: string };
type PluginCacheEntry = readonly [path: string, kind: "directory" | "file" | "symlink" | "other" | "error", detail?: string];
type PluginCacheState = { state: "present"; entries: PluginCacheEntry[] } | { state: "missing" } | { state: "error"; code: string };

export const NESTED_CANVAS_MCP_ENV = "CANVAS_AGENT_NESTED_MCP";
export const CANVAS_AGENT_INTERNAL_TICKET_ENV = "CANVAS_AGENT_INTERNAL_MCP_TICKET";
export { CANVAS_AGENT_PROFILE_ENV };
export const KAPEAI_API_KEY_ENV = "CANVAS_AGENT_KAPEAI_API_KEY";

const ISOLATED_RUNTIME_DIR = "codex-runtime";
const ISOLATED_API_KEY_FILE = "kapeai-api-key";
const RUNTIME_DIR_MODE = 0o700;
const RUNTIME_FILE_MODE = 0o600;
const MIN_API_KEY_LENGTH = 8;
const MAX_API_KEY_LENGTH = 512;
const SNEEAI_PLUGIN_KEYS = ["sneeai@sneeai", "sneeai-agent@sneeai"] as const;
const ISOLATED_CONFIG = `model_provider = "kapeai"\ndisable_response_storage = true\n\n[model_providers.kapeai]\nname = "KapeAI"\nbase_url = "${KAPEAI_RELAY_BASE_URL}"\nwire_api = "responses"\nenv_key = "${KAPEAI_API_KEY_ENV}"\n`;
const HOST_AUTH_ENV_KEYS = [
    "AZURE_OPENAI_AD_TOKEN",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_ENDPOINT",
    "CODEX_ACCESS_TOKEN",
    "CODEX_API_KEY",
    "CODEX_AUTH_TOKEN",
    "CODEX_BASE_URL",
    "OPENAI_ACCESS_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_AUTH_TOKEN",
    "OPENAI_BASE_URL",
    "OPENAI_ORGANIZATION",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT",
    "OPENAI_PROJECT_ID",
] as const;

export type CanvasCodexConnectionStatus = {
    mode: CanvasCodexMode;
    hasRelayApiKey: boolean;
};

export type CanvasCodexConnectionOptions = {
    configDir?: string;
    env?: NodeJS.ProcessEnv;
};

export class CodexRelayApiKeyRequiredError extends Error {
    readonly statusCode = 428;

    constructor() {
        super("请输入 KapeAI API Key 后连接独立 Agent 中转");
        this.name = "CodexRelayApiKeyRequiredError";
    }
}

export class CodexConnectionInputError extends Error {
    readonly statusCode = 400;

    constructor(message: string) {
        super(message);
        this.name = "CodexConnectionInputError";
    }
}

/** 启动 app-server 时只禁用会递归启动 Sneeai Agent MCP 的插件实例。 */
export function canvasCodexAppServerArgs() {
    return ["app-server", "--stdio", ...SNEEAI_PLUGIN_KEYS.flatMap((key) => ["-c", `plugins.${JSON.stringify(key)}.enabled=false`])];
}

/** 返回网页 Agent 当前使用宿主 Codex，还是使用隔离的 KapeAI 运行时。 */
export function canvasCodexMode(config: CanvasAgentConfig = loadConfig()): CanvasCodexMode {
    return config.codex?.mode === "isolated" ? "isolated" : "inherit";
}

/** 返回可安全展示给网页的连接状态，不包含 API Key。 */
export function canvasCodexConnectionStatus(config: CanvasAgentConfig = loadConfig(), options: CanvasCodexConnectionOptions = {}): CanvasCodexConnectionStatus {
    return {
        mode: canvasCodexMode(config),
        hasRelayApiKey: validApiKey(readIsolatedApiKey(options.configDir)),
    };
}

/** 保存网页选择的 Codex 模式；独立模式的密钥只写入本机受限文件。 */
export function configureCanvasCodexConnection(config: CanvasAgentConfig, input: { mode: CanvasCodexMode; apiKey?: string }, options: CanvasCodexConnectionOptions = {}) {
    if (input.mode !== "inherit" && input.mode !== "isolated") throw new CodexConnectionInputError("Codex 连接模式无效");
    if (input.mode === "isolated") {
        const apiKey = input.apiKey === undefined ? readIsolatedApiKey(options.configDir) : input.apiKey;
        if (!apiKey) throw new CodexRelayApiKeyRequiredError();
        if (!validApiKey(apiKey)) throw new CodexConnectionInputError("KapeAI API Key 格式无效");
        ensureIsolatedCodexRuntime(options.configDir);
        if (input.apiKey !== undefined) writeIsolatedApiKey(apiKey, options.configDir);
    }
    config.codex = { ...config.codex, mode: input.mode };
    saveConfig(config);
    return canvasCodexConnectionStatus(config, options);
}

/** 构造 app-server 子进程环境；隔离模式会清除宿主的 provider 和认证覆盖。 */
export function canvasCodexRuntimeEnvironment(config: CanvasAgentConfig = loadConfig(), options: CanvasCodexConnectionOptions = {}) {
    const env = { ...(options.env || process.env) };
    if (canvasCodexMode(config) === "inherit") return env;
    const apiKey = readIsolatedApiKey(options.configDir);
    if (!apiKey) throw new CodexRelayApiKeyRequiredError();
    if (!validApiKey(apiKey)) throw new CodexConnectionInputError("KapeAI API Key 格式无效");
    const codexHome = ensureIsolatedCodexRuntime(options.configDir);
    HOST_AUTH_ENV_KEYS.forEach((key) => delete env[key]);
    env.CODEX_HOME = codexHome;
    env[KAPEAI_API_KEY_ENV] = apiKey;
    return env;
}

/** 返回 app-server 当前实际运行环境与指纹。 */
export function activeCanvasCodexRuntime(config: CanvasAgentConfig = loadConfig(), options: CanvasCodexConnectionOptions = {}) {
    const env = canvasCodexRuntimeEnvironment(config, options);
    return { env, fingerprint: codexRuntimeFingerprint({ env }) };
}

const COMMON_RUNTIME_ENV_KEYS = [
    "AZURE_OPENAI_AD_TOKEN",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_ENDPOINT",
    "CODEX_ACCESS_TOKEN",
    "CODEX_API_KEY",
    "CODEX_AUTH_TOKEN",
    "CODEX_BASE_URL",
    "OPENAI_ACCESS_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_AUTH_TOKEN",
    "OPENAI_BASE_URL",
    "OPENAI_ORGANIZATION",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT",
    "OPENAI_PROJECT_ID",
] as const;

function ensureIsolatedCodexRuntime(configDir = CONFIG_DIR) {
    const codexHome = path.join(configDir, ISOLATED_RUNTIME_DIR);
    fs.mkdirSync(codexHome, { recursive: true, mode: RUNTIME_DIR_MODE });
    if (process.platform !== "win32") fs.chmodSync(codexHome, RUNTIME_DIR_MODE);
    const configFile = path.join(codexHome, "config.toml");
    let current = "";
    try {
        current = fs.readFileSync(configFile, "utf8");
    } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
    }
    if (current !== ISOLATED_CONFIG) writePrivateFile(configFile, ISOLATED_CONFIG);
    else if (process.platform !== "win32") fs.chmodSync(configFile, RUNTIME_FILE_MODE);
    return codexHome;
}

function readIsolatedApiKey(configDir = CONFIG_DIR) {
    try {
        return fs.readFileSync(path.join(configDir, ISOLATED_RUNTIME_DIR, ISOLATED_API_KEY_FILE), "utf8").replace(/\r?\n$/, "");
    } catch (error) {
        if (errorCode(error) === "ENOENT") return "";
        throw error;
    }
}

function validApiKey(value: string) {
    return value.length >= MIN_API_KEY_LENGTH
        && value.length <= MAX_API_KEY_LENGTH
        && /^[\x21-\x7e]+$/.test(value);
}

function writeIsolatedApiKey(apiKey: string, configDir = CONFIG_DIR) {
    const codexHome = ensureIsolatedCodexRuntime(configDir);
    writePrivateFile(path.join(codexHome, ISOLATED_API_KEY_FILE), `${apiKey}\n`);
}

function writePrivateFile(file: string, contents: string) {
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, contents, { mode: RUNTIME_FILE_MODE, flag: "wx" });
        fs.renameSync(temporary, file);
        if (process.platform !== "win32") fs.chmodSync(file, RUNTIME_FILE_MODE);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

/** 返回 Codex 实际读取配置和认证文件的目录。 */
export function effectiveCodexHome(options: CodexRuntimeFingerprintOptions = {}) {
    const env = options.env || process.env;
    const homeDir = options.homeDir || STABLE_USER_HOME;
    return path.resolve(env.CODEX_HOME || path.join(homeDir, ".codex"));
}

/** 生成仅用于本机生命周期比较、不会暴露原始配置或凭据的稳定摘要。 */
export function codexRuntimeFingerprint(options: CodexRuntimeFingerprintOptions = {}) {
    const env = options.env || process.env;
    const codexHome = effectiveCodexHome(options);
    const config = readRuntimeFile(path.join(codexHome, "config.toml"));
    const auth = readRuntimeFile(path.join(codexHome, "auth.json"));
    const pluginCache = readPluginCache(path.join(codexHome, "plugins", "cache"));
    const hash = crypto.createHash("sha256");

    addHashField(hash, "schema", "canvas-agent-codex-runtime-v4");
    addHashField(hash, "codex-home", codexHome);
    addRuntimeFile(hash, "config.toml", config);
    addRuntimeFile(hash, "auth.json", auth);
    addPluginCache(hash, pluginCache);

    const envKeys = new Set<string>(COMMON_RUNTIME_ENV_KEYS);
    if (config.state === "present") extractProviderEnvKeys(config.contents.toString("utf8")).forEach((key) => envKeys.add(key));
    [...envKeys].sort().forEach((key) => {
        addHashField(hash, `env-name:${key}`, key);
        addHashField(hash, `env-value:${key}`, env[key]);
    });
    return `v1:${hash.digest("hex")}`;
}

function readRuntimeFile(file: string): RuntimeFile {
    try {
        return { state: "present", contents: fs.readFileSync(file) };
    } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN";
        return code === "ENOENT" ? { state: "missing" } : { state: "error", code };
    }
}

/** 只记录会影响 Codex 插件解析的缓存目录结构，不读取插件资源内容。 */
function readPluginCache(root: string): PluginCacheState {
    let children: fs.Dirent[];
    try {
        children = sortedDirectoryEntries(root);
    } catch (error) {
        const code = errorCode(error);
        return code === "ENOENT" ? { state: "missing" } : { state: "error", code };
    }

    const entries: PluginCacheEntry[] = [];
    appendPluginCacheEntries(root, "", 0, children, entries);
    return { state: "present", entries };
}

function appendPluginCacheEntries(root: string, relativeParent: string, depth: number, children: fs.Dirent[], entries: PluginCacheEntry[]) {
    for (const child of children) {
        const relative = relativeParent ? `${relativeParent}/${child.name}` : child.name;
        const fullPath = path.join(root, ...relative.split("/"));
        if (child.isSymbolicLink()) {
            try {
                entries.push([relative, "symlink", fs.readlinkSync(fullPath)]);
            } catch (error) {
                entries.push([relative, "error", `readlink:${errorCode(error)}`]);
            }
            continue;
        }
        if (child.isDirectory()) {
            entries.push([relative, "directory"]);
            if (depth >= 2) continue;
            try {
                appendPluginCacheEntries(root, relative, depth + 1, sortedDirectoryEntries(fullPath), entries);
            } catch (error) {
                entries.push([relative, "error", `readdir:${errorCode(error)}`]);
            }
            continue;
        }
        entries.push([relative, child.isFile() ? "file" : "other"]);
    }
}

function sortedDirectoryEntries(directory: string) {
    return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function errorCode(error: unknown) {
    return error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN";
}

function addRuntimeFile(hash: Hash, name: string, file: RuntimeFile) {
    addHashField(hash, `${name}:state`, file.state);
    if (file.state === "present") addHashField(hash, `${name}:contents`, file.contents);
    if (file.state === "error") addHashField(hash, `${name}:error`, file.code);
}

function addPluginCache(hash: Hash, cache: PluginCacheState) {
    addHashField(hash, "plugins-cache:state", cache.state);
    if (cache.state === "present") addHashField(hash, "plugins-cache:entries", JSON.stringify(cache.entries));
    if (cache.state === "error") addHashField(hash, "plugins-cache:error", cache.code);
}

function addHashField(hash: Hash, name: string, value: string | Buffer | undefined) {
    const state = value === undefined ? "unset" : "set";
    const bytes = value === undefined ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(value);
    hash.update(`${Buffer.byteLength(name)}:${name}:${state}:${bytes.length}:`);
    hash.update(bytes);
    hash.update(";");
}

/** 提取 model provider 配置中 env_key 指向的环境变量名。 */
function extractProviderEnvKeys(config: string) {
    const keys = new Set<string>();
    config.split(/\r?\n/).forEach((rawLine) => {
        const line = stripTomlComment(rawLine);
        for (let index = 0; index < line.length;) {
            while (/\s|[.,{}]/.test(line[index] || "")) index += 1;
            if (index >= line.length) break;
            const token = readTomlToken(line, index);
            if (!token) {
                index += 1;
                continue;
            }
            index = token.end;
            if (token.value !== "env_key") continue;
            while (/\s/.test(line[index] || "")) index += 1;
            if (line[index] !== "=") continue;
            index += 1;
            while (/\s/.test(line[index] || "")) index += 1;
            const value = readTomlToken(line, index);
            if (value?.quoted && value.value) keys.add(value.value);
            if (value) index = value.end;
        }
    });
    return keys;
}

function readTomlToken(line: string, start: number): { value: string; end: number; quoted: boolean } | null {
    const quote = line[start];
    if (quote === '"' || quote === "'") {
        let escaped = false;
        for (let index = start + 1; index < line.length; index++) {
            const char = line[index];
            if (quote === '"' && !escaped && char === "\\") {
                escaped = true;
                continue;
            }
            if (char === quote && !escaped) {
                const raw = line.slice(start, index + 1);
                return { value: parseTomlString(raw), end: index + 1, quoted: true };
            }
            escaped = false;
        }
        return null;
    }
    const match = line.slice(start).match(/^[A-Za-z0-9_-]+/);
    return match ? { value: match[0], end: start + match[0].length, quoted: false } : null;
}

function stripTomlComment(line: string) {
    let quote = "";
    let escaped = false;
    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        if (quote === '"') {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === quote) quote = "";
        } else if (quote === "'") {
            if (char === quote) quote = "";
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "#") {
            return line.slice(0, index);
        }
    }
    return line;
}

function parseTomlString(value: string) {
    if (value.startsWith("'")) return value.slice(1, -1);
    try {
        return JSON.parse(value) as string;
    } catch {
        return "";
    }
}
