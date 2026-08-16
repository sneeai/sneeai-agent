import { execFile } from "node:child_process";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { promisify } from "node:util";
import { PacProxyAgent } from "pac-proxy-agent";

const execFileAsync = promisify(execFile);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SYSTEM_PROXY_TIMEOUT_MS = 1_500;
const SYSTEM_PROXY_CACHE_MS = 60_000;

type ProxySource = "explicit" | "system" | "environment";
type Route =
    | { kind: "direct" }
    | { kind: "proxy"; source: ProxySource; url: URL }
    | { kind: "pac"; source: "system"; url: URL }
    | { kind: "unavailable"; source: ProxySource; code: string };

export type ExternalProxyMode = "loopback" | ProxySource | "direct" | "pac-unsupported";

export type ExternalNetworkDiagnostics = {
    proxyMode: ExternalProxyMode;
    pacSupported: boolean;
    diagnosticCode?: string;
};

export type ExternalNetworkAttempt = {
    route: "direct" | ProxySource;
    proxy?: string;
    code: string;
};

export class ExternalNetworkError extends Error {
    readonly code = "agent_external_network_unavailable";

    constructor(readonly targetOrigin: string, readonly attempts: ExternalNetworkAttempt[]) {
        super(`Unable to reach ${targetOrigin} using the available network routes`);
        this.name = "ExternalNetworkError";
    }
}

type ExternalFetchOptions = {
    routes?: Route[];
};

let systemProxyCache = new Map<string, { expiresAt: number; value: URL | null; pac?: URL; note?: string }>();

/**
 * Fetches a trusted external HTTP(S) resource using the Agent network policy.
 * Loopback destinations always bypass every proxy. External destinations try
 * explicit, operating-system, environment, then direct routes.
 */
export async function externalFetch(input: string | URL, init: RequestInit = {}, options: ExternalFetchOptions = {}) {
    const target = new URL(input);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new TypeError("External request URL must use HTTP or HTTPS");
    if (target.username || target.password) throw new TypeError("External request URL must not contain credentials");

    const routes = isLoopbackHostname(target.hostname)
        ? [{ kind: "direct" } as Route]
        : options.routes || await resolveRoutes(target);
    const attempts: ExternalNetworkAttempt[] = [];
    let lastError: unknown;

    for (const route of routes) {
        try {
            return await request(target, init, route);
        } catch (error) {
            if (isAbortError(error)) throw error;
            lastError = error;
            attempts.push({
                route: route.kind === "direct" ? "direct" : route.source,
                proxy: route.kind === "proxy" || route.kind === "pac" ? safeProxyOrigin(route.url) : undefined,
                code: networkErrorCode(error),
            });
        }
    }

    throw new ExternalNetworkError(target.origin, attempts.length ? attempts : [{ route: "direct", code: networkErrorCode(lastError) }]);
}

/**
 * Resolves the effective external-network mode without exposing proxy URLs or
 * credentials. The result is request-local so concurrent calls cannot leak or
 * overwrite each other's diagnostics.
 */
export async function resolveExternalNetworkDiagnostics(input: string | URL): Promise<ExternalNetworkDiagnostics> {
    const target = new URL(input);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new TypeError("External request URL must use HTTP or HTTPS");
    if (target.username || target.password) throw new TypeError("External request URL must not contain credentials");
    if (isLoopbackHostname(target.hostname)) return { proxyMode: "loopback", pacSupported: false };
    return diagnosticsForRoutes(await resolveRoutes(target));
}

async function resolveRoutes(target: URL): Promise<Route[]> {
    const routes: Route[] = [];
    const explicit = configuredProxy(target);
    if (explicit.value) routes.push({ kind: "proxy", source: "explicit", url: explicit.value });
    else if (explicit.note) routes.push({ kind: "unavailable", source: "explicit", code: explicit.note });

    const system = await resolveSystemProxy(target);
    if (system.value) routes.push({ kind: "proxy", source: "system", url: system.value });
    else if (system.pac) routes.push({ kind: "pac", source: "system", url: system.pac });
    else if (system.note) routes.push({ kind: "unavailable", source: "system", code: system.note });

    const environment = environmentProxy(target);
    if (environment.value) routes.push({ kind: "proxy", source: "environment", url: environment.value });
    else if (environment.note) routes.push({ kind: "unavailable", source: "environment", code: environment.note });

    routes.push({ kind: "direct" });
    return deduplicateRoutes(routes);
}

function configuredProxy(target: URL) {
    const value = target.protocol === "https:"
        ? process.env.SNEEAI_AGENT_HTTPS_PROXY || process.env.SNEEAI_AGENT_PROXY
        : process.env.SNEEAI_AGENT_HTTP_PROXY || process.env.SNEEAI_AGENT_PROXY;
    return proxySetting(value);
}

function environmentProxy(target: URL) {
    if (matchesNoProxy(target, process.env.NO_PROXY || process.env.no_proxy || "")) return { value: null };
    const value = target.protocol === "https:"
        ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy
        : process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
    return proxySetting(value);
}

async function resolveSystemProxy(target: URL) {
    const cacheKey = `${process.platform}:${target.protocol}`;
    const cached = systemProxyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { value: cached.value, pac: cached.pac, note: cached.note };

    let value: URL | null = null;
    let pac: URL | undefined;
    let note: string | undefined;
    try {
        if (process.platform === "darwin") ({ value, pac, note } = await resolveMacSystemProxy(target));
        else if (process.platform === "win32") ({ value, pac, note } = await resolveWindowsSystemProxy(target));
    } catch (error) {
        note = networkErrorCode(error);
    }
    systemProxyCache.set(cacheKey, { expiresAt: Date.now() + SYSTEM_PROXY_CACHE_MS, value, pac, note });
    return { value, pac, note };
}

async function resolveMacSystemProxy(target: URL) {
    const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--proxy"], {
        encoding: "utf8",
        timeout: SYSTEM_PROXY_TIMEOUT_MS,
        maxBuffer: 128 * 1024,
    });
    return parseMacSystemProxy(stdout, target);
}

async function resolveWindowsSystemProxy(target: URL) {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const enabled = await windowsRegistryValue(key, "ProxyEnable");
    if (!/0x1$/i.test(enabled.trim())) {
        const [autoConfig, autoDetect] = await Promise.all([
            windowsRegistryValue(key, "AutoConfigURL").catch(() => ""),
            windowsRegistryValue(key, "AutoDetect").catch(() => ""),
        ]);
        if (autoConfig) {
            const pac = parsePacUrl(autoConfig);
            return pac ? { value: null, pac } : { value: null, note: "system_proxy_pac_invalid" };
        }
        return { value: null, note: /0x1$/i.test(autoDetect.trim()) ? "system_proxy_wpad_unsupported" : undefined };
    }
    const server = await windowsRegistryValue(key, "ProxyServer");
    const selected = selectWindowsProxy(server, target);
    if (selected) return { value: selected };
    const autoConfig = await windowsRegistryValue(key, "AutoConfigURL").catch(() => "");
    if (autoConfig) {
        const pac = parsePacUrl(autoConfig);
        return pac ? { value: null, pac } : { value: null, note: "system_proxy_pac_invalid" };
    }
    return { value: null, note: "system_proxy_configuration_invalid" };
}

async function windowsRegistryValue(key: string, name: string) {
    const { stdout } = await execFileAsync("reg.exe", ["query", key, "/v", name], {
        encoding: "utf8",
        timeout: SYSTEM_PROXY_TIMEOUT_MS,
        maxBuffer: 128 * 1024,
        windowsHide: true,
    });
    const line = stdout.split(/\r?\n/).find((entry) => entry.includes(name));
    if (!line) return "";
    const match = line.match(/\sREG_(?:SZ|EXPAND_SZ|DWORD)\s+(.+)$/i);
    return match?.[1]?.trim() || "";
}

function readScutilValue(output: string, key: string) {
    const match = output.match(new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*:\\s*(.+?)\\s*$`, "m"));
    return match?.[1]?.trim() || "";
}

function parseProxyUrl(value: string | undefined) {
    if (!value?.trim()) return null;
    try {
        const parsed = new URL(value.trim());
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
        return parsed;
    } catch {
        return null;
    }
}

function parsePacUrl(value: string | undefined) {
    if (!value?.trim()) return null;
    try {
        const parsed = new URL(value.trim());
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password || parsed.hash) return null;
        return parsed;
    } catch {
        return null;
    }
}

function proxySetting(value: string | undefined) {
    if (!value?.trim()) return { value: null };
    const parsed = parseProxyUrl(value);
    return parsed ? { value: parsed } : { value: null, note: "proxy_configuration_invalid" };
}

function parseMacSystemProxy(output: string, target: URL) {
    const prefix = target.protocol === "https:" ? "HTTPS" : "HTTP";
    const enabled = readScutilValue(output, `${prefix}Enable`) === "1";
    const host = readScutilValue(output, `${prefix}Proxy`);
    const port = readScutilValue(output, `${prefix}Port`);
    if (enabled && host && port) {
        const value = parseProxyUrl(`http://${host}:${port}`);
        return value ? { value } : { value: null, note: "system_proxy_configuration_invalid" };
    }
    if (readScutilValue(output, "ProxyAutoConfigEnable") === "1") {
        const pac = parsePacUrl(readScutilValue(output, "ProxyAutoConfigURLString"));
        return pac ? { value: null, pac } : { value: null, note: "system_proxy_pac_invalid" };
    }
    if (readScutilValue(output, "ProxyAutoDiscoveryEnable") === "1") {
        return { value: null, note: "system_proxy_wpad_unsupported" };
    }
    return { value: null };
}

function selectWindowsProxy(server: string, target: URL) {
    const protocol = target.protocol.slice(0, -1);
    const selected = server.includes("=")
        ? server.split(";").map((entry) => entry.trim()).find((entry) => entry.toLowerCase().startsWith(`${protocol}=`))?.split("=").slice(1).join("=")
        : server.trim();
    if (!selected) return null;
    return parseProxyUrl(`${selected.includes("://") ? "" : "http://"}${selected}`);
}

function matchesNoProxy(target: URL, value: string) {
    const hostname = stripIpv6Brackets(target.hostname).toLowerCase();
    const port = target.port || (target.protocol === "https:" ? "443" : "80");
    return value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean).some((entry) => {
        if (entry === "*") return true;
        const [rawHost, rawPort] = splitNoProxyEntry(entry);
        if (rawPort && rawPort !== port) return false;
        const host = rawHost.replace(/^\./, "");
        return hostname === host || hostname.endsWith(`.${host}`);
    });
}

function splitNoProxyEntry(value: string): [string, string] {
    if (value.startsWith("[")) {
        const end = value.indexOf("]");
        return end >= 0 ? [value.slice(1, end), value.slice(end + 1).replace(/^:/, "")] : [value, ""];
    }
    const separator = value.lastIndexOf(":");
    if (separator > 0 && value.indexOf(":") === separator) return [value.slice(0, separator), value.slice(separator + 1)];
    return [value, ""];
}

function deduplicateRoutes(routes: Route[]) {
    const seen = new Set<string>();
    return routes.filter((route) => {
        const key = route.kind === "direct"
            ? "direct"
            : route.kind === "unavailable"
                ? `${route.source}:${route.code}`
                : route.kind === "pac"
                    ? `pac:${route.url.href}`
                    : `${route.url.protocol}//${route.url.host}:${route.url.username}:${route.url.password}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function diagnosticsForRoutes(routes: Route[]): ExternalNetworkDiagnostics {
    const activePac = routes.find((route): route is Extract<Route, { kind: "pac" }> => route.kind === "pac");
    const activeProxy = routes.find((route): route is Extract<Route, { kind: "proxy" }> => route.kind === "proxy");
    const pac = routes.find((route): route is Extract<Route, { kind: "unavailable" }> => (
        route.kind === "unavailable" && (route.code === "system_proxy_pac_invalid" || route.code === "system_proxy_wpad_unsupported")
    ));
    if (activePac) return { proxyMode: "system", pacSupported: true };
    if (activeProxy) {
        return {
            proxyMode: activeProxy.source,
            pacSupported: false,
            ...(pac ? { diagnosticCode: pac.code } : {}),
        };
    }
    if (pac) return { proxyMode: "pac-unsupported", pacSupported: false, diagnosticCode: pac.code };
    const unavailable = routes.find((route): route is Extract<Route, { kind: "unavailable" }> => route.kind === "unavailable");
    return {
        proxyMode: "direct",
        pacSupported: false,
        ...(unavailable ? { diagnosticCode: unavailable.code } : {}),
    };
}

async function request(target: URL, init: RequestInit, route: Route) {
    if (route.kind === "unavailable") throw networkError(route.code);
    if (init.body !== undefined && init.body !== null) throw new TypeError("External fetch body is not supported");
    const method = (init.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new TypeError("External fetch supports only GET and HEAD");
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const response = route.kind === "direct"
        ? await directRequest(target, method, headers, init.signal)
        : route.kind === "pac"
            ? await pacRequest(target, method, headers, init.signal, route.url)
            : await proxyRequest(target, method, headers, init.signal, route.url);
    const statusCode = response.statusCode || 500;
    if (init.redirect === "error" && statusCode >= 300 && statusCode < 400) {
        response.resume();
        throw networkError("redirect_not_allowed");
    }
    return responseToFetchResponse(response, method);
}

function directRequest(target: URL, method: string, headers: Record<string, string>, signal: AbortSignal | null | undefined) {
    const client = target.protocol === "https:" ? https : http;
    return new Promise<IncomingMessage>((resolve, reject) => {
        const request = client.request(target, { method, headers: { ...headers, connection: "close" }, signal: signal || undefined }, resolve);
        request.once("error", reject);
        request.end();
    });
}

function pacRequest(target: URL, method: string, headers: Record<string, string>, signal: AbortSignal | null | undefined, pac: URL) {
    const client = target.protocol === "https:" ? https : http;
    const agent = new PacProxyAgent(pac.href);
    return new Promise<IncomingMessage>((resolve, reject) => {
        const request = client.request(target, { method, headers: { ...headers, connection: "close" }, signal: signal || undefined, agent }, resolve);
        request.once("error", reject);
        request.end();
    });
}

async function proxyRequest(target: URL, method: string, headers: Record<string, string>, signal: AbortSignal | null | undefined, proxy: URL) {
    if (target.protocol === "http:") return forwardProxyRequest(target, method, headers, signal, proxy);
    return tunnelProxyRequest(target, method, headers, signal, proxy);
}

function forwardProxyRequest(target: URL, method: string, headers: Record<string, string>, signal: AbortSignal | null | undefined, proxy: URL) {
    const client = proxy.protocol === "https:" ? https : http;
    return new Promise<IncomingMessage>((resolve, reject) => {
        const request = client.request({
            protocol: proxy.protocol,
            hostname: proxy.hostname,
            port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
            method,
            path: target.href,
            headers: { ...headers, host: target.host, connection: "close", ...proxyAuthorizationHeader(proxy) },
            signal: signal || undefined,
        }, (response) => {
            if (response.statusCode === 407) {
                response.resume();
                reject(networkError("proxy_authentication_required"));
                return;
            }
            resolve(response);
        });
        request.once("error", reject);
        request.end();
    });
}

function tunnelProxyRequest(target: URL, method: string, headers: Record<string, string>, signal: AbortSignal | null | undefined, proxy: URL) {
    const client = proxy.protocol === "https:" ? https : http;
    return new Promise<IncomingMessage>((resolve, reject) => {
        const connect = client.request({
            protocol: proxy.protocol,
            hostname: proxy.hostname,
            port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
            method: "CONNECT",
            path: `${target.hostname}:${target.port || 443}`,
            headers: { host: `${target.hostname}:${target.port || 443}`, ...proxyAuthorizationHeader(proxy) },
            signal: signal || undefined,
        });
        connect.once("connect", (response, socket, head) => {
            if (response.statusCode !== 200) {
                socket.destroy();
                reject(networkError(response.statusCode === 407 ? "proxy_authentication_required" : `proxy_connect_${response.statusCode || "failed"}`));
                return;
            }
            if (head.length) socket.unshift(head);
            const secureSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true });
            secureSocket.once("error", reject);
            secureSocket.once("secureConnect", () => {
                const tunnelAgent = new https.Agent({ keepAlive: false });
                tunnelAgent.createConnection = (_options, callback) => {
                    callback?.(null, secureSocket);
                    return secureSocket;
                };
                const tunneled = https.request({
                    protocol: "https:",
                    hostname: target.hostname,
                    port: target.port || 443,
                    path: `${target.pathname}${target.search}`,
                    method,
                    headers: { ...headers, host: target.host, connection: "close" },
                    agent: tunnelAgent,
                    signal: signal || undefined,
                }, (targetResponse) => {
                    targetResponse.once("close", () => tunnelAgent.destroy());
                    resolve(targetResponse);
                });
                tunneled.once("error", reject);
                tunneled.end();
            });
        });
        connect.once("error", reject);
        connect.end();
    });
}

function proxyAuthorizationHeader(proxy: URL) {
    if (!proxy.username && !proxy.password) return {};
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    return { "proxy-authorization": `Basic ${Buffer.from(credentials).toString("base64")}` };
}

async function responseToFetchResponse(response: IncomingMessage, method: string) {
    const chunks: Buffer[] = [];
    let length = 0;
    if (method !== "HEAD") {
        for await (const chunk of response) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            length += buffer.length;
            if (length > MAX_RESPONSE_BYTES) {
                response.destroy();
                throw networkError("response_too_large");
            }
            chunks.push(buffer);
        }
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, String(value));
    }
    const status = response.statusCode || 500;
    const bodyForbidden = method === "HEAD" || status === 204 || status === 205 || status === 304;
    const result = new Response(bodyForbidden ? null : Buffer.concat(chunks), {
        status,
        statusText: response.statusMessage,
        headers,
    });
    response.destroy();
    return result;
}

function isLoopbackHostname(value: string) {
    const hostname = stripIpv6Brackets(value).toLowerCase();
    if (hostname === "localhost" || hostname === "::1") return true;
    if (net.isIP(hostname) === 4) return hostname.split(".")[0] === "127";
    return false;
}

function stripIpv6Brackets(value: string) {
    return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function safeProxyOrigin(proxy: URL) {
    return `${proxy.protocol}//${proxy.host}`;
}

function networkError(code: string) {
    return Object.assign(new Error(code), { code });
}

function networkErrorCode(error: unknown) {
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
    if (error instanceof Error && error.name === "AbortError") return "request_aborted";
    return "network_request_failed";
}

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === "AbortError";
}

export const __networkTest = {
    resetSystemProxyCache() {
        systemProxyCache = new Map();
    },
    parseProxyUrl,
    parsePacUrl,
    parseMacSystemProxy,
    selectWindowsProxy,
    matchesNoProxy,
    diagnosticsForRoutes,
};
