import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { archiveInvocation, bunBuildEnvironment, createReleaseManifest, createReleasePlan, isManagedReleaseFile, npmPackArguments, prepareArchiveBundle, publishRelease } from "./build-release.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

const packageJSON = {
    version: "0.3.4",
    dependencies: { "@openai/codex": "0.145.0" },
};
const packageLock = {
    version: "0.3.4",
    packages: {
        "": { version: "0.3.4", dependencies: { "@openai/codex": "0.145.0" } },
        "node_modules/@openai/codex": { name: "@openai/codex", version: "0.145.0" },
        "node_modules/@openai/codex-darwin-arm64": { name: "@openai/codex", version: "0.145.0-darwin-arm64" },
        "node_modules/@openai/codex-darwin-x64": { name: "@openai/codex", version: "0.145.0-darwin-x64" },
        "node_modules/@openai/codex-win32-x64": { name: "@openai/codex", version: "0.145.0-win32-x64" },
    },
};

test("release metadata uses one validated Agent and Codex version", () => {
    const plan = createReleasePlan({
        packageJSON,
        packageLock,
        targets: ["darwin-arm64", "darwin-x64", "windows-x64"],
        buildId: "build-abc123",
    });

    assert.equal(plan.agentVersion, "0.3.4");
    assert.equal(plan.releaseId, "0.3.4+build-abc123");
    assert.equal(plan.codexVersion, "0.145.0");
    assert.deepEqual(plan.targets.map(({ target, codexPackageVersion }) => ({ target, codexPackageVersion })), [
        { target: "darwin-arm64", codexPackageVersion: "0.145.0-darwin-arm64" },
        { target: "darwin-x64", codexPackageVersion: "0.145.0-darwin-x64" },
        { target: "windows-x64", codexPackageVersion: "0.145.0-win32-x64" },
    ]);

    assert.throws(() => createReleasePlan({
        packageJSON,
        packageLock: { ...packageLock, version: "0.3.3" },
        targets: ["darwin-arm64"],
        buildId: "build-abc123",
    }), /Agent version mismatch/);
    assert.throws(() => createReleasePlan({
        packageJSON,
        packageLock: {
            ...packageLock,
            packages: {
                ...packageLock.packages,
                "node_modules/@openai/codex-win32-x64": { name: "@openai/codex", version: "0.144.0-win32-x64" },
            },
        },
        targets: ["windows-x64"],
        buildId: "build-abc123",
    }), /does not pin/);
});

test("release commands require offline Codex packages and metadata-clean archives", () => {
    const destination = "/tmp/codex-package";
    const npmArgs = npmPackArguments("0.145.0-win32-x64", destination);
    assert.deepEqual(npmArgs, [
        "pack",
        "@openai/codex@0.145.0-win32-x64",
        "--offline",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        destination,
    ]);

    const plan = createReleasePlan({ packageJSON, packageLock, targets: ["windows-x64"], buildId: "build-abc123" });
    const invocation = archiveInvocation(plan.targets[0], "/tmp/stage", "/tmp/stage/bundle", "/tmp/release.zip", "/tmp/members", "zip");
    assert.equal(invocation.command, "zip");
    assert.deepEqual(invocation.args, ["-q", "-X", "-9", "/tmp/release.zip", "-@"]);
    assert.equal(invocation.environment.TZ, "UTC");
    assert.equal(invocation.environment.COPYFILE_DISABLE, "1");
    assert.equal(invocation.stdinFile, "/tmp/members");
    assert.equal(JSON.stringify(invocation).includes("ditto"), false);
    assert.equal(JSON.stringify(invocation).includes("sequesterRsrc"), false);

    const buildEnvironment = bunBuildEnvironment({ PATH: "/usr/bin", SNEEAI_AGENT_PRIVATE_VALUE: "do-not-bundle" }, {
        instructions: "agent prompt",
        agentVersion: "0.3.4",
        buildId: "build-abc123",
    });
    assert.equal(buildEnvironment.PATH, "/usr/bin");
    assert.equal("SNEEAI_AGENT_PRIVATE_VALUE" in buildEnvironment, false);
    assert.equal(buildEnvironment.SNEEAI_AGENT_INSTRUCTIONS, "agent prompt");
    assert.equal(buildEnvironment.SNEEAI_AGENT_PACKAGE_JSON, '{"version":"0.3.4"}');
    assert.equal(buildEnvironment.SNEEAI_AGENT_BUILD_ID, "build-abc123");
});

test("tar.gz and zip archives are byte-reproducible with normalized permissions and no Apple metadata", async (t) => {
    const fixture = await mkdtemp(path.join(PROJECT_ROOT, ".release-reproducibility-test-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const plan = createReleasePlan({ packageJSON, packageLock, targets: ["darwin-arm64", "windows-x64"], buildId: "build-abc123" });

    for (const specification of plan.targets) {
        const archives = [];
        for (const build of ["one", "two"]) {
            const stage = path.join(fixture, `${specification.target}-${build}`);
            const bundleName = `sneeai-agent-${packageJSON.version}-${specification.platform}-${specification.arch}`;
            const bundle = path.join(stage, bundleName);
            const executable = path.join(bundle, specification.platform === "windows" ? "sneeai-agent.exe" : "sneeai-agent");
            const runtimeExecutable = path.join(bundle, "codex-runtime", "bin", specification.platform === "windows" ? "codex.exe" : "codex");
            const readme = path.join(bundle, "README.txt");
            await mkdir(path.dirname(runtimeExecutable), { recursive: true });
            await writeFile(executable, "agent executable\n", { mode: build === "one" ? 0o700 : 0o755 });
            await writeFile(runtimeExecutable, "codex executable\n", { mode: build === "one" ? 0o711 : 0o775 });
            await writeFile(readme, "release notes\n", { mode: build === "one" ? 0o600 : 0o666 });
            if (process.platform === "darwin" && build === "one") {
                await execFileAsync("xattr", ["-w", "com.sneeai.reproducibility-test", "ignored", readme]);
            }

            const memberLists = await prepareArchiveBundle(stage, bundle);
            const archive = path.join(stage, `${bundleName}.${specification.archive}`);
            const memberList = specification.archive === "zip" ? memberLists.lineMemberList : memberLists.nullMemberList;
            const command = specification.archive === "zip" ? "zip" : "bsdtar";
            const invocation = archiveInvocation(specification, stage, bundle, archive, memberList, command);
            if (invocation.stdinFile) {
                const input = await readFile(invocation.stdinFile);
                await new Promise((resolve, reject) => {
                    const child = execFile(invocation.command, invocation.args, {
                        cwd: invocation.cwd,
                        env: { ...process.env, ...invocation.environment },
                    }, (error) => error ? reject(error) : resolve());
                    child.stdin.end(input);
                });
            } else {
                await execFileAsync(invocation.command, invocation.args, {
                    cwd: invocation.cwd,
                    env: { ...process.env, ...invocation.environment },
                });
            }
            archives.push(archive);
        }

        assert.deepEqual(await readFile(archives[0]), await readFile(archives[1]), `${specification.archive} bytes differ`);
        const { stdout: members } = await execFileAsync("bsdtar", ["-tf", archives[0]]);
        assert.doesNotMatch(members, /(?:^|\/)\._|__MACOSX|\.DS_Store/);

        const extracted = path.join(fixture, `${specification.target}-extracted`);
        await mkdir(extracted);
        await execFileAsync("bsdtar", ["-xf", archives[0], "-C", extracted]);
        const bundleName = `sneeai-agent-${packageJSON.version}-${specification.platform}-${specification.arch}`;
        const executableName = specification.platform === "windows" ? "sneeai-agent.exe" : "sneeai-agent";
        const runtimeExecutableName = specification.platform === "windows" ? "codex.exe" : "codex";
        assert.equal((await stat(path.join(extracted, bundleName))).mode & 0o777, 0o755);
        assert.equal((await stat(path.join(extracted, bundleName, executableName))).mode & 0o777, 0o755);
        assert.equal((await stat(path.join(extracted, bundleName, "codex-runtime", "bin", runtimeExecutableName))).mode & 0o777, 0o755);
        assert.equal((await stat(path.join(extracted, bundleName, "README.txt"))).mode & 0o777, 0o644);
    }
});

test("manifest records build identity and every archive digest", () => {
    const plan = createReleasePlan({ packageJSON, packageLock, targets: ["darwin-arm64"], buildId: "build-abc123" });
    const manifest = createReleaseManifest(plan, [{
        target: "darwin-arm64",
        platform: "macos",
        arch: "arm64",
        codexPackageVersion: "0.145.0-darwin-arm64",
        archive: "sneeai-agent-0.3.4-macos-arm64.tar.gz",
        checksumFile: "sneeai-agent-0.3.4-macos-arm64.tar.gz.sha256",
        sizeBytes: 123,
        sha256: "a".repeat(64),
    }]);

    assert.deepEqual(manifest, {
        schemaVersion: 1,
        agentVersion: "0.3.4",
        buildId: "build-abc123",
        releaseId: "0.3.4+build-abc123",
        codexVersion: "0.145.0",
        artifacts: [{
            target: "darwin-arm64",
            platform: "macos",
            arch: "arm64",
            codexPackageVersion: "0.145.0-darwin-arm64",
            archive: "sneeai-agent-0.3.4-macos-arm64.tar.gz",
            checksumFile: "sneeai-agent-0.3.4-macos-arm64.tar.gz.sha256",
            sizeBytes: 123,
            sha256: "a".repeat(64),
        }],
    });
});

test("publishing replaces only managed release files", async (t) => {
    const fixture = await mkdtemp(path.join(PROJECT_ROOT, ".release-test-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const output = path.join(fixture, "release");
    const stage = path.join(fixture, "stage");
    await mkdir(output, { recursive: true });
    await mkdir(stage);
    await writeFile(path.join(output, "sneeai-agent-0.3.3-windows-x64.zip"), "old");
    await writeFile(path.join(output, "sneeai-agent-0.3.3-windows-x64.zip.sha256"), "old");
    await writeFile(path.join(output, "notes.txt"), "keep");

    const files = ["sneeai-agent-0.3.4-windows-x64.zip", "sneeai-agent-0.3.4-windows-x64.zip.sha256", "manifest.json"];
    for (const file of files) await writeFile(path.join(stage, file), `new:${file}`);
    await publishRelease(output, stage, files);

    assert.equal(await readFile(path.join(output, "notes.txt"), "utf8"), "keep");
    assert.equal(await readFile(path.join(output, files[0]), "utf8"), `new:${files[0]}`);
    if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o755);
    await assert.rejects(readFile(path.join(output, "sneeai-agent-0.3.3-windows-x64.zip")), /ENOENT/);
    assert.equal(isManagedReleaseFile("manifest.json"), true);
    assert.equal(isManagedReleaseFile("notes.txt"), false);
});

test("a failed publish keeps the existing release directory intact", async (t) => {
    const fixture = await mkdtemp(path.join(PROJECT_ROOT, ".release-rollback-test-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const output = path.join(fixture, "release");
    const stage = path.join(fixture, "stage");
    await mkdir(output);
    await mkdir(stage);
    await writeFile(path.join(output, "sneeai-agent-0.3.3-windows-x64.zip"), "old");

    await assert.rejects(
        publishRelease(output, stage, ["missing.zip"]),
        /ENOENT/,
    );
    assert.equal(await readFile(path.join(output, "sneeai-agent-0.3.3-windows-x64.zip"), "utf8"), "old");
});

test("publishing rejects release directories outside the Agent package", async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "sneeai-agent-release-unsafe-test-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const output = path.join(fixture, "release");
    const stage = path.join(fixture, "stage");
    await mkdir(stage);

    await assert.rejects(
        publishRelease(output, stage, []),
        /Unsafe release directory/,
    );
});

test("publishing rejects an in-package symlink that escapes the Agent package", async (t) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "sneeai-agent-release-symlink-target-"));
    const fixture = await mkdtemp(path.join(PROJECT_ROOT, ".release-symlink-test-"));
    t.after(() => Promise.all([
        rm(fixture, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
    ]));
    const link = path.join(fixture, "outside");
    const stage = path.join(fixture, "stage");
    await symlink(outside, link, "dir");
    await mkdir(stage);

    await assert.rejects(
        publishRelease(path.join(link, "release"), stage, []),
        /Unsafe release directory/,
    );
});
