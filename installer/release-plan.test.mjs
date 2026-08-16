import assert from "node:assert/strict";
import test from "node:test";

import { createInstallerDelivery, validateInstallerDelivery } from "./release-plan.mjs";

const plan = {
    agentVersion: "0.3.5",
    targets: [
        { target: "windows-x64", platform: "windows", arch: "x64" },
        { target: "darwin-arm64", platform: "macos", arch: "arm64" },
    ],
};
const artifacts = [
    { target: "windows-x64", platform: "windows", arch: "x64", archive: "sneeai-agent-0.3.5-windows-x64.zip" },
    { target: "darwin-arm64", platform: "macos", arch: "arm64", archive: "sneeai-agent-0.3.5-macos-arm64.tar.gz" },
];

test("installer delivery is explicit about unavailable unsigned artifacts", () => {
    const delivery = createInstallerDelivery(plan, artifacts);
    assert.equal(delivery.compatibilityArchives, "available");
    assert.equal(delivery.preferredUserDelivery, "installer");
    assert.equal(delivery.installers[0].expectedArtifact, "sneeai-agent-0.3.5-windows-x64.msi");
    assert.equal(delivery.installers[0].status, "not_built");
    assert.equal(delivery.installers[0].signature.status, "not_performed");
    assert.equal(delivery.installers[0].notarization.status, "not_applicable");
    assert.equal(delivery.installers[1].expectedArtifact, "sneeai-agent-0.3.5-macos-arm64.pkg");
    assert.equal(delivery.installers[1].notarization.status, "not_performed");
    assert.ok(delivery.installers.every((installer) => installer.blockers.length > 0));
});

test("installer delivery validation rejects stale manifest metadata", () => {
    const delivery = createInstallerDelivery(plan, artifacts);
    const manifest = { schemaVersion: 1, agentVersion: "0.3.5", releaseId: "0.3.5+build-test", artifacts: artifacts.map((artifact) => ({ ...artifact, sha256: "b".repeat(64) })), delivery };
    assert.deepEqual(validateInstallerDelivery(manifest), delivery);
    assert.throws(() => validateInstallerDelivery({
        ...manifest,
        delivery: { ...delivery, preferredUserDelivery: "archive" },
    }), /stale or inconsistent/);
});

test("a verified installer can become published without weakening immutable delivery metadata", () => {
    const delivery = createInstallerDelivery(plan, artifacts);
    delivery.installers = delivery.installers.map((installer) => ({
        ...installer,
        status: "published",
        agentVersion: "0.3.5",
        releaseId: "0.3.5+build-test",
        sourceArchiveSha256: "b".repeat(64),
        artifact: installer.expectedArtifact,
        sha256: "a".repeat(64),
        publishable: true,
        signature: { ...installer.signature, status: "verified" },
        notarization: { ...installer.notarization, status: installer.notarization.required ? "verified" : "not_applicable" },
        rollback: { strategy: "staged-replace", status: "verified" },
        blockers: [],
    }));
    const manifest = { schemaVersion: 1, agentVersion: "0.3.5", releaseId: "0.3.5+build-test", artifacts: artifacts.map((artifact) => ({ ...artifact, sha256: "b".repeat(64) })), delivery };

    assert.deepEqual(validateInstallerDelivery(manifest), delivery);
    assert.throws(() => validateInstallerDelivery({
        ...manifest,
        delivery: {
            ...delivery,
            installers: delivery.installers.map((installer, index) => index ? installer : { ...installer, sha256: "unsigned" }),
        },
    }), /not publishable/);
});

test("installer delivery requires one compatibility archive per target", () => {
    assert.throws(() => createInstallerDelivery(plan, artifacts.slice(0, 1)), /has no compatibility archive/);
});
