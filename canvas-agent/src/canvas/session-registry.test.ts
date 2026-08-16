import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";

import { CanvasSessionRegistry, CanvasSessionRoutingError } from "./session-registry.js";

test("thread and workspace events never cross profile sessions", (t) => {
    const registry = new CanvasSessionRegistry();
    const first = connect(registry, "profile-a", "shared-client");
    const second = connect(registry, "profile-b", "shared-client");
    t.after(() => registry.dispose());

    registry.session("profile-a").emitThread("workspace_changed", "thread-a", { activeThreadId: "thread-a" });

    assert.deepEqual(first.event("workspace_changed"), { activeThreadId: "thread-a", threadId: "thread-a" });
    assert.equal(second.event("workspace_changed"), undefined);
    assert.equal(registry.health().clients, 2);
    assert.equal(registry.health().profiles, 2);
});

test("disposing an expired profile closes only its event streams", (t) => {
    const registry = new CanvasSessionRegistry();
    const first = connect(registry, "profile-a", "client-a");
    const second = connect(registry, "profile-b", "client-b");
    t.after(() => registry.dispose());

    assert.equal(registry.disposeProfile("profile-a"), true);
    assert.equal(first.closed, true);
    assert.equal(second.closed, false);
    assert.equal(registry.health().profiles, 1);
    assert.equal(registry.health().clients, 1);
});

test("disposing a profile rejects its proposals without dispatching them", async (t) => {
    const registry = new CanvasSessionRegistry();
    const first = connect(registry, "profile-a", "client-a");
    t.after(() => registry.dispose());
    const result = registry.session("profile-a").callTool("canvas_create_text_node", { text: "pending" });
    const outcome = result.then(() => "resolved", (error) => error instanceof Error ? error.message : String(error));

    assert.ok(first.event("tool_proposal"));
    assert.equal(first.event("tool_call"), undefined);
    registry.disposeProfile("profile-a", "lease expired");
    assert.match(await outcome, /lease expired/);
    assert.equal(first.event("tool_call"), undefined);
});

test("local MCP follows the most recently activated canvas across profiles", (t) => {
    const registry = new CanvasSessionRegistry();
    connect(registry, "profile-a", "client-a");
    connect(registry, "profile-b", "client-b");
    registry.session("profile-a").updateState({ projectId: "canvas-a" }, "client-a");
    registry.session("profile-b").updateState({ projectId: "canvas-b" }, "client-b");
    t.after(() => registry.dispose());

    registry.activateCanvas("profile-a", "client-a");
    assert.equal(registry.resolveLocalToolSession(), registry.session("profile-a"));

    registry.activateCanvas("profile-b", "client-b");
    assert.equal(registry.resolveLocalToolSession(), registry.session("profile-b"));
});

test("refreshing a canvas replaces the stale client binding", (t) => {
    const registry = new CanvasSessionRegistry();
    const oldPage = connect(registry, "profile-a", "client-old");
    connect(registry, "profile-a", "client-new");
    registry.session("profile-a").updateState({ projectId: "canvas-old" }, "client-old");
    registry.session("profile-a").updateState({ projectId: "canvas-new" }, "client-new");
    t.after(() => registry.dispose());

    registry.activateCanvas("profile-a", "client-old");
    registry.activateCanvas("profile-a", "client-new");
    oldPage.end();

    assert.equal(registry.resolveLocalToolSession(), registry.session("profile-a"));
    assert.equal(registry.session("profile-a").activeCanvasClientId(), "client-new");
});

test("disconnecting the newest canvas falls back to the previous valid profile", (t) => {
    const registry = new CanvasSessionRegistry();
    connect(registry, "profile-a", "client-a");
    const newest = connect(registry, "profile-b", "client-b");
    registry.session("profile-a").updateState({ projectId: "canvas-a" }, "client-a");
    registry.session("profile-b").updateState({ projectId: "canvas-b" }, "client-b");
    t.after(() => registry.dispose());

    registry.activateCanvas("profile-a", "client-a");
    registry.activateCanvas("profile-b", "client-b");
    newest.end();

    assert.equal(registry.resolveLocalToolSession(), registry.session("profile-a"));
});

test("local MCP never guesses between unactivated profile canvases", (t) => {
    const registry = new CanvasSessionRegistry();
    connect(registry, "profile-a", "client-a");
    connect(registry, "profile-b", "client-b");
    registry.session("profile-a").updateState({ projectId: "canvas-a" }, "client-a");
    registry.session("profile-b").updateState({ projectId: "canvas-b" }, "client-b");
    t.after(() => registry.dispose());

    assert.throws(
        () => registry.resolveLocalToolSession(),
        (error: unknown) => error instanceof CanvasSessionRoutingError && error.code === "canvas_binding_ambiguous" && error.statusCode === 409,
    );
});

test("only a unique legacy canvas retains implicit local MCP compatibility", (t) => {
    const registry = new CanvasSessionRegistry();
    connect(registry, "legacy", "legacy-client");
    registry.session("legacy").updateState({ projectId: "legacy-canvas" }, "legacy-client");
    t.after(() => registry.dispose());

    assert.equal(registry.resolveLocalToolSession(), registry.session("legacy"));
});

test("expired active canvas bindings are removed from routing and health", (t) => {
    let now = 1_000;
    const registry = new CanvasSessionRegistry({ now: () => now, bindingTtlMs: 300_000 });
    connect(registry, "profile-a", "client-a");
    t.after(() => registry.dispose());

    registry.activateCanvas("profile-a", "client-a");
    assert.equal(registry.health().activeCanvas, true);

    now += 300_000;
    assert.equal(registry.health().activeCanvas, false);
    assert.throws(
        () => registry.resolveLocalToolSession(),
        (error: unknown) => error instanceof CanvasSessionRoutingError && error.code === "canvas_binding_expired" && error.statusCode === 409,
    );
});

test("state updates renew only existing bindings without stealing focus", (t) => {
    let now = 1_000;
    const registry = new CanvasSessionRegistry({ now: () => now, bindingTtlMs: 300_000 });
    connect(registry, "profile-a", "client-a");
    connect(registry, "profile-b", "client-b");
    t.after(() => registry.dispose());

    assert.equal(registry.touchCanvas("profile-a", "client-a"), false);
    assert.equal(registry.health().activeCanvas, false);

    registry.activateCanvas("profile-a", "client-a");
    now += 1;
    registry.activateCanvas("profile-b", "client-b");
    now += 299_998;
    assert.equal(registry.touchCanvas("profile-a", "client-a"), true);
    now += 2;

    assert.equal(registry.resolveLocalToolSession(), registry.session("profile-a"));
    assert.equal(registry.session("profile-a").activeCanvasClientId(), "client-a");
});

function connect(registry: CanvasSessionRegistry, profileKey: string, clientId: string) {
    const response = new FakeSseResponse();
    registry.session(profileKey).openEvents(new URL(`http://127.0.0.1/events?clientId=${clientId}`), response as unknown as ServerResponse);
    return response;
}

class FakeSseResponse extends EventEmitter {
    private chunks: string[] = [];
    closed = false;

    writeHead() {
        return this;
    }

    write(chunk: string) {
        this.chunks.push(chunk);
        return true;
    }

    event(type: string) {
        const chunk = this.chunks.find((item) => item.startsWith(`event: ${type}\n`));
        const data = chunk?.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        return data ? JSON.parse(data) as unknown : undefined;
    }

    end() {
        this.closed = true;
        this.emit("close");
        return this;
    }
}
