import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";

import { resolveEntitlementPublicKey } from "../entitlement.js";
import { __networkTest, externalFetch, ExternalNetworkError, resolveExternalNetworkDiagnostics } from "./external-fetch.js";

test("loopback requests always bypass configured proxies", async (t) => {
    const target = http.createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ route: "direct" }));
    });
    await listen(target);
    t.after(() => target.close());
    const address = target.address();
    assert.ok(address && typeof address !== "string");

    const response = await externalFetch(`http://127.0.0.1:${address.port}/health`, {}, {
        routes: [{ kind: "proxy", source: "explicit", url: new URL("http://127.0.0.1:1") }],
    });
    assert.deepEqual(await response.json(), { route: "direct" });
    assert.deepEqual(await resolveExternalNetworkDiagnostics(`http://127.0.0.1:${address.port}/health`), {
        proxyMode: "loopback",
        pacSupported: false,
    });
});

test("an external destination that fails directly succeeds through a proxy", async (t) => {
    const proxy = http.createServer((request, response) => {
        assert.equal(request.url, "http://unreachable.invalid/agent-key");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ route: "proxy" }));
    });
    await listen(proxy);
    t.after(() => proxy.close());
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");

    await assert.rejects(
        () => externalFetch("http://unreachable.invalid/agent-key", {}, { routes: [{ kind: "direct" }] }),
        (error: unknown) => error instanceof ExternalNetworkError && error.attempts[0]?.route === "direct",
    );

    const response = await externalFetch("http://unreachable.invalid/agent-key", {}, {
        routes: [{ kind: "proxy", source: "explicit", url: new URL(`http://127.0.0.1:${address.port}`) }, { kind: "direct" }],
    });
    assert.deepEqual(await response.json(), { route: "proxy" });
});

test("entitlement public-key retrieval uses the configured external proxy", async (t) => {
    const { publicKey } = crypto.generateKeyPairSync("ed25519");
    const rawPublicKey = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
    const keyId = crypto.createHash("sha256").update(rawPublicKey).digest("base64url").slice(0, 16);
    const proxy = http.createServer((request, response) => {
        assert.equal(request.url, "http://unreachable.invalid/api/v1/agent/entitlement/public-key");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
            issuer: "http://unreachable.invalid",
            key_id: keyId,
            algorithm: "EdDSA",
            public_key: rawPublicKey.toString("base64url"),
        }));
    });
    await listen(proxy);
    t.after(() => proxy.close());
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");

    const previous = process.env.SNEEAI_AGENT_HTTP_PROXY;
    process.env.SNEEAI_AGENT_HTTP_PROXY = `http://127.0.0.1:${address.port}`;
    t.after(() => {
        if (previous === undefined) delete process.env.SNEEAI_AGENT_HTTP_PROXY;
        else process.env.SNEEAI_AGENT_HTTP_PROXY = previous;
    });

    const material = await resolveEntitlementPublicKey("http://unreachable.invalid", keyId);
    assert.equal(material.keyId, keyId);
    assert.equal(material.issuer, "http://unreachable.invalid");
});

test("HTTPS destinations use CONNECT and report proxy tunnel failures", async (t) => {
    let connectTarget = "";
    const proxy = http.createServer();
    proxy.on("connect", (request, socket) => {
        connectTarget = request.url || "";
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    await listen(proxy);
    t.after(() => proxy.close());
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");

    await assert.rejects(
        () => externalFetch("https://unreachable.invalid/agent-key", {}, {
            routes: [{ kind: "proxy", source: "explicit", url: new URL(`http://127.0.0.1:${address.port}`) }],
        }),
        (error: unknown) => error instanceof ExternalNetworkError && error.attempts[0]?.code === "proxy_connect_502",
    );
    assert.equal(connectTarget, "unreachable.invalid:443");
});

test("proxy failures return credential-free route diagnostics", async () => {
    await assert.rejects(
        () => externalFetch("http://unreachable.invalid/agent-key", {}, {
            routes: [{ kind: "proxy", source: "explicit", url: new URL("http://user:secret@127.0.0.1:1") }, { kind: "direct" }],
        }),
        (error: unknown) => {
            assert.ok(error instanceof ExternalNetworkError);
            assert.deepEqual(error.attempts.map((attempt) => attempt.route), ["explicit", "direct"]);
            assert.equal(JSON.stringify(error).includes("user"), false);
            assert.equal(JSON.stringify(error).includes("secret"), false);
            assert.equal(error.attempts[0]?.proxy, "http://127.0.0.1:1");
            return true;
        },
    );
});

test("direct requests keep working when no proxy is available", async (t) => {
    const target = http.createServer((_request, response) => response.end("ok"));
    await listen(target);
    t.after(() => target.close());
    const address = target.address();
    assert.ok(address && typeof address !== "string");

    const response = await externalFetch(`http://localhost:${address.port}/plain`);
    assert.equal(await response.text(), "ok");
});

test("proxy parsing and NO_PROXY matching reject unsafe or bypassed values", () => {
    assert.equal(__networkTest.parseProxyUrl("socks5://127.0.0.1:1080"), null);
    assert.equal(__networkTest.parseProxyUrl("http://127.0.0.1:7897/path"), null);
    assert.equal(__networkTest.parseProxyUrl("http://127.0.0.1:7897")?.origin, "http://127.0.0.1:7897");
    assert.equal(__networkTest.matchesNoProxy(new URL("https://api.sneeai.com"), ".sneeai.com,localhost"), true);
    assert.equal(__networkTest.matchesNoProxy(new URL("https://sneeai.com:8443"), "sneeai.com:443"), false);
});

test("macOS PAC URL is parsed as a supported system route", () => {
    const result = __networkTest.parseMacSystemProxy(`
<dictionary> {
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1/proxy.pac
  HTTPEnable : 0
  HTTPSEnable : 0
}
`, new URL("https://sneeai.com"));
    assert.equal(result.value, null);
    assert.equal(result.pac?.href, "http://127.0.0.1/proxy.pac");
    assert.equal(result.note, undefined);
});

test("a concrete system PAC routes an external request without affecting loopback policy", async (t) => {
    const proxy = http.createServer((request, response) => {
        assert.equal(request.url, "http://unreachable.invalid/pac-routed");
        response.end("pac-ok");
    });
    await listen(proxy);
    t.after(() => proxy.close());
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress !== "string");

    const pacServer = http.createServer((_request, response) => {
        response.setHeader("content-type", "application/x-ns-proxy-autoconfig");
        response.end(`function FindProxyForURL() { return "PROXY 127.0.0.1:${proxyAddress.port}"; }`);
    });
    await listen(pacServer);
    t.after(() => pacServer.close());
    const pacAddress = pacServer.address();
    assert.ok(pacAddress && typeof pacAddress !== "string");

    const pac = new URL(`http://127.0.0.1:${pacAddress.port}/proxy.pac`);
    const response = await externalFetch("http://unreachable.invalid/pac-routed", {}, { routes: [{ kind: "pac", source: "system", url: pac }] });
    assert.equal(await response.text(), "pac-ok");
    assert.deepEqual(__networkTest.diagnosticsForRoutes([{ kind: "pac", source: "system", url: pac }]), {
        proxyMode: "system",
        pacSupported: true,
    });
});

test("macOS manual HTTPS proxy is parsed without exposing credentials", () => {
    const result = __networkTest.parseMacSystemProxy(`
<dictionary> {
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7897
}
`, new URL("https://sneeai.com"));
    assert.equal(result.value?.origin, "http://127.0.0.1:7897");
    assert.equal(result.note, undefined);
});

test("Windows manual proxy selects the target protocol entry", () => {
    const httpsProxy = __networkTest.selectWindowsProxy("http=127.0.0.1:8080;https=127.0.0.1:7897", new URL("https://sneeai.com"));
    const sharedProxy = __networkTest.selectWindowsProxy("127.0.0.1:7897", new URL("https://sneeai.com"));
    assert.equal(httpsProxy?.origin, "http://127.0.0.1:7897");
    assert.equal(sharedProxy?.origin, "http://127.0.0.1:7897");
});

test("environment proxy and NO_PROXY settings are resolved safely", () => {
    const target = new URL("https://sneeai.com");
    assert.equal(__networkTest.matchesNoProxy(target, "localhost,.example.com"), false);
    assert.equal(__networkTest.matchesNoProxy(target, "localhost,sneeai.com"), true);
    assert.equal(__networkTest.parseProxyUrl("http://user:secret@127.0.0.1:7897")?.origin, "http://127.0.0.1:7897");
});

test("proxy diagnostics expose only safe mode enums and error codes", () => {
    assert.deepEqual(__networkTest.diagnosticsForRoutes([
        { kind: "proxy", source: "explicit", url: new URL("http://user:secret@127.0.0.1:7897") },
        { kind: "direct" },
    ]), {
        proxyMode: "explicit",
        pacSupported: false,
    });
    assert.deepEqual(__networkTest.diagnosticsForRoutes([
        { kind: "unavailable", source: "system", code: "system_proxy_wpad_unsupported" },
        { kind: "direct" },
    ]), {
        proxyMode: "pac-unsupported",
        pacSupported: false,
        diagnosticCode: "system_proxy_wpad_unsupported",
    });
    assert.equal(JSON.stringify(__networkTest.diagnosticsForRoutes([
        { kind: "proxy", source: "environment", url: new URL("http://user:secret@127.0.0.1:7897") },
    ])).includes("secret"), false);
});

function listen(server: http.Server) {
    return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}
