import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";

import { CanvasCodexControlError, CanvasSession, CanvasSessionRoutingError, READ_ONLY_TOOL_NAMES, type PendingToolProposal } from "./session.js";
import { toolInputSchemas } from "./schemas.js";

test("MCP 读取当前激活网页的画布", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.updateState(snapshot("canvas-first"), "first");
    session.updateState(snapshot("canvas-second"), "second");

    session.activateClient("first");
    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-first");

    session.activateClient("second");
    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-second");
});

test("MCP without a connected canvas returns a retryable routing error", async () => {
    const session = new CanvasSession();
    const operationId = "9bb7db86-ece7-4c42-a847-778948e873d6";

    await assert.rejects(
        session.callTool("canvas_get_state", {}, { operationId }),
        (error: unknown) => error instanceof CanvasSessionRoutingError && error.code === "canvas_not_connected" && error.statusCode === 409,
    );

    const first = connect(session, "connected");
    session.updateState(snapshot("connected-canvas"), "connected");
    session.activateClient("connected");
    assert.equal(field(await session.callTool("canvas_get_state", {}, { operationId }), "projectId"), "connected-canvas");
    first.close();
});

test("画布写操作只发送给当前激活网页", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.updateState(snapshot("canvas-first"), "first");
    session.updateState(snapshot("canvas-second"), "second");
    session.activateClient("second");

    const result = session.callTool("canvas_create_text_node", { text: "只写入第二个画布" });
    const proposal = second.event("tool_proposal");
    assert.equal(first.event("tool_proposal"), undefined);
    assert.equal(field(proposal, "protocol"), "tool.authorization.v1");
    assert.equal(field(proposal, "name"), "canvas_create_text_node");
    assert.deepEqual(field(proposal, "input"), { text: "只写入第二个画布" });
    assert.equal(field(proposal, "dispatchName"), "canvas_apply_ops");
    assert.deepEqual(field(proposal, "dispatchInput"), {
        ops: [{
            type: "add_node",
            nodeType: "text",
            position: { x: 0, y: 0 },
            metadata: { content: "只写入第二个画布", status: "success", fontSize: 14 },
        }],
    });
    assert.match(String(field(proposal, "commitment")), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(second.event("tool_call"), undefined);
    await approve(session, second, "second");
    const call = second.event("tool_call");
    assert.equal(first.event("tool_call"), undefined);
    assert.equal(field(call, "name"), "canvas_apply_ops");
    assert.equal(field(call, "requestId"), field(proposal, "operationId"));
    assert.equal("authorization" in (call as Record<string, unknown>), false);
    assert.equal(await session.decideTool("second", { operationId: String(field(proposal, "operationId")), decision: "approve" }, permit()), false);
    assert.equal(second.events("tool_call").length, 1);
    session.resolveResult("second", { requestId: String(field(call, "requestId")), result: { ok: true } });
    assert.deepEqual(await result, { ok: true });
});

test("repeated caller operationId reuses the pending and recorded tool result", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());
    session.updateState(snapshot("canvas-first"), "first");
    session.activateClient("first");
    const operationId = "8bb7db86-ece7-4c42-a847-778948e873d6";

    const original = session.callTool("canvas_create_text_node", { text: "idempotent" }, { operationId });
    const concurrentRetry = session.callTool("canvas_create_text_node", { text: "idempotent" }, { operationId });
    assert.equal(concurrentRetry, original);
    assert.equal(first.events("tool_proposal").length, 1);
    assert.equal(field(first.event("tool_proposal"), "operationId"), operationId);

    await approve(session, first, "first");
    session.resolveResult("first", { requestId: operationId, result: { created: true } });
    assert.deepEqual(await Promise.all([original, concurrentRetry]), [{ created: true }, { created: true }]);

    const completedRetry = session.callTool("canvas_create_text_node", { text: "idempotent" }, { operationId });
    assert.equal(completedRetry, original);
    assert.deepEqual(await completedRetry, { created: true });
    assert.equal(first.events("tool_proposal").length, 1);
    assert.throws(
        () => session.callTool("canvas_create_text_node", { text: "different" }, { operationId }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "operation_id_conflict",
    );
});

test("a full idempotency cache preserves unexpired results and rejects new operations", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());
    session.updateState(snapshot("canvas-first"), "first");
    session.activateClient("first");

    const operationIds = Array.from({ length: 256 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    for (const operationId of operationIds) {
        assert.equal(field(await session.callTool("canvas_get_state", {}, { operationId }), "projectId"), "canvas-first");
    }

    assert.throws(
        () => session.callTool("canvas_get_state", {}, { operationId: "00000000-0000-4000-8000-000000000256" }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "operation_cache_full" && "statusCode" in error && error.statusCode === 429,
    );
    assert.equal(field(await session.callTool("canvas_get_state", {}, { operationId: operationIds[0] }), "projectId"), "canvas-first");
});

test("当前 turn 的图片附件可在发起标签页画布创建图片节点", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());
    const dataUrl = "data:image/png;base64,aW1hZ2U=";
    session.setTurnAttachments("first", [{ id: "attachment-1", name: "商品.png", type: "image/png", size: 5, width: 1200, height: 600, dataUrl }]);
    session.bindClient("first");

    const result = session.callTool("canvas_create_attachment_nodes", { attachmentIds: ["attachment-1"], x: 100, y: 200 });
    await approve(session, first, "first");
    const call = first.event("tool_call");
    const input = field(call, "input") as Record<string, unknown>;
    const nodes = input.nodes as Array<Record<string, unknown>>;
    assert.equal(field(call, "name"), "canvas_create_attachment_nodes");
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].attachmentId, "attachment-1");
    assert.equal(nodes[0].title, "商品.png");
    assert.deepEqual(nodes[0].position, { x: 100, y: 200 });
    assert.equal(nodes[0].width, 640);
    assert.equal(nodes[0].height, 320);
    assert.equal("dataUrl" in nodes[0], false);
    assert.equal(session.getTurnAttachment("first", "attachment-1").dataUrl, dataUrl);

    session.resolveResult("first", { requestId: String(field(call, "requestId")), result: { ok: true } });
    const created = (await result) as { nodes: Array<{ id: string; attachmentId: string; title: string }> };
    assert.equal(created.nodes[0].id, nodes[0].id);
    assert.equal(created.nodes[0].attachmentId, "attachment-1");
    session.clearTurnAttachments("first");
    assert.throws(() => session.getTurnAttachment("first", "attachment-1"), /找不到/);
});

test("图片附件只允许发起 turn 的标签页读取和落入画布", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.setTurnAttachments("first", [{ id: "attachment-1", name: "商品.png", type: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" }]);
    session.bindClient("second");

    await assert.rejects(session.callTool("canvas_create_attachment_nodes", { attachmentIds: ["attachment-1"] }), /发起标签页/);
    assert.throws(() => session.getTurnAttachment("second", "attachment-1"), /发起标签页/);
    assert.equal(first.event("tool_call"), undefined);
    assert.equal(second.event("tool_call"), undefined);
});

test("tool result is accepted only from the request client", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.activateClient("first");

    const result = session.callTool("canvas_create_text_node", { text: "first only" });
    const proposal = first.event("tool_proposal");
    const requestId = String(field(proposal, "operationId"));

    assert.equal(session.resolveResult("first", { requestId, result: { early: true } }), false);
    await approve(session, first, "first");
    assert.equal(session.resolveResult("second", { requestId, result: { client: "second" } }), false);
    assert.equal(session.resolveResult("first", { requestId, result: { client: "first" } }), true);
    assert.deepEqual(await result, { client: "first" });
});

test("生成状态查询由当前激活网页返回", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.activateClient("second");

    const result = session.callTool("generation_get_status", { scope: "all" });
    const call = second.event("tool_call");
    assert.equal(first.event("tool_call"), undefined);
    assert.equal(field(call, "name"), "generation_get_status");
    session.resolveResult("second", { requestId: String(field(call, "requestId")), result: { total: 1, tasks: [{ id: "image-1", status: "running" }] } });
    assert.deepEqual(await result, { total: 1, tasks: [{ id: "image-1", status: "running" }] });
});

test("the fixed read-only allowlist dispatches without a permit", async (t) => {
    assert.deepEqual(READ_ONLY_TOOL_NAMES, [
        "site_navigate",
        "canvas_list_projects",
        "canvas_get_state",
        "canvas_get_selection",
        "canvas_export_snapshot",
        "canvas_select_nodes",
        "canvas_set_viewport",
        "generation_get_status",
        "workbench_image_get_config",
        "workbench_video_get_config",
        "prompts_search",
        "assets_list",
    ]);
    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());
    session.updateState(snapshot("canvas-first"), "first");

    const result = session.callTool("canvas_select_nodes", { ids: ["node-1"] });
    assert.equal(first.event("tool_proposal"), undefined);
    const call = first.event("tool_call");
    assert.equal(field(call, "name"), "canvas_apply_ops");
    session.resolveResult("first", { requestId: String(field(call, "requestId")), result: { ok: true } });
    assert.deepEqual(await result, { ok: true });
});

test("a rejected proposal never dispatches and rejects the MCP promise", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());
    const result = session.callTool("canvas_create_text_node", { text: "reject me" });
    const outcome = result.then(() => "resolved", (error) => error instanceof Error ? error.message : String(error));
    const operationId = String(field(first.event("tool_proposal"), "operationId"));

    assert.equal(await session.decideTool("first", { operationId, decision: "reject", error: "user denied" }, () => Promise.reject(new Error("must not verify"))), true);
    assert.match(await outcome, /user denied/);
    assert.equal(first.event("tool_call"), undefined);
});

test("视频工作台生成在授权拒绝后不会下发，且完整视频合同保持不丢字段", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());
    const input = {
        prompt: "镜头绕过产品",
        offering: "pixverse_v6_bc2dd1ff29858228",
        mode: "reference",
        duration: 5,
        resolution: "720p",
        aspectRatio: "9:16",
        audio: true,
        parameters: { seed: 42 },
        references: { images: [{ objectId: "10000000-0000-4000-8000-000000000001" }] },
        requestId: "agent-video-contract-test",
    };
    const result = session.callTool("workbench_video_generate", input);
    const proposal = first.event("tool_proposal");

    assert.equal(field(proposal, "name"), "workbench_video_generate");
    assert.deepEqual(field(proposal, "input"), input);
    assert.equal(await session.decideTool("first", { operationId: String(field(proposal, "operationId")), decision: "reject", error: "user denied" }, () => Promise.reject(new Error("must not verify"))), true);
    await assert.rejects(result, /user denied/);
    assert.equal(first.event("tool_call"), undefined);
});

test("视频工作台只接受本站 generation input 对象 ID", () => {
    assert.throws(
        () =>
            toolInputSchemas.workbench_video_generate.parse({
                prompt: "镜头绕过产品",
                references: { images: [{ objectId: "https://untrusted.example/input.png" }] },
            }),
        /uuid/i,
    );
});

test("failed verification consumes the proposal without dispatching", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());
    const result = session.callTool("canvas_create_text_node", { text: "bad permit" });
    const outcome = result.then(() => "resolved", (error) => error instanceof Error ? error.message : String(error));
    const operationId = String(field(first.event("tool_proposal"), "operationId"));

    await assert.rejects(session.decideTool("first", { operationId, decision: "approve" }, async () => {
        throw new Error("invalid permit");
    }), /invalid permit/);
    assert.match(await outcome, /invalid permit/);
    assert.equal(first.event("tool_call"), undefined);
    assert.equal(await session.decideTool("first", { operationId, decision: "approve" }, permit()), false);
});

test("permits cannot be exchanged between concurrent operations", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());
    const results = [
        session.callTool("canvas_create_text_node", { text: "one" }),
        session.callTool("canvas_create_text_node", { text: "two" }),
    ];
    const outcomes = results.map((result) => result.then(() => "resolved", (error) => error instanceof Error ? error.message : String(error)));
    const proposals = first.events("tool_proposal") as PendingToolProposal[];
    assert.equal(proposals.length, 2);

    await assert.rejects(session.decideTool("first", { operationId: proposals[0].operationId, decision: "approve" }, boundPermit(proposals[1])), /binding mismatch/);
    await assert.rejects(session.decideTool("first", { operationId: proposals[1].operationId, decision: "approve" }, boundPermit(proposals[0])), /binding mismatch/);
    assert.deepEqual(await Promise.all(outcomes), ["binding mismatch", "binding mismatch"]);
    assert.equal(first.event("tool_call"), undefined);
});

test("a consumed permit JTI cannot authorize another operation", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());

    const firstResult = session.callTool("canvas_create_text_node", { text: "one" });
    await approve(session, first, "first", "shared-jti");
    const firstCall = first.event("tool_call");
    session.resolveResult("first", { requestId: String(field(firstCall, "requestId")), result: { ok: true } });
    await firstResult;

    const secondResult = session.callTool("canvas_create_text_node", { text: "two" });
    const secondOutcome = secondResult.then(() => "resolved", (error) => error instanceof Error ? error.message : String(error));
    const secondProposal = first.events("tool_proposal").at(-1) as PendingToolProposal;
    await assert.rejects(session.decideTool("first", { operationId: secondProposal.operationId, decision: "approve" }, permit("shared-jti")), /already been used/);
    assert.match(await secondOutcome, /already been used/);
    assert.equal(first.events("tool_call").length, 1);
});

test("concurrent duplicate decisions dispatch an operation only once", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());
    const result = session.callTool("canvas_create_text_node", { text: "once" });
    const proposal = first.event("tool_proposal") as PendingToolProposal;
    let releaseVerification!: () => void;
    const verification = new Promise<void>((resolve) => {
        releaseVerification = resolve;
    });
    const verify = async () => {
        await verification;
        return { jti: "duplicate-decision-jti", expiresAt: Date.now() + 60_000 };
    };

    const decisions = [
        session.decideTool("first", { operationId: proposal.operationId, decision: "approve" }, verify),
        session.decideTool("first", { operationId: proposal.operationId, decision: "approve" }, verify),
    ];
    releaseVerification();
    assert.deepEqual((await Promise.all(decisions)).sort(), [false, true]);
    assert.equal(first.events("tool_call").length, 1);

    const requestId = String(field(first.event("tool_call"), "requestId"));
    assert.equal(session.resolveResult("first", { requestId, result: { ok: true } }), true);
    assert.equal(session.resolveResult("first", { requestId, result: { ok: true } }), false);
    await result;
});

test("a proposal timeout rejects without dispatching", async (t) => {
    const session = new CanvasSession({ requestTimeoutMs: 5 });
    const first = connect(session, "first");
    t.after(() => first.close());
    await assert.rejects(session.callTool("canvas_create_text_node", { text: "too slow" }), /许可超时/);
    assert.equal(first.event("tool_call"), undefined);
});

test("活动网页关闭后回退到仍连接的画布", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.updateState(snapshot("canvas-first"), "first");
    session.updateState(snapshot("canvas-second"), "second");
    session.activateClient("second");
    second.close();

    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-first");
});

test("closing the active client falls back to the most recently focused client", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    const third = connect(session, "third");
    t.after(() => {
        first.close();
        second.close();
        third.close();
    });
    session.updateState(snapshot("canvas-first"), "first");
    session.updateState(snapshot("canvas-second"), "second");
    session.updateState(snapshot("canvas-third"), "third");
    session.activateClient("third");
    session.activateClient("second");
    second.close();

    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-third");
});

test("closing a client rejects its pending tool requests", async () => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const result = session.callTool("canvas_create_text_node", { text: "pending" });
    const proposal = first.event("tool_proposal");
    const requestId = String(field(proposal, "operationId"));
    first.close();

    const outcome = await Promise.race([
        result.then(() => "resolved", (error) => error instanceof Error ? error.message : String(error)),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    if (outcome === "pending") session.resolveResult("first", { requestId, result: null });
    assert.match(outcome, /断开/);
});

test("shared thread events are broadcast with the active thread id", (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });

    session.emitThread("workspace_changed", "thread-2", { activeThreadId: "thread-2" });

    assert.deepEqual(first.event("workspace_changed"), { activeThreadId: "thread-2", threadId: "thread-2" });
    assert.deepEqual(second.event("workspace_changed"), { activeThreadId: "thread-2", threadId: "thread-2" });
});

test("new clients receive the current Codex state and later updates", (t) => {
    const session = new CanvasSession();
    session.setCodexState({ busy: true, threadId: "thread-2", turnId: "turn-1" });
    const client = connect(session, "first");
    t.after(() => client.close());

    assert.deepEqual(field(client.event("hello"), "codex"), { busy: true, threadId: "thread-2", turnId: "turn-1" });

    session.setCodexState({ busy: false });
    assert.deepEqual(client.event("codex_state"), { busy: false, threadId: "thread-2", turnId: "turn-1" });
});

test("Codex approvals are bound to the originating client, thread, and turn", (t) => {
    const session = new CanvasSession({ profileKey: "profile-a" });
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.bindClient("first");
    session.setCodexState({ busy: true, threadId: "thread-a", turnId: "turn-a" });
    session.emitThread("codex_approval", "thread-a", { requestId: "approval-a", turnId: "turn-a" });

    assert.throws(
        () => session.claimCodexApproval("approval-a", { profileKey: "profile-a", clientId: "second" }),
        (error: unknown) => error instanceof CanvasCodexControlError && error.code === "codex_control_scope_mismatch" && error.statusCode === 403,
    );
    assert.throws(
        () => session.claimCodexApproval("approval-a", { profileKey: "profile-a", clientId: "first", threadId: "thread-b", turnId: "turn-a" }),
        (error: unknown) => error instanceof CanvasCodexControlError && error.code === "codex_control_scope_mismatch",
    );
    assert.throws(
        () => session.claimCodexApproval("approval-a", { profileKey: "profile-a", clientId: "first", threadId: "thread-a", turnId: "turn-b" }),
        (error: unknown) => error instanceof CanvasCodexControlError && error.code === "codex_control_scope_mismatch",
    );
    assert.deepEqual(session.claimCodexApproval("approval-a", { profileKey: "profile-a", clientId: "first" }), { threadId: "thread-a", turnId: "turn-a" });
    assert.equal(session.claimCodexApproval("approval-a", { profileKey: "profile-a", clientId: "first" }), null);
    session.finishCodexApproval("approval-a", false);
    assert.deepEqual(session.claimCodexApproval("approval-a", { profileKey: "profile-a", clientId: "first" }), { threadId: "thread-a", turnId: "turn-a" });
    session.finishCodexApproval("approval-a", true);
    assert.equal(session.claimCodexApproval("approval-a", { profileKey: "profile-a", clientId: "first" }), null);
});

test("Codex approval identifiers cannot cross profile sessions or survive a turn change", (t) => {
    const firstProfile = new CanvasSession({ profileKey: "profile-a" });
    const secondProfile = new CanvasSession({ profileKey: "profile-b" });
    const first = connect(firstProfile, "shared-client");
    const second = connect(secondProfile, "shared-client");
    t.after(() => {
        first.close();
        second.close();
    });
    firstProfile.bindClient("shared-client");
    firstProfile.setCodexState({ busy: true, threadId: "thread-a", turnId: "turn-a" });
    firstProfile.emitThread("codex_approval", "thread-a", { requestId: "approval-a", turnId: "turn-a" });

    assert.equal(secondProfile.claimCodexApproval("approval-a", { profileKey: "profile-b", clientId: "shared-client" }), null);
    firstProfile.setCodexState({ busy: true, threadId: "thread-a", turnId: "turn-b" });
    assert.throws(
        () => firstProfile.claimCodexApproval("approval-a", { profileKey: "profile-a", clientId: "shared-client" }),
        (error: unknown) => error instanceof CanvasCodexControlError && error.code === "codex_control_scope_mismatch",
    );
});

test("Codex interrupt scope requires the bound client and exact active thread and turn", (t) => {
    const session = new CanvasSession({ profileKey: "profile-a" });
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.bindClient("first");
    session.setCodexState({ busy: true, threadId: "thread-a", turnId: "turn-a" });

    for (const scope of [
        ["second", "thread-a", "turn-a"],
        ["first", "thread-b", "turn-a"],
        ["first", "thread-a", "turn-b"],
    ] as const) {
        assert.throws(
            () => session.authorizeCodexInterrupt({ profileKey: "profile-a", clientId: scope[0], threadId: scope[1], turnId: scope[2] }),
            (error: unknown) => error instanceof CanvasCodexControlError && error.code === "codex_control_scope_mismatch" && error.statusCode === 403,
        );
    }
    assert.deepEqual(session.authorizeCodexInterrupt({ profileKey: "profile-a", clientId: "first", threadId: "thread-a" }), { threadId: "thread-a", turnId: "turn-a" });
});

test("runtime handoff remains busy until every Codex HTTP operation and canvas tool are released", async () => {
    const session = new CanvasSession();
    const releaseFirst = session.beginCodexOperation();
    const releaseSecond = session.beginCodexOperation();

    assert.equal(session.codexBusy, false);
    assert.equal(session.runtimeBusy, true);
    releaseFirst();
    releaseFirst();
    assert.equal(session.runtimeBusy, true);
    releaseSecond();
    assert.equal(session.runtimeBusy, false);

    session.setCodexState({ busy: true });
    assert.equal(session.runtimeBusy, true);
    session.setCodexState({ busy: false });
    assert.equal(session.runtimeBusy, false);

    const client = connect(session, "pending-client");
    session.activateClient("pending-client");
    const pending = session.callTool("canvas_create_text_node", { text: "pending" });
    assert.equal(session.runtimeBusy, true);
    await approve(session, client, "pending-client");
    assert.equal(session.runtimeBusy, true);
    client.close();
    await assert.rejects(pending, /断开/);
    assert.equal(session.runtimeBusy, false);
});

test("a bound client remains the tool target while focus changes", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.updateState(snapshot("canvas-first"), "first");
    session.updateState(snapshot("canvas-second"), "second");
    session.bindClient("first");
    session.activateClient("second");

    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-first");
    const result = session.callTool("canvas_create_text_node", { text: "bound" });
    await approve(session, first, "first");
    const call = first.event("tool_call");
    assert.equal(second.event("tool_call"), undefined);
    session.resolveResult("first", { requestId: String(field(call, "requestId")), result: { ok: true } });
    assert.deepEqual(await result, { ok: true });

    session.releaseClient("first");
    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-second");
});

test("an external plugin uses the active canvas instead of a web turn binding", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.updateState(snapshot("canvas-first"), "first");
    session.updateState(snapshot("canvas-second"), "second");
    session.bindClient("first");
    session.activateClient("second");

    assert.equal(field(await session.callTool("canvas_get_state", {}, { routing: "active" }), "projectId"), "canvas-second");
});

test("closing the bound client falls back to the active client", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.updateState(snapshot("canvas-first"), "first");
    session.updateState(snapshot("canvas-second"), "second");
    session.bindClient("first");
    session.activateClient("second");
    first.close();

    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-second");
    const result = session.callTool("canvas_create_text_node", { text: "fallback" });
    await approve(session, second, "second");
    const call = second.event("tool_call");
    session.resolveResult("second", { requestId: String(field(call, "requestId")), result: { ok: true } });
    assert.deepEqual(await result, { ok: true });
});

/** 创建用于测试的画布 SSE 连接。 */
function connect(session: CanvasSession, clientId: string) {
    const response = new FakeSseResponse();
    session.openEvents(new URL(`http://127.0.0.1/events?clientId=${clientId}`), response as unknown as ServerResponse);
    return response;
}

/** 创建最小画布快照。 */
function snapshot(projectId: string) {
    return { projectId, title: projectId, nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } };
}

let permitSequence = 0;

async function approve(session: CanvasSession, response: FakeSseResponse, clientId: string, jti = `permit-${++permitSequence}`) {
    const proposal = response.events("tool_proposal").at(-1) as PendingToolProposal | undefined;
    assert.ok(proposal);
    assert.equal(await session.decideTool(clientId, { operationId: proposal.operationId, decision: "approve" }, permit(jti)), true);
    return proposal;
}

function permit(jti = `permit-${++permitSequence}`) {
    return async (_proposal: PendingToolProposal) => ({ jti, expiresAt: Date.now() + 10_000 });
}

function boundPermit(expected: PendingToolProposal) {
    return async (actual: PendingToolProposal) => {
        if (actual.operationId !== expected.operationId || actual.commitment !== expected.commitment) throw new Error("binding mismatch");
        return { jti: `permit-${++permitSequence}`, expiresAt: Date.now() + 10_000 };
    };
}

/** 安全读取测试对象字段。 */
function field(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** 模拟 Node SSE 响应并提供事件读取能力。 */
class FakeSseResponse extends EventEmitter {
    private chunks: string[] = [];

    /** 模拟写入响应头。 */
    writeHead() {
        return this;
    }

    /** 保存写入的 SSE 文本块。 */
    write(chunk: string) {
        this.chunks.push(chunk);
        return true;
    }

    /** 读取指定类型的首个 SSE 事件数据。 */
    event(type: string) {
        return this.events(type)[0];
    }

    /** 读取指定类型的全部 SSE 事件数据。 */
    events(type: string) {
        return this.chunks.flatMap((chunk) => {
            if (!chunk.startsWith(`event: ${type}\n`)) return [];
            const data = chunk.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            return data ? [JSON.parse(data) as unknown] : [];
        });
    }

    /** 触发连接关闭事件。 */
    close() {
        this.emit("close");
    }
}
