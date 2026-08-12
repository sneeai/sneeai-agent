import assert from "node:assert/strict";
import test from "node:test";

import { isProtocolCompatible, negotiateProtocol, PAIRING_CHALLENGE_CAPABILITY, PROTOCOL_CAPABILITIES, PROTOCOL_VERSION, protocolMetadata, REQUIRED_PAIRING_CAPABILITIES, TOOL_AUTHORIZATION_CAPABILITY } from "./protocol.js";

test("protocol metadata separates stable compatibility fields from build identity", () => {
    const metadata = protocolMetadata("9.8.7", "commit-abc");

    assert.equal(metadata.protocolVersion, PROTOCOL_VERSION);
    assert.equal(metadata.buildVersion, "9.8.7");
    assert.equal(metadata.buildId, "commit-abc");
    assert.equal(metadata.releaseId, "9.8.7+commit-abc");
    assert.deepEqual(metadata.capabilities, PROTOCOL_CAPABILITIES);
    assert.ok(metadata.capabilities.includes(TOOL_AUTHORIZATION_CAPABILITY));
    assert.ok(REQUIRED_PAIRING_CAPABILITIES.includes(TOOL_AUTHORIZATION_CAPABILITY));
    assert.ok(REQUIRED_PAIRING_CAPABILITIES.includes(PAIRING_CHALLENGE_CAPABILITY));
    assert.ok(metadata.capabilities.includes("codex.prompt.v1"));
    assert.equal(REQUIRED_PAIRING_CAPABILITIES.includes("codex.prompt.v1"), false);
    assert.equal("diagnostics" in metadata, false);
});

test("protocol negotiation returns an intersection and rejects incompatible offers", () => {
    const accepted = negotiateProtocol({ protocolVersion: PROTOCOL_VERSION, capabilities: ["pairing.v1", "pairing.ticket.v1", "unknown.feature"] });
    assert.deepEqual(accepted, { compatible: true, legacy: false, protocolVersion: PROTOCOL_VERSION, capabilities: ["pairing.v1", "pairing.ticket.v1"] });

    const wrongVersion = negotiateProtocol({ protocolVersion: 99, capabilities: ["pairing.v1"] });
    assert.equal(wrongVersion.compatible, false);
    const missingRequired = negotiateProtocol({ protocolVersion: PROTOCOL_VERSION, capabilities: ["health.v1"] });
    assert.equal(missingRequired.compatible, false);
    assert.equal(negotiateProtocol(undefined).legacy, true);
    const legacyPairing = negotiateProtocol(undefined, REQUIRED_PAIRING_CAPABILITIES);
    assert.equal(legacyPairing.compatible, false);
    if (!legacyPairing.compatible) assert.ok(legacyPairing.missingCapabilities.includes(TOOL_AUTHORIZATION_CAPABILITY));

    const missingAuthorization = negotiateProtocol({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: REQUIRED_PAIRING_CAPABILITIES.filter((capability) => capability !== TOOL_AUTHORIZATION_CAPABILITY),
    }, REQUIRED_PAIRING_CAPABILITIES);
    assert.equal(missingAuthorization.compatible, false);

    const previousWebsiteCapabilities = PROTOCOL_CAPABILITIES.filter((capability) => capability !== "codex.prompt.v1");
    const previousWebsite = negotiateProtocol({ protocolVersion: PROTOCOL_VERSION, capabilities: previousWebsiteCapabilities }, REQUIRED_PAIRING_CAPABILITIES);
    assert.equal(previousWebsite.compatible, true);
});

test("modern protocol compatibility requires negotiated capabilities, not a non-empty version", () => {
    const compatible = { protocolVersion: PROTOCOL_VERSION, buildVersion: "99.0.0", capabilities: [...PROTOCOL_CAPABILITIES] };
    const missingCapability = { protocolVersion: PROTOCOL_VERSION, buildVersion: "0.3.2", capabilities: ["health.v1"] };

    assert.equal(isProtocolCompatible(compatible, { requiredCapabilities: REQUIRED_PAIRING_CAPABILITIES, legacyBuildVersion: "0.3.2" }), true);
    assert.equal(isProtocolCompatible(missingCapability, { requiredCapabilities: REQUIRED_PAIRING_CAPABILITIES, legacyBuildVersion: "0.3.2" }), false);
    assert.equal(isProtocolCompatible({ version: "some-version" }, { legacyBuildVersion: "0.3.2" }), false);
    assert.equal(isProtocolCompatible({ version: "0.3.2" }, { legacyBuildVersion: "0.3.2" }), true);
    assert.equal(isProtocolCompatible({ version: "0.3.2" }, { requiredCapabilities: REQUIRED_PAIRING_CAPABILITIES, legacyBuildVersion: "0.3.2" }), false);
});
