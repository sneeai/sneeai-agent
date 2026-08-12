import assert from "node:assert/strict";
import test from "node:test";

import { createAgentTicket, EventTicketReplayGuard, verifyAgentTicket } from "./pairing-ticket.js";

const secret = "local-connect-token";
const binding = { origin: "https://sneeai.com", profileKey: `p1:${"a".repeat(64)}`, clientId: "client-a" };
const authorization = { subject: "user-1", deviceId: `d1:${"b".repeat(43)}`, authorizationVersion: 4, expiresAt: 1_500 };

test("pairing tickets are bound to origin, profile, client, and expiry", () => {
    const ticket = createAgentTicket(secret, { kind: "pairing", ...binding, now: 1_000, ttlMs: 500 });

    assert.equal(verifyAgentTicket(secret, ticket, { kind: "pairing", ...binding }, 1_250).ok, true);
    assert.deepEqual(verifyAgentTicket(secret, ticket, { kind: "pairing", ...binding, origin: "https://evil.example" }, 1_250), { ok: false, reason: "origin" });
    assert.deepEqual(verifyAgentTicket(secret, ticket, { kind: "pairing", ...binding, profileKey: `p1:${"b".repeat(64)}` }, 1_250), { ok: false, reason: "profile" });
    assert.deepEqual(verifyAgentTicket(secret, ticket, { kind: "pairing", ...binding, clientId: "client-b" }, 1_250), { ok: false, reason: "client" });
    assert.deepEqual(verifyAgentTicket(secret, ticket, { kind: "pairing", ...binding }, 1_500), { ok: false, reason: "expired" });
    assert.deepEqual(verifyAgentTicket(secret, ticket, { kind: "pairing", ...binding }, 1_501), { ok: false, reason: "expired" });
});

test("tickets cannot be issued without a client binding", () => {
    assert.throws(
        () => createAgentTicket(secret, { kind: "pairing", origin: binding.origin, profileKey: binding.profileKey, clientId: "", now: 1_000, ttlMs: 500 }),
        /invalid client id/,
    );
});

test("tampered or wrongly signed tickets are rejected", () => {
    const ticket = createAgentTicket(secret, { kind: "pairing", ...binding, now: 1_000, ttlMs: 500 });
    const tampered = `${ticket.slice(0, -1)}${ticket.endsWith("0") ? "1" : "0"}`;

    assert.deepEqual(verifyAgentTicket("wrong-secret", ticket, { kind: "pairing", ...binding }, 1_250), { ok: false, reason: "invalid" });
    assert.deepEqual(verifyAgentTicket(secret, tampered, { kind: "pairing", ...binding }, 1_250), { ok: false, reason: "invalid" });
});

test("event tickets are one-time even before their expiry", () => {
    const ticket = createAgentTicket(secret, { kind: "events", ...binding, now: 2_000, ttlMs: 500 });
    const result = verifyAgentTicket(secret, ticket, { kind: "events", ...binding }, 2_100);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const guard = new EventTicketReplayGuard();
    assert.equal(guard.consume(result.claims, 2_100), true);
    assert.equal(guard.consume(result.claims, 2_101), false);
});

test("local tickets preserve the signed website authorization lease", () => {
    const ticket = createAgentTicket(secret, { kind: "pairing", ...binding, authorization, now: 1_000, ttlMs: 500 });
    const result = verifyAgentTicket(secret, ticket, { kind: "pairing", ...binding }, 1_250);

    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.claims.authorization, authorization);

    const tooLong = createAgentTicket(secret, { kind: "pairing", ...binding, authorization: { ...authorization, expiresAt: 1_400 }, now: 1_000, ttlMs: 500 });
    assert.deepEqual(verifyAgentTicket(secret, tooLong, { kind: "pairing", ...binding }, 1_250), { ok: false, reason: "invalid" });
});
