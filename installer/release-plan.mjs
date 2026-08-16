#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INSTALLER_TARGETS = Object.freeze({
    "windows-x64": Object.freeze({
        target: "windows-x64",
        platform: "windows",
        arch: "x64",
        format: "msi",
        extension: "msi",
        buildHost: "windows",
        backgroundMode: "per-user-logon",
        signature: Object.freeze({ required: true, scheme: "Authenticode" }),
        notarization: Object.freeze({ required: false, scheme: null }),
        blockers: Object.freeze([
            "The WiX v4 source must be built and lifecycle-tested on Windows 11.",
            "A Windows code-signing certificate and protected signing job are required.",
            "Install, upgrade, rollback, and uninstall behavior must pass a clean Windows 11 test.",
        ]),
    }),
    "darwin-arm64": Object.freeze({
        target: "darwin-arm64",
        platform: "macos",
        arch: "arm64",
        format: "pkg",
        extension: "pkg",
        buildHost: "macos",
        backgroundMode: "user-launch-agent",
        signature: Object.freeze({ required: true, scheme: "Developer ID Installer" }),
        notarization: Object.freeze({ required: true, scheme: "Apple notarization" }),
        blockers: Object.freeze([
            "The pkgbuild/productbuild source must pass clean-device lifecycle tests.",
            "A Developer ID Installer identity is required.",
            "Apple notarization credentials and stapling verification are required.",
            "Install, upgrade, rollback, and uninstall behavior must pass a clean Apple Silicon macOS test.",
        ]),
    }),
    "darwin-x64": Object.freeze({
        target: "darwin-x64",
        platform: "macos",
        arch: "x64",
        format: "pkg",
        extension: "pkg",
        buildHost: "macos",
        backgroundMode: "user-launch-agent",
        signature: Object.freeze({ required: true, scheme: "Developer ID Installer" }),
        notarization: Object.freeze({ required: true, scheme: "Apple notarization" }),
        blockers: Object.freeze([
            "The pkgbuild/productbuild source must pass clean-device lifecycle tests.",
            "A Developer ID Installer identity is required.",
            "Apple notarization credentials and stapling verification are required.",
            "Install, upgrade, rollback, and uninstall behavior must pass a clean Intel macOS test.",
        ]),
    }),
});

export function createInstallerDelivery(plan, artifacts) {
    const artifactsByTarget = new Map(artifacts.map((artifact) => [artifact.target, artifact]));
    const installers = plan.targets.map((specification) => {
        const target = INSTALLER_TARGETS[specification.target];
        if (!target) throw new Error(`No installer delivery target is defined for ${specification.target}`);
        const source = artifactsByTarget.get(specification.target);
        if (!source) throw new Error(`Installer delivery target ${specification.target} has no compatibility archive`);

        return {
            target: target.target,
            platform: target.platform,
            arch: target.arch,
            format: target.format,
            expectedArtifact: `sneeai-agent-${plan.agentVersion}-${target.platform}-${target.arch}.${target.extension}`,
            sourceArchive: source.archive,
            status: "not_built",
            backgroundMode: target.backgroundMode,
            buildHost: target.buildHost,
            signature: {
                required: target.signature.required,
                scheme: target.signature.scheme,
                status: "not_performed",
            },
            notarization: {
                required: target.notarization.required,
                scheme: target.notarization.scheme,
                status: target.notarization.required ? "not_performed" : "not_applicable",
            },
            blockers: [...target.blockers],
        };
    });

    return {
        schemaVersion: 1,
        compatibilityArchives: "available",
        preferredUserDelivery: "installer",
        installers,
    };
}

export function validateInstallerDelivery(releaseManifest) {
    if (releaseManifest?.schemaVersion !== 1) throw new Error("Unsupported Agent release manifest schema");
    if (!Array.isArray(releaseManifest.artifacts) || releaseManifest.artifacts.length === 0) {
        throw new Error("Agent release manifest has no compatibility archives");
    }
    const expected = createInstallerDelivery({
        agentVersion: releaseManifest.agentVersion,
        targets: releaseManifest.artifacts.map(({ target, platform, arch }) => ({ target, platform, arch })),
    }, releaseManifest.artifacts);
    const delivery = releaseManifest.delivery || expected;
    if (delivery.schemaVersion !== expected.schemaVersion ||
        delivery.compatibilityArchives !== expected.compatibilityArchives ||
        delivery.preferredUserDelivery !== expected.preferredUserDelivery ||
        !Array.isArray(delivery.installers) || delivery.installers.length !== expected.installers.length) {
        throw new Error("Agent release manifest installer delivery metadata is stale or inconsistent");
    }

    const actualByTarget = new Map(delivery.installers.map((installer) => [installer?.target, installer]));
    for (const expectedInstaller of expected.installers) {
        const installer = actualByTarget.get(expectedInstaller.target);
        if (!installer || !installerIdentityMatches(installer, expectedInstaller)) {
            throw new Error("Agent release manifest installer delivery metadata is stale or inconsistent");
        }
        if (installer.status === "not_built") {
            if (JSON.stringify(installer) !== JSON.stringify(expectedInstaller)) {
                throw new Error("An unbuilt installer cannot contain release evidence");
            }
            continue;
        }
        if (installer.status !== "published" ||
            installer.agentVersion !== releaseManifest.agentVersion ||
            installer.releaseId !== releaseManifest.releaseId ||
            installer.sourceArchiveSha256 !== expectedSourceArchiveSha256(expectedInstaller, releaseManifest.artifacts) ||
            installer.artifact !== expectedInstaller.expectedArtifact ||
            !/^[a-f0-9]{64}$/.test(installer.sha256 || "") ||
            installer.publishable !== true ||
            installer.signature?.status !== "verified" ||
            (expectedInstaller.notarization.required
                ? installer.notarization?.status !== "verified"
                : installer.notarization?.status !== "not_applicable") ||
            installer.rollback?.strategy !== "staged-replace" ||
            installer.rollback?.status !== "verified" ||
            !Array.isArray(installer.blockers) || installer.blockers.length !== 0) {
            throw new Error(`Installer ${expectedInstaller.target} is not publishable`);
        }
    }
    return delivery;
}

function expectedSourceArchiveSha256(expectedInstaller, artifacts) {
    return artifacts.find((artifact) => artifact.target === expectedInstaller.target)?.sha256 || "";
}

function installerIdentityMatches(actual, expected) {
    return actual.target === expected.target &&
        actual.platform === expected.platform &&
        actual.arch === expected.arch &&
        actual.format === expected.format &&
        actual.expectedArtifact === expected.expectedArtifact &&
        actual.sourceArchive === expected.sourceArchive &&
        actual.backgroundMode === expected.backgroundMode &&
        actual.buildHost === expected.buildHost &&
        actual.signature?.required === expected.signature.required &&
        actual.signature?.scheme === expected.signature.scheme &&
        actual.notarization?.required === expected.notarization.required &&
        actual.notarization?.scheme === expected.notarization.scheme;
}

async function main(argv) {
    const manifestIndex = argv.indexOf("--manifest");
    if (manifestIndex === -1 || !argv[manifestIndex + 1]) {
        throw new Error("Usage: node installer/release-plan.mjs --manifest <canvas-agent/release/manifest.json> [--require-ready]");
    }
    const manifestPath = path.resolve(argv[manifestIndex + 1]);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const delivery = validateInstallerDelivery(manifest);
    process.stdout.write(`${JSON.stringify(delivery, null, 2)}\n`);
    if (argv.includes("--require-ready") && delivery.installers.some((installer) => installer.status !== "published")) {
        process.exitCode = 2;
    }
}

if (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
