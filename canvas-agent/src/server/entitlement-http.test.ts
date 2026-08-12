import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type TicketInput = {
    userId: string;
    profileId: string;
    clientId: string;
    deviceId: string;
    agentVersion: string;
    subject?: string;
    authorizationVersion?: number;
    minimumAgentVersion?: string;
    lifetimeSeconds?: number;
    instanceKey?: string;
};

const PAIRING_CAPABILITIES = [
    "health.v1",
    "pairing.v1",
    "pairing.ticket.v1",
    "pairing.challenge.v1",
    "events.sse-header-ticket.v1",
    "sessions.profile.v1",
    "mcp.tools.v1",
    "entitlement.ed25519.v1",
    "tool.authorization.v1",
];

test("website entitlement remains fail-closed across the local HTTP Agent lifecycle", async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-entitlement-http-"));
    const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    const authority = await FakeEntitlementAuthority.start(() => clock.value);
    const agentPort = await availablePort();
    const agentUrl = `http://127.0.0.1:${agentPort}`;
    const codexHome = path.join(home, "host-codex");
    const hostConfig = 'model_provider = "host-relay"\n[model_providers.host-relay]\nbase_url = "https://host-relay.example/v1"\n';
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), hostConfig);

    const restoreEnvironment = replaceEnvironment({
        CANVAS_AGENT_HOME: home,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        PORT: String(agentPort),
        CANVAS_AGENT_PAIR_ORIGINS: authority.origin,
        CANVAS_AGENT_REQUIRE_ENTITLEMENT: "true",
        CANVAS_AGENT_ENTITLEMENT_PUBLIC_KEY: undefined,
        CANVAS_AGENT_ENTITLEMENT_ISSUER: undefined,
    });

    const { startHttpServer, waitForHttpServer } = await import("./http.js");
    const { canvasCodexRuntimeEnvironment } = await import("../agent/codex-runtime.js");
    const configDir = path.join(home, ".sneeai-agent");
    const fakeCodex = {
        prompts: [] as string[],
        verifiedProfiles: [] as string[],
        stoppedProfiles: [] as string[],
        isolatedEnvironments: [] as Array<Record<string, string | undefined>>,
        startedPermissionModes: [] as string[],
        resolvedApprovals: [] as Array<{ requestId: string; decision: string }>,
        interrupts: [] as Array<{ threadId: string; profileKey: string }>,
        finishBoundTurn: null as (() => void) | null,
    };
    const agent = startHttpServer({
        silent: true,
        runtimeFingerprint: `v1:${"a".repeat(64)}`,
        now: () => clock.value,
        codex: {
            verifyProviderAccess: async (_emit, profileId) => {
                fakeCodex.verifiedProfiles.push(profileId || "");
                const config = readAgentConfig(home);
                if (config.codex?.mode !== "isolated") return;
                const runtimeEnvironment = canvasCodexRuntimeEnvironment(config, { configDir, env: { ...process.env } });
                fakeCodex.isolatedEnvironments.push(runtimeEnvironment);
            },
            stopProfile: async (profileId) => {
                fakeCodex.stoppedProfiles.push(profileId);
                return true;
            },
            startThread: async (_emit, cwd, permissionMode, profileId) => {
                fakeCodex.startedPermissionModes.push(permissionMode || "request");
                return { id: `fake-thread-${profileId}`, cwd: cwd || "" };
            },
            runTurn: async (prompt, _emit, _attachments, options) => {
                fakeCodex.prompts.push(prompt);
                const runOptions = options || {};
                const threadId = runOptions.threadId || "fake-thread";
                if (prompt.includes("BOUND_CONTROL_TURN")) {
                    const turnId = "bound-turn";
                    runOptions.onStart?.();
                    runOptions.onThread?.(threadId);
                    runOptions.onTurn?.(turnId);
                    const localFile = path.join(runOptions.cwd || home, "bound-output.png");
                    fs.writeFileSync(localFile, "bound-image");
                    runOptions.appEmit?.("agent_event", { agent: "codex", type: "test.local_file", threadId, turnId, path: localFile });
                    runOptions.appEmit?.("codex_approval", { requestId: "bound-approval", method: "item/commandExecution/requestApproval", threadId, turnId });
                    await new Promise<void>((resolve) => (fakeCodex.finishBoundTurn = resolve));
                    fakeCodex.finishBoundTurn = null;
                    runOptions.onFinish?.();
                    return;
                }
                runOptions.onThread?.(threadId);
                runOptions.onTurn?.("fake-turn");
                runOptions.onFinish?.();
            },
            resolveApproval: async (requestId, decision) => {
                fakeCodex.resolvedApprovals.push({ requestId, decision });
                return requestId === "bound-approval";
            },
            interruptTurn: async (threadId, profileKey) => {
                fakeCodex.interrupts.push({ threadId: threadId || "", profileKey: profileKey || "" });
                fakeCodex.finishBoundTurn?.();
                return true;
            },
        },
    });
    await waitForHttpServer(agent);
    t.after(async () => {
        await closeServer(agent);
        await authority.close();
        restoreEnvironment();
        fs.rmSync(home, { recursive: true, force: true });
    });

    const publicConfig = await fetch(`${agentUrl}/config`, { headers: { origin: authority.origin } }).then(jsonBody);
    const deviceId = String(publicConfig.deviceId || "");
    const instanceKey = String(publicConfig.instanceKey || "");
    const instancePublicKey = String(publicConfig.instancePublicKey || "");
    const agentVersion = String(publicConfig.buildVersion || "");
    assert.match(deviceId, /^d1:[A-Za-z0-9_-]{43}$/);
    assert.match(instanceKey, /^i1:[A-Za-z0-9_-]{43}$/);
    assert.match(instancePublicKey, /^[A-Za-z0-9_-]{43}$/);
    assert.match(agentVersion, /^\d+\.\d+\.\d+/);
    authority.instanceKey = instanceKey;

    await t.test("pairing proof and entitlement stay bound to the Agent instance seen in config", async () => {
        const binding = ticketInput("identity-user", "identity-client", deviceId, agentVersion);
        const challenge = authority.issuePairingChallenge({ ...binding, instanceKey });
        const proofResponse = await pairingProof(agentUrl, authority.origin, {
            profileId: binding.profileId,
            clientId: binding.clientId,
            challenge,
        });
        const proofBody = await jsonBody(proofResponse);
        assert.equal(proofResponse.status, 200, JSON.stringify(proofBody));
        assert.equal(proofBody.service, "sneeai-agent");
        assert.equal(proofBody.deviceId, deviceId);
        assert.equal(proofBody.instanceKey, instanceKey);
        assert.equal(proofBody.instancePublicKey, instancePublicKey);
        assert.equal(verifyPairingProof(challenge, String(proofBody.proof || ""), instancePublicKey), true);
        assert.equal(JSON.stringify(proofBody).includes(challenge), false);
        assert.equal(fakeCodex.verifiedProfiles.length, 0);

        const replacementInstanceKey = `i1:${crypto.randomBytes(32).toString("base64url")}`;
        const replacementChallenge = authority.issuePairingChallenge({ ...binding, instanceKey: replacementInstanceKey });
        const replacementProof = await pairingProof(agentUrl, authority.origin, {
            profileId: binding.profileId,
            clientId: binding.clientId,
            challenge: replacementChallenge,
        });
        assert.equal(replacementProof.status, 403);
        assert.equal((await jsonBody(replacementProof)).code, "agent_pairing_challenge_invalid");

        const replacementEntitlement = await authority.issue({ ...binding, instanceKey: replacementInstanceKey });
        const replacementPair = await pair(agentUrl, authority.origin, {
            profileId: binding.profileId,
            clientId: binding.clientId,
            entitlement: replacementEntitlement,
        });
        assert.equal(replacementPair.status, 403);
        assert.equal((await jsonBody(replacementPair)).code, "agent_entitlement_binding_mismatch");
        assert.equal(fakeCodex.verifiedProfiles.length, 0);
    });

    await t.test("an optional development entitlement is verified and receives a pairing confirmation", async () => {
        const origin = "http://localhost:3000";
        const profileId = "v1:user:development-user";
        const clientId = "development-client";
        const pairingNonce = crypto.randomBytes(32).toString("base64url");
        const entitlement = authority.signEntitlement(ticketInput("development-user", clientId, deviceId, agentVersion), origin);
        const restoreOptionalEntitlement = replaceEnvironment({
            CANVAS_AGENT_REQUIRE_ENTITLEMENT: undefined,
            CANVAS_AGENT_ENTITLEMENT_PUBLIC_KEY: authority.encodedPublicKey,
            CANVAS_AGENT_ENTITLEMENT_ISSUER: origin,
        });
        try {
            const response = await pair(agentUrl, origin, { profileId, clientId, entitlement, pairingNonce });
            const connection = await jsonBody(response);
            const pairingTicket = String(connection.pairingTicket || "");
            assert.equal(response.status, 200, JSON.stringify(connection));
            assert.equal(Number.isSafeInteger(connection.pairingTicketExpiresAt), true);
            assert.equal(
                verifyPairingConfirmation(pairingNonce, entitlement, pairingTicket, String(connection.pairingConfirmation || ""), instancePublicKey),
                true,
            );
        } finally {
            restoreOptionalEntitlement();
            fakeCodex.verifiedProfiles.length = 0;
        }
    });

    await t.test("unauthorized pair and Codex routes reject every long-lived or missing credential", async () => {
        const noEntitlement = await pair(agentUrl, authority.origin, { profileId: "v1:user:user-a", clientId: "client-a" });
        assert.equal(noEntitlement.status, 403);
        assert.equal((await jsonBody(noEntitlement)).code, "agent_entitlement_required");

        const noCredential = await protectedWorkspace(agentUrl, authority.origin, "", "v1:user:user-a", "client-a");
        assert.notEqual(noCredential.status, 200);

        const persistentToken = readAgentConfig(home).token;
        const persistentCredential = await protectedWorkspace(agentUrl, authority.origin, persistentToken, "v1:user:user-a", "client-a");
        assert.notEqual(persistentCredential.status, 200);

        const valid = await authority.issue(ticketInput("user-a", "client-a", deviceId, agentVersion));
        const forged = forgeSignature(valid);
        const forgedResponse = await pair(agentUrl, authority.origin, { profileId: "v1:user:user-a", clientId: "client-a", entitlement: forged });
        assert.equal(forgedResponse.status, 403);
        assert.equal((await jsonBody(forgedResponse)).code, "agent_entitlement_invalid");
        assert.equal(fakeCodex.verifiedProfiles.length, 0);
    });

    await t.test("signed website, user, profile, client, and device bindings cannot be crossed", async () => {
        const crossUser = await authority.issue({
            ...ticketInput("user-a", "client-a", deviceId, agentVersion),
            subject: "user-b",
        });
        const crossUserResponse = await pair(agentUrl, authority.origin, { profileId: "v1:user:user-a", clientId: "client-a", entitlement: crossUser });
        assert.equal(crossUserResponse.status, 403);
        assert.equal((await jsonBody(crossUserResponse)).code, "agent_entitlement_binding_mismatch");

        const valid = await authority.issue(ticketInput("user-a", "client-a", deviceId, agentVersion));
        const wrongProfile = await pair(agentUrl, authority.origin, { profileId: "v1:user:user-b", clientId: "client-a", entitlement: valid });
        assert.equal(wrongProfile.status, 403);
        const wrongClient = await pair(agentUrl, authority.origin, { profileId: "v1:user:user-a", clientId: "client-b", entitlement: valid });
        assert.equal(wrongClient.status, 403);

        const wrongDeviceToken = await authority.issue({ ...ticketInput("user-a", "client-a", `d1:${"z".repeat(43)}`, agentVersion) });
        const wrongDevice = await pair(agentUrl, authority.origin, { profileId: "v1:user:user-a", clientId: "client-a", entitlement: wrongDeviceToken });
        assert.equal(wrongDevice.status, 403);

        const wrongOrigin = await pair(agentUrl, authority.origin.replace("127.0.0.1", "localhost"), { profileId: "v1:user:user-a", clientId: "client-a", entitlement: valid });
        assert.equal(wrongOrigin.status, 403);
    });

    await t.test("authority outages, expiry, and minimum Agent versions fail closed", async () => {
        const unavailableToken = await authority.issue(ticketInput("outage-user", "outage-client", deviceId, agentVersion));
        authority.publicKeyAvailable = false;
        const unavailable = await pair(agentUrl, authority.origin, { profileId: "v1:user:outage-user", clientId: "outage-client", entitlement: unavailableToken });
        authority.publicKeyAvailable = true;
        assert.equal(unavailable.status, 503);
        assert.equal((await jsonBody(unavailable)).code, "agent_entitlement_authority_unavailable");

        const tooNew = await authority.issue({ ...ticketInput("version-user", "version-client", deviceId, agentVersion), minimumAgentVersion: "999.0.0" });
        const oldAgent = await pair(agentUrl, authority.origin, { profileId: "v1:user:version-user", clientId: "version-client", entitlement: tooNew });
        assert.equal(oldAgent.status, 403);
        assert.equal((await jsonBody(oldAgent)).code, "agent_entitlement_agent_version_too_old");

        const short = await authority.issue({ ...ticketInput("expired-user", "expired-client", deviceId, agentVersion), lifetimeSeconds: 30 });
        clock.advance(31_000);
        const expired = await pair(agentUrl, authority.origin, { profileId: "v1:user:expired-user", clientId: "expired-client", entitlement: short });
        assert.equal(expired.status, 403);
        assert.equal((await jsonBody(expired)).code, "agent_entitlement_expired");
    });

    let firstTicket = "";
    let renewedTicket = "";
    let renewalProfileKey = "";
    await t.test("a valid lease carries local Codex traffic without sending conversation content to the website", async () => {
        const entitlement = await authority.issue({ ...ticketInput("renew-user", "renew-client", deviceId, agentVersion), lifetimeSeconds: 120 });
        const pairingNonce = crypto.randomBytes(32).toString("base64url");
        const response = await pair(agentUrl, authority.origin, { profileId: "v1:user:renew-user", clientId: "renew-client", entitlement, pairingNonce });
        const connection = await jsonBody(response);
        assert.equal(response.status, 200, JSON.stringify(connection));
        firstTicket = String(connection.token || "");
        renewalProfileKey = String(connection.profileKey || "");
        assert.match(firstTicket, /^cat1\./);
        const pairingConfirmation = String(connection.pairingConfirmation || "");
        assert.equal(connection.instanceKey, instanceKey);
        assert.equal(connection.instancePublicKey, instancePublicKey);
        assert.equal(verifyPairingConfirmation(pairingNonce, entitlement, firstTicket, pairingConfirmation, instancePublicKey), true);
        const forgedNonce = `${pairingNonce.slice(0, -1)}${pairingNonce.endsWith("A") ? "B" : "A"}`;
        assert.equal(verifyPairingConfirmation(forgedNonce, entitlement, firstTicket, pairingConfirmation, instancePublicKey), false);
        assert.equal(verifyPairingConfirmation(pairingNonce, entitlement, `${firstTicket}-forged`, pairingConfirmation, instancePublicKey), false);

        const workspace = await protectedWorkspace(agentUrl, authority.origin, firstTicket, "v1:user:renew-user", "renew-client");
        assert.equal(workspace.status, 200);

        const startsBeforeFullRequest = fakeCodex.startedPermissionModes.length;
        const promptsBeforeFullRequest = fakeCodex.prompts.length;
        const forbiddenFullTurn = await fetch(`${agentUrl}/agent/codex/turn`, {
            method: "POST",
            headers: agentHeaders(authority.origin, firstTicket, "v1:user:renew-user", "renew-client", true),
            body: JSON.stringify({ prompt: "must not execute", permissionMode: "full" }),
        });
        const forbiddenFullBody = await jsonBody(forbiddenFullTurn);
        assert.equal(forbiddenFullTurn.status, 403, JSON.stringify(forbiddenFullBody));
        assert.equal(forbiddenFullBody.code, "full_permission_disabled");
        assert.equal(fakeCodex.startedPermissionModes.length, startsBeforeFullRequest);
        assert.equal(fakeCodex.prompts.length, promptsBeforeFullRequest);

        const outsideImage = path.join(home, "outside-workspace.png");
        fs.writeFileSync(outsideImage, "private-image");
        const rawPathImage = await fetch(`${agentUrl}/agent/local-image`, {
            method: "POST",
            headers: agentHeaders(authority.origin, firstTicket, "v1:user:renew-user", "renew-client", true),
            body: JSON.stringify({ path: outsideImage }),
        });
        const rawPathImageBody = await jsonBody(rawPathImage);
        assert.equal(rawPathImage.status, 400, JSON.stringify(rawPathImageBody));
        assert.equal(rawPathImageBody.code, "local_file_handle_invalid");

        const websiteRequestsBeforeTurn = authority.requests.length;
        const secretPrompt = "PRIVATE-CODEX-PROMPT-DO-NOT-UPLOAD";
        const turn = await fetch(`${agentUrl}/agent/codex/turn`, {
            method: "POST",
            headers: agentHeaders(authority.origin, firstTicket, "v1:user:renew-user", "renew-client", true),
            body: JSON.stringify({ prompt: secretPrompt, messageText: secretPrompt }),
        });
        assert.equal(turn.status, 200, JSON.stringify(await jsonBody(turn)));
        assert.ok(fakeCodex.prompts.some((prompt) => prompt.includes(secretPrompt)));
        assert.equal(authority.requests.length, websiteRequestsBeforeTurn);
        assert.equal(JSON.stringify(authority.requests).includes(secretPrompt), false);

        const noTicket = await protectedWorkspace(agentUrl, authority.origin, "", "v1:user:renew-user", "renew-client");
        assert.equal(noTicket.status, 401);
        const persistent = await protectedWorkspace(agentUrl, authority.origin, readAgentConfig(home).token, "v1:user:renew-user", "renew-client");
        assert.equal(persistent.status, 401);
        const wrongProfile = await protectedWorkspace(agentUrl, authority.origin, firstTicket, "v1:user:other-user", "renew-client");
        assert.equal(wrongProfile.status, 401);
        const wrongClient = await protectedWorkspace(agentUrl, authority.origin, firstTicket, "v1:user:renew-user", "other-client");
        assert.equal(wrongClient.status, 401);
        const wrongOrigin = await protectedWorkspace(agentUrl, authority.origin.replace("127.0.0.1", "localhost"), firstTicket, "v1:user:renew-user", "renew-client");
        assert.equal(wrongOrigin.status, 403);
    });

    await t.test("Codex controls and local file handles stay bound to profile, client, thread, and turn", async () => {
        const profileId = "v1:user:renew-user";
        const clientId = "renew-client";
        const crossProfileId = "v1:user:cross-user";
        const crossClientId = "cross-client";
        const crossEntitlement = await authority.issue({ ...ticketInput("cross-user", crossClientId, deviceId, agentVersion), lifetimeSeconds: 120 });
        const crossPair = await pair(agentUrl, authority.origin, { profileId: crossProfileId, clientId: crossClientId, entitlement: crossEntitlement });
        const crossConnection = await jsonBody(crossPair);
        assert.equal(crossPair.status, 200, JSON.stringify(crossConnection));
        const crossTicket = String(crossConnection.token || "");

        const eventTicketResponse = await fetch(`${agentUrl}/agent/events-ticket`, {
            method: "POST",
            headers: agentHeaders(authority.origin, firstTicket, profileId, clientId, true),
            body: JSON.stringify({ clientId }),
        });
        const eventTicketBody = await jsonBody(eventTicketResponse);
        assert.equal(eventTicketResponse.status, 200, JSON.stringify(eventTicketBody));
        const eventsResponse = await fetch(`${agentUrl}/events`, {
            headers: agentHeaders(authority.origin, String(eventTicketBody.ticket || ""), profileId, clientId, false, true),
        });
        assert.equal(eventsResponse.status, 200);
        const events = new SseEventReader(eventsResponse);
        await events.next("hello");

        try {
            const turnResponse = await fetch(`${agentUrl}/agent/codex/turn`, {
                method: "POST",
                headers: agentHeaders(authority.origin, firstTicket, profileId, clientId, true),
                body: JSON.stringify({ prompt: "BOUND_CONTROL_TURN" }),
            });
            const turnBody = await jsonBody(turnResponse);
            assert.equal(turnResponse.status, 200, JSON.stringify(turnBody));
            const threadId = String(turnBody.threadId || "");
            assert.ok(threadId);

            const localEvent = await events.next("agent_event");
            const localHandle = String(localEvent.path || "");
            assert.match(localHandle, /^canvas-agent-file:\/\/local\/lf1_[A-Za-z0-9_-]{43}\//);
            assert.equal(localHandle.includes(home), false);
            const approval = await events.next("codex_approval");
            assert.equal(approval.requestId, "bound-approval");
            assert.equal(approval.threadId, threadId);
            assert.equal(approval.turnId, "bound-turn");

            const busyFullTurn = await fetch(`${agentUrl}/agent/codex/turn`, {
                method: "POST",
                headers: agentHeaders(authority.origin, firstTicket, profileId, clientId, true),
                body: JSON.stringify({ prompt: "must not execute while busy", permissionMode: "full" }),
            });
            assert.equal(busyFullTurn.status, 403);
            assert.equal((await jsonBody(busyFullTurn)).code, "full_permission_disabled");

            const crossFile = await fetch(`${agentUrl}/agent/local-image`, {
                method: "POST",
                headers: agentHeaders(authority.origin, crossTicket, crossProfileId, crossClientId, true),
                body: JSON.stringify({ handle: localHandle }),
            });
            assert.equal(crossFile.status, 403);
            assert.equal((await jsonBody(crossFile)).code, "local_file_handle_forbidden");
            const authorizedFile = await fetch(`${agentUrl}/agent/local-image`, {
                method: "POST",
                headers: agentHeaders(authority.origin, firstTicket, profileId, clientId, true),
                body: JSON.stringify({ handle: localHandle }),
            });
            assert.equal(authorizedFile.status, 200);
            assert.equal(await authorizedFile.text(), "bound-image");

            const crossApproval = await postCodexControl(agentUrl, authority.origin, crossTicket, crossProfileId, crossClientId, "/agent/codex/approval", { requestId: "bound-approval", decision: "accept" });
            assert.equal(crossApproval.status, 409);
            const wrongClientApproval = await postCodexControl(agentUrl, authority.origin, firstTicket, profileId, clientId, "/agent/codex/approval", { requestId: "bound-approval", decision: "accept", clientId: "other-client" });
            assert.equal(wrongClientApproval.status, 403);
            const wrongThreadApproval = await postCodexControl(agentUrl, authority.origin, firstTicket, profileId, clientId, "/agent/codex/approval", { requestId: "bound-approval", decision: "accept", threadId: "other-thread" });
            assert.equal(wrongThreadApproval.status, 403);
            const wrongTurnApproval = await postCodexControl(agentUrl, authority.origin, firstTicket, profileId, clientId, "/agent/codex/approval", { requestId: "bound-approval", decision: "accept", turnId: "other-turn" });
            assert.equal(wrongTurnApproval.status, 403);
            assert.equal(fakeCodex.resolvedApprovals.length, 0);

            const accepted = await postCodexControl(agentUrl, authority.origin, firstTicket, profileId, clientId, "/agent/codex/approval", { requestId: "bound-approval", decision: "accept", threadId, turnId: "bound-turn" });
            assert.equal(accepted.status, 200, JSON.stringify(await jsonBody(accepted)));
            const replay = await postCodexControl(agentUrl, authority.origin, firstTicket, profileId, clientId, "/agent/codex/approval", { requestId: "bound-approval", decision: "decline" });
            assert.equal(replay.status, 409);
            assert.deepEqual(fakeCodex.resolvedApprovals, [{ requestId: "bound-approval", decision: "accept" }]);

            const crossInterrupt = await postCodexControl(agentUrl, authority.origin, crossTicket, crossProfileId, crossClientId, "/agent/codex/interrupt", { threadId, turnId: "bound-turn" });
            assert.equal(crossInterrupt.status, 403);
            const wrongThreadInterrupt = await postCodexControl(agentUrl, authority.origin, firstTicket, profileId, clientId, "/agent/codex/interrupt", { threadId: "other-thread", turnId: "bound-turn" });
            assert.equal(wrongThreadInterrupt.status, 403);
            const wrongTurnInterrupt = await postCodexControl(agentUrl, authority.origin, firstTicket, profileId, clientId, "/agent/codex/interrupt", { threadId, turnId: "other-turn" });
            assert.equal(wrongTurnInterrupt.status, 403);
            assert.equal(fakeCodex.interrupts.length, 0);

            const interrupted = await postCodexControl(agentUrl, authority.origin, firstTicket, profileId, clientId, "/agent/codex/interrupt", { threadId, turnId: "bound-turn" });
            assert.equal(interrupted.status, 200, JSON.stringify(await jsonBody(interrupted)));
            assert.deepEqual(fakeCodex.interrupts, [{ threadId, profileKey: renewalProfileKey }]);
        } finally {
            fakeCodex.finishBoundTurn?.();
            await events.close();
        }
    });

    await t.test("a signed one-shot permit dispatches its proposal exactly once", async () => {
        const profileId = "v1:user:renew-user";
        const clientId = "renew-client";
        const eventTicketResponse = await fetch(`${agentUrl}/agent/events-ticket`, {
            method: "POST",
            headers: agentHeaders(authority.origin, firstTicket, profileId, clientId, true),
            body: JSON.stringify({ clientId }),
        });
        const eventTicketBody = await jsonBody(eventTicketResponse);
        assert.equal(eventTicketResponse.status, 200, JSON.stringify(eventTicketBody));
        const eventsResponse = await fetch(`${agentUrl}/events`, {
            headers: agentHeaders(authority.origin, String(eventTicketBody.ticket || ""), profileId, clientId, false, true),
        });
        assert.equal(eventsResponse.status, 200);
        const events = new SseEventReader(eventsResponse);
        await events.next("hello");

        try {
            const toolResponsePromise = fetch(`${agentUrl}/api/tools`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-canvas-agent-token": readAgentConfig(home).token,
                    "x-canvas-profile-id": renewalProfileKey,
                    "x-canvas-agent-protocol-version": "1",
                    "x-canvas-agent-capabilities": "mcp.tools.v1,tool.authorization.v1",
                },
                body: JSON.stringify({ name: "canvas_create_text_node", input: { text: "authorized once" } }),
            });
            const proposal = await events.next("tool_proposal");
            const operationId = String(proposal.operationId || "");
            const commitment = String(proposal.commitment || "");
            assert.match(operationId, /^[0-9a-f-]{36}$/i);
            assert.match(commitment, /^[A-Za-z0-9_-]{43}$/);
            assert.equal(proposal.name, "canvas_create_text_node");
            assert.deepEqual(proposal.input, { text: "authorized once" });
            assert.equal(events.count("tool_call"), 0);

            const wrongClientDecision = await fetch(`${agentUrl}/canvas/tool-decision`, {
                method: "POST",
                headers: agentHeaders(authority.origin, firstTicket, profileId, "other-client", true),
                body: JSON.stringify({ operationId, decision: "reject", error: "wrong client" }),
            });
            assert.equal(wrongClientDecision.status, 401);
            const persistentTokenDecision = await fetch(`${agentUrl}/canvas/tool-decision`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-canvas-agent-token": readAgentConfig(home).token,
                    "x-canvas-profile-id": renewalProfileKey,
                    "x-canvas-client-id": clientId,
                },
                body: JSON.stringify({ operationId, decision: "reject", error: "not a pairing ticket" }),
            });
            assert.equal(persistentTokenDecision.status, 401);
            assert.equal(events.count("tool_call"), 0);

            const earlyResult = await fetch(`${agentUrl}/canvas/result`, {
                method: "POST",
                headers: agentHeaders(authority.origin, firstTicket, profileId, clientId, true),
                body: JSON.stringify({ requestId: operationId, result: { tooEarly: true } }),
            });
            assert.equal(earlyResult.status, 409);

            const permit = authority.issueAction({
                subject: "renew-user",
                profileId,
                clientId,
                deviceId,
                authorizationVersion: 1,
                operationId,
                commitment,
            });
            const approved = await fetch(`${agentUrl}/canvas/tool-decision`, {
                method: "POST",
                headers: agentHeaders(authority.origin, firstTicket, profileId, clientId, true),
                body: JSON.stringify({ operationId, decision: "approve", authorization: permit.token }),
            });
            assert.equal(approved.status, 200, JSON.stringify(await jsonBody(approved)));

            const call = await events.next("tool_call");
            assert.equal(call.requestId, operationId);
            assert.equal(call.name, "canvas_apply_ops");
            assert.equal(call.authorizationJti, permit.jti);
            assert.equal("authorization" in call, false);
            assert.equal(JSON.stringify(call).includes(permit.token), false);

            const replay = await fetch(`${agentUrl}/canvas/tool-decision`, {
                method: "POST",
                headers: agentHeaders(authority.origin, firstTicket, profileId, clientId, true),
                body: JSON.stringify({ operationId, decision: "approve", authorization: permit.token }),
            });
            assert.equal(replay.status, 409);
            assert.equal(events.count("tool_call"), 1);

            const resultResponse = await fetch(`${agentUrl}/canvas/result`, {
                method: "POST",
                headers: agentHeaders(authority.origin, firstTicket, profileId, clientId, true),
                body: JSON.stringify({ requestId: operationId, result: { created: true } }),
            });
            assert.equal(resultResponse.status, 200);
            const toolResponse = await toolResponsePromise;
            assert.equal(toolResponse.status, 200);
            assert.deepEqual(await jsonBody(toolResponse), { ok: true, result: { created: true } });
        } finally {
            await events.close();
        }
    });

    await t.test("renewal extends only the matching lease and old local tickets retain their own deadline", async () => {
        clock.advance(60_000);
        const renewedEntitlement = await authority.issue({ ...ticketInput("renew-user", "renew-client", deviceId, agentVersion), lifetimeSeconds: 120 });
        const response = await pair(agentUrl, authority.origin, { profileId: "v1:user:renew-user", clientId: "renew-client", entitlement: renewedEntitlement });
        const connection = await jsonBody(response);
        assert.equal(response.status, 200, JSON.stringify(connection));
        renewedTicket = String(connection.token || "");
        assert.notEqual(renewedTicket, firstTicket);
        assert.equal((await protectedWorkspace(agentUrl, authority.origin, firstTicket, "v1:user:renew-user", "renew-client")).status, 200);
        assert.equal((await protectedWorkspace(agentUrl, authority.origin, renewedTicket, "v1:user:renew-user", "renew-client")).status, 200);

        clock.advance(61_000);
        assert.equal((await protectedWorkspace(agentUrl, authority.origin, firstTicket, "v1:user:renew-user", "renew-client")).status, 401);
        assert.equal((await protectedWorkspace(agentUrl, authority.origin, renewedTicket, "v1:user:renew-user", "renew-client")).status, 200);
    });

    await t.test("server revocation stops renewal and the remaining signed lease expires locally", async () => {
        authority.revoke("renew-user");
        const deniedRenewal = await authority.requestTicket(ticketInput("renew-user", "renew-client", deviceId, agentVersion));
        assert.equal(deniedRenewal.status, 403);

        clock.advance(60_000);
        const expired = await protectedWorkspace(agentUrl, authority.origin, renewedTicket, "v1:user:renew-user", "renew-client");
        assert.equal(expired.status, 401);
        assert.ok(fakeCodex.stoppedProfiles.includes(renewalProfileKey));
    });

    await t.test("a higher server authorization version supersedes every older local ticket", async () => {
        const first = await authority.issue(ticketInput("rotate-user", "rotate-client", deviceId, agentVersion));
        const firstPair = await pair(agentUrl, authority.origin, { profileId: "v1:user:rotate-user", clientId: "rotate-client", entitlement: first });
        const firstConnection = await jsonBody(firstPair);
        assert.equal(firstPair.status, 200, JSON.stringify(firstConnection));

        const second = await authority.issue({ ...ticketInput("rotate-user", "rotate-client", deviceId, agentVersion), authorizationVersion: 2 });
        const secondPair = await pair(agentUrl, authority.origin, { profileId: "v1:user:rotate-user", clientId: "rotate-client", entitlement: second });
        const secondConnection = await jsonBody(secondPair);
        assert.equal(secondPair.status, 200, JSON.stringify(secondConnection));
        assert.equal((await protectedWorkspace(agentUrl, authority.origin, String(firstConnection.token), "v1:user:rotate-user", "rotate-client")).status, 401);
        assert.equal((await protectedWorkspace(agentUrl, authority.origin, String(secondConnection.token), "v1:user:rotate-user", "rotate-client")).status, 200);
    });

    await t.test("independent KapeAI mode stores only its private key and leaves inherited Codex untouched", async () => {
        const entitlement = await authority.issue(ticketInput("kape-user", "kape-client", deviceId, agentVersion));
        const missingKey = await pair(agentUrl, authority.origin, {
            profileId: "v1:user:kape-user",
            clientId: "kape-client",
            entitlement,
            mode: "isolated",
        });
        assert.equal(missingKey.status, 428);
        assert.equal((await jsonBody(missingKey)).code, "relay_api_key_required");

        const apiKey = "kape-test-private-key";
        const response = await pair(agentUrl, authority.origin, {
            profileId: "v1:user:kape-user",
            clientId: "kape-client",
            entitlement,
            mode: "isolated",
            apiKey,
        });
        const connection = await jsonBody(response);
        assert.equal(response.status, 200, JSON.stringify(connection));
        assert.equal(connection.codexMode, "isolated");
        assert.equal("relayBaseUrl" in connection, false);
        assert.equal(connection.hasRelayApiKey, true);
        assert.equal(JSON.stringify(connection).includes(apiKey), false);

        assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), hostConfig);
        const agentConfigText = fs.readFileSync(path.join(configDir, "sneeai-agent.json"), "utf8");
        assert.equal(agentConfigText.includes(apiKey), false);
        const isolatedHome = path.join(configDir, "codex-runtime");
        assert.equal(fs.readFileSync(path.join(isolatedHome, "kapeai-api-key"), "utf8").trim(), apiKey);
        assert.match(fs.readFileSync(path.join(isolatedHome, "config.toml"), "utf8"), /base_url = "https:\/\/api\.kapeai\.cn\/v1"/);
        const isolatedEnvironment = fakeCodex.isolatedEnvironments.at(-1);
        assert.equal(isolatedEnvironment?.CODEX_HOME, isolatedHome);
        assert.equal(isolatedEnvironment?.OPENAI_BASE_URL, undefined);
        assert.equal(isolatedEnvironment?.OPENAI_API_KEY, undefined);
        assert.equal(JSON.stringify(authority.requests).includes(apiKey), false);
    });
});

function ticketInput(userId: string, clientId: string, deviceId: string, agentVersion: string): TicketInput {
    return { userId, profileId: `v1:user:${userId}`, clientId, deviceId, agentVersion };
}

async function pair(
    agentUrl: string,
    origin: string,
    input: { profileId: string; clientId: string; entitlement?: string; mode?: "inherit" | "isolated"; apiKey?: string; pairingNonce?: string },
) {
    const headers = new Headers({ origin, "content-type": "application/json" });
    if (input.entitlement) headers.set("x-canvas-agent-entitlement", input.entitlement);
    return await fetch(`${agentUrl}/pair`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            profileId: input.profileId,
            clientId: input.clientId,
            pairingNonce: input.pairingNonce || crypto.randomBytes(32).toString("base64url"),
            protocolVersion: 1,
            capabilities: PAIRING_CAPABILITIES,
            ...(input.mode ? { mode: input.mode } : {}),
            ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        }),
    });
}

function pairingProof(agentUrl: string, origin: string, input: { profileId: string; clientId: string; challenge: string }) {
    return fetch(`${agentUrl}/pairing/proof`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
            profileId: input.profileId,
            clientId: input.clientId,
            challenge: input.challenge,
            protocolVersion: 1,
            capabilities: PAIRING_CAPABILITIES,
        }),
    });
}

function verifyPairingProof(challenge: string, proof: string, instancePublicKey: string) {
    const publicKey = crypto.createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(instancePublicKey, "base64url")]),
        format: "der",
        type: "spki",
    });
    return crypto.verify(null, Buffer.from(`sneeai-agent-pairing-proof-v1\0${challenge}`), publicKey, Buffer.from(proof, "base64url"));
}

function verifyPairingConfirmation(nonce: string, entitlement: string, pairingTicket: string, confirmation: string, instancePublicKey: string) {
    const publicKey = crypto.createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(instancePublicKey, "base64url")]),
        format: "der",
        type: "spki",
    });
    return crypto.verify(
        null,
        Buffer.from(`sneeai-agent-pairing-confirmation-v1\0${nonce}\0${entitlement}\0${pairingTicket}`),
        publicKey,
        Buffer.from(confirmation, "base64url"),
    );
}

function protectedWorkspace(agentUrl: string, origin: string, ticket: string, profileId: string, clientId: string) {
    return fetch(`${agentUrl}/agent/codex/workspace`, { headers: agentHeaders(origin, ticket, profileId, clientId) });
}

function postCodexControl(agentUrl: string, origin: string, ticket: string, profileId: string, clientId: string, route: string, body: Record<string, unknown>) {
    return fetch(`${agentUrl}${route}`, {
        method: "POST",
        headers: agentHeaders(origin, ticket, profileId, clientId, true),
        body: JSON.stringify(body),
    });
}

function agentHeaders(origin: string, ticket: string, profileId: string, clientId: string, json = false, eventTicket = false) {
    const headers = new Headers({ origin, "x-canvas-profile-id": profileId, "x-canvas-client-id": clientId });
    if (ticket) headers.set(eventTicket ? "x-canvas-agent-ticket" : "x-canvas-agent-token", ticket);
    if (json) headers.set("content-type", "application/json");
    return headers;
}

function forgeSignature(token: string) {
    const parts = token.split(".");
    const first = parts[2][0];
    parts[2] = `${first === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    return parts.join(".");
}

async function jsonBody(response: Response) {
    return await response.json() as Record<string, unknown>;
}

function readAgentConfig(home: string) {
    return JSON.parse(fs.readFileSync(path.join(home, ".sneeai-agent", "sneeai-agent.json"), "utf8")) as {
        url: string;
        token: string;
        codex?: { mode?: "inherit" | "isolated" };
    };
}

class FakeClock {
    constructor(public value: number) {}

    advance(milliseconds: number) {
        this.value += milliseconds;
    }
}

class FakeEntitlementAuthority {
    readonly requests: Array<{ method: string; url: string; body: string }> = [];
    readonly revokedUsers = new Set<string>();
    publicKeyAvailable = true;
    instanceKey = "";

    private constructor(
        readonly server: ReturnType<typeof createServer>,
        readonly origin: string,
        private readonly privateKey: crypto.KeyObject,
        private readonly publicKey: string,
        private readonly keyId: string,
        private readonly now: () => number,
    ) {}

    static async start(now: () => number) {
        const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
        const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
        const rawPublicKey = publicDer.subarray(publicDer.length - 32);
        const encodedPublicKey = rawPublicKey.toString("base64url");
        const keyId = crypto.createHash("sha256").update(rawPublicKey).digest().subarray(0, 12).toString("base64url");
        let authority: FakeEntitlementAuthority;
        const server = createServer((req, res) => {
            void authority.handle(req, res).catch((error) => {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
            });
        });
        await listen(server, 0);
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("fake entitlement authority did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        authority = new FakeEntitlementAuthority(server, origin, privateKey, encodedPublicKey, keyId, now);
        return authority;
    }

    get encodedPublicKey() {
        return this.publicKey;
    }

    signEntitlement(input: TicketInput, origin = this.origin) {
        const issuedAt = Math.floor(this.now() / 1000);
        const expiresAt = issuedAt + (input.lifetimeSeconds || 120);
        const header = encode({ alg: "EdDSA", typ: "JWT", kid: this.keyId });
        const claims = encode({
            version: 1,
            iss: origin,
            aud: "sneeai-agent",
            sub: input.subject || input.userId,
            scope: "agent:connect",
            origin,
            profile_id: input.profileId,
            client_id: input.clientId,
            device_id: input.deviceId,
            instance_key: input.instanceKey || this.instanceKey,
            authorization_version: input.authorizationVersion || 1,
            minimum_agent_version: input.minimumAgentVersion || input.agentVersion,
            iat: issuedAt,
            exp: expiresAt,
            jti: crypto.randomBytes(16).toString("base64url"),
        });
        const unsigned = `${header}.${claims}`;
        return `${unsigned}.${crypto.sign(null, Buffer.from(unsigned), this.privateKey).toString("base64url")}`;
    }

    async issue(input: TicketInput) {
        const response = await this.requestTicket(input);
        const body = await jsonBody(response);
        assert.equal(response.status, 200, JSON.stringify(body));
        return String(body.token || "");
    }

    requestTicket(input: TicketInput) {
        return fetch(`${this.origin}/api/v1/agent/entitlement/ticket`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
        });
    }

    issuePairingChallenge(input: TicketInput & { instanceKey: string }) {
        const issuedAt = Math.floor(this.now() / 1000);
        const header = encode({ alg: "EdDSA", typ: "agent-pairing-challenge+jwt", kid: this.keyId });
        const claims = encode({
            version: 1,
            iss: this.origin,
            aud: "sneeai-agent-pairing",
            sub: input.userId,
            scope: "agent:pairing:prove",
            origin: this.origin,
            profile_id: input.profileId,
            client_id: input.clientId,
            device_id: input.deviceId,
            agent_version: input.agentVersion,
            instance_key: input.instanceKey,
            iat: issuedAt,
            exp: issuedAt + 30,
            jti: crypto.randomBytes(16).toString("base64url"),
        });
        const unsigned = `${header}.${claims}`;
        return `${unsigned}.${crypto.sign(null, Buffer.from(unsigned), this.privateKey).toString("base64url")}`;
    }

    revoke(userId: string) {
        this.revokedUsers.add(userId);
    }

    issueAction(input: {
        subject: string;
        profileId: string;
        clientId: string;
        deviceId: string;
        authorizationVersion: number;
        operationId: string;
        commitment: string;
    }) {
        const issuedAt = Math.floor(this.now() / 1000);
        const jti = crypto.randomBytes(16).toString("base64url");
        const header = encode({ alg: "EdDSA", typ: "agent-action+jwt", kid: this.keyId });
        const claims = encode({
            version: 1,
            iss: this.origin,
            aud: "sneeai-agent-action",
            scope: "agent:tool:execute",
            sub: input.subject,
            origin: this.origin,
            profile_id: input.profileId,
            client_id: input.clientId,
            device_id: input.deviceId,
            authorization_version: input.authorizationVersion,
            operation_id: input.operationId,
            operation_class: "agent_write",
            commitment: input.commitment,
            iat: issuedAt,
            exp: issuedAt + 10,
            jti,
        });
        const unsigned = `${header}.${claims}`;
        const signature = crypto.sign(null, Buffer.from(unsigned), this.privateKey).toString("base64url");
        return { token: `${unsigned}.${signature}`, jti };
    }

    close() {
        return closeServer(this.server);
    }

    private async handle(req: IncomingMessage, res: ServerResponse<IncomingMessage>) {
        const body = await readBody(req);
        this.requests.push({ method: req.method || "", url: req.url || "", body });
        res.setHeader("content-type", "application/json");
        if (req.method === "GET" && req.url === "/api/v1/agent/entitlement/public-key") {
            if (!this.publicKeyAvailable) {
                res.statusCode = 503;
                return void res.end(JSON.stringify({ error: "key unavailable" }));
            }
            return void res.end(JSON.stringify({ issuer: this.origin, key_id: this.keyId, algorithm: "EdDSA", public_key: this.publicKey }));
        }
        if (req.method === "POST" && req.url === "/api/v1/agent/entitlement/ticket") {
            const input = JSON.parse(body) as TicketInput;
            if (this.revokedUsers.has(input.userId)) {
                res.statusCode = 403;
                return void res.end(JSON.stringify({ code: "agent_entitlement_revoked" }));
            }
            const token = this.signEntitlement(input);
            const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp: number };
            return void res.end(JSON.stringify({ token, expiresAt: claims.exp * 1000 }));
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
    }
}

class SseEventReader {
    private readonly reader;
    private readonly decoder = new TextDecoder();
    private buffer = "";
    private seen: Array<{ type: string; data: Record<string, unknown> }> = [];

    constructor(response: Response) {
        if (!response.body) throw new Error("SSE response has no body");
        this.reader = response.body.getReader();
    }

    async next(type: string) {
        while (true) {
            const event = this.takeEvent();
            if (event) {
                this.seen.push(event);
                if (event.type === type) return event.data;
                continue;
            }
            const chunk = await this.reader.read();
            if (chunk.done) throw new Error(`SSE closed before ${type}`);
            this.buffer += this.decoder.decode(chunk.value, { stream: true });
        }
    }

    count(type: string) {
        return this.seen.filter((event) => event.type === type).length;
    }

    close() {
        return this.reader.cancel();
    }

    private takeEvent() {
        const boundary = this.buffer.indexOf("\n\n");
        if (boundary < 0) return null;
        const block = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        const type = block.split("\n").find((line) => line.startsWith("event: "))?.slice(7) || "";
        const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6) || "{}";
        return { type, data: JSON.parse(data) as Record<string, unknown> };
    }
}

function encode(value: unknown) {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function readBody(request: NodeJS.ReadableStream) {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.once("error", reject);
    });
}

function replaceEnvironment(values: Record<string, string | undefined>) {
    const previous = new Map<string, string | undefined>();
    Object.entries(values).forEach(([key, value]) => {
        previous.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
    return () => previous.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
}

async function availablePort() {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unable to reserve test port");
    const port = address.port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}

function listen(server: ReturnType<typeof createServer>, port: number) {
    return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
}

function closeServer(server: ReturnType<typeof createServer>) {
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
