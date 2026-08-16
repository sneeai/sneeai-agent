import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createInstallerDelivery } from "../../installer/release-plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const ARCHIVE_MTIME = new Date("2000-01-01T00:00:00.000Z");
const RELEASE_DIR_MODE = 0o755;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MANAGED_RELEASE_FILE_PATTERN = /^sneeai-agent-[0-9A-Za-z][0-9A-Za-z.+_-]*-(?:macos|windows)-(?:arm64|x64)\.(?:tar\.gz|zip)(?:\.sha256)?$/;
const TARGETS = Object.freeze({
    "darwin-arm64": { platform: "macos", arch: "arm64", bunTarget: "bun-darwin-arm64", codexSuffix: "darwin-arm64", triple: "aarch64-apple-darwin", archive: "tar.gz" },
    "darwin-x64": { platform: "macos", arch: "x64", bunTarget: "bun-darwin-x64", codexSuffix: "darwin-x64", triple: "x86_64-apple-darwin", archive: "tar.gz" },
    "windows-x64": { platform: "windows", arch: "x64", bunTarget: "bun-windows-x64", codexSuffix: "win32-x64", triple: "x86_64-pc-windows-msvc", archive: "zip" },
});

if (isMainModule()) await main();

export async function main({ argv = process.argv.slice(2), environment = process.env } = {}) {
    const output = path.resolve(root, environment.SNEEAI_AGENT_RELEASE_DIR || "release");
    await validateReleaseDirectory(output);
    const packageJSON = await readJSON(path.join(root, "package.json"));
    const packageLock = await readJSON(path.join(root, "package-lock.json"));
    const requestedTargets = argv.filter((argument) => argument !== "--");
    const targetNames = requestedTargets.length ? [...new Set(requestedTargets)] : [hostTarget()];
    const buildId = normalizeBuildId(environment.SNEEAI_AGENT_BUILD_ID?.trim() || await sourceBuildId(root));
    const plan = createReleasePlan({ packageJSON, packageLock, targets: targetNames, buildId });
    const instructions = await readFile(path.join(root, "agent-instructions.md"), "utf8");
    const bunVersion = (await capture("bun", ["--version"], { cwd: root, environment })).trim();

    await mkdir(output, { recursive: true });
    const releaseStage = await mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}-build-`));
    try {
        const compilerPaths = new Map();
        for (const specification of plan.targets) {
            compilerPaths.set(specification.target, await resolveBunCompilerPath(specification, bunVersion, environment));
        }

        const artifacts = [];
        for (const specification of plan.targets) {
            artifacts.push(await buildTarget({
                plan,
                specification,
                instructions,
                releaseStage,
                compilerPath: compilerPaths.get(specification.target),
                environment,
            }));
        }

        const manifest = createReleaseManifest(plan, artifacts);
        await writeFile(path.join(releaseStage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        const releaseFiles = artifacts.flatMap((artifact) => [artifact.archive, artifact.checksumFile]);
        releaseFiles.push("manifest.json");
        await publishRelease(output, releaseStage, releaseFiles);

        for (const artifact of artifacts) process.stdout.write(`${artifact.archive} ${artifact.sha256}\n`);
        process.stdout.write(`manifest.json ${plan.releaseId}\n`);
        return manifest;
    } finally {
        await rm(releaseStage, { recursive: true, force: true });
    }
}

export function createReleasePlan({ packageJSON, packageLock, targets, buildId }) {
    const agentVersion = requireVersion(packageJSON?.version, "package.json version");
    const lockVersion = requireVersion(packageLock?.version, "package-lock.json version");
    const lockRootVersion = requireVersion(packageLock?.packages?.[""]?.version, "package-lock.json root package version");
    if (lockVersion !== agentVersion || lockRootVersion !== agentVersion) {
        throw new Error(`Agent version mismatch: package.json=${agentVersion}, package-lock.json=${lockVersion}, package-lock root=${lockRootVersion}`);
    }

    const codexVersion = requireVersion(packageJSON?.dependencies?.["@openai/codex"], "package.json @openai/codex version");
    const lockedCodexVersion = packageLock?.packages?.["node_modules/@openai/codex"]?.version;
    const lockedRootCodexVersion = packageLock?.packages?.[""]?.dependencies?.["@openai/codex"];
    if (lockedCodexVersion !== codexVersion || lockedRootCodexVersion !== codexVersion) {
        throw new Error(`Codex version mismatch: package.json=${codexVersion}, package-lock.json=${String(lockedRootCodexVersion)}, installed lock entry=${String(lockedCodexVersion)}`);
    }

    const specifications = targets.map((target) => targetSpec(target, codexVersion));
    for (const specification of specifications) {
        const lockEntry = packageLock?.packages?.[`node_modules/@openai/codex-${specification.codexSuffix}`];
        if (lockEntry?.name !== "@openai/codex" || lockEntry?.version !== specification.codexPackageVersion) {
            throw new Error(`package-lock.json does not pin @openai/codex@${specification.codexPackageVersion} for ${specification.target}`);
        }
    }

    const normalizedBuildId = normalizeBuildId(buildId);
    return Object.freeze({
        agentVersion,
        buildId: normalizedBuildId,
        releaseId: `${agentVersion}+${normalizedBuildId}`,
        codexVersion,
        targets: specifications,
    });
}

export function targetSpec(target, codexVersion) {
    const base = TARGETS[target];
    if (!base) throw new Error(`Unsupported release target: ${target}`);
    return Object.freeze({
        target,
        ...base,
        codexPackageVersion: `${codexVersion}-${base.codexSuffix}`,
    });
}

export function npmPackArguments(codexPackageVersion, destination) {
    return [
        "pack",
        `@openai/codex@${codexPackageVersion}`,
        "--offline",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        destination,
    ];
}

export function npmCommand(platform = process.platform) {
    return platform === "win32" ? "npm.cmd" : "npm";
}

export function npmInvocation(args, { platform = process.platform, nodePath = process.execPath, npmExecPath = process.env.npm_execpath } = {}) {
    if (platform === "win32" && npmExecPath) return { command: nodePath, args: [npmExecPath, ...args] };
    return { command: npmCommand(platform), args };
}

export function archiveInvocation(specification, stage, bundle, archive, memberList, archiveCommand = "tar") {
    const commonEnvironment = { COPYFILE_DISABLE: "1", TZ: "UTC" };
    const commonArguments = [
        "--no-acls",
        "--no-fflags",
        "--no-xattrs",
        "--uid", "0",
        "--gid", "0",
        "--uname", "",
        "--gname", "",
        "--null",
        "--no-recursion",
        "-C", stage,
        "-T", memberList,
    ];
    if (specification.archive === "zip") {
        return {
            command: archiveCommand,
            args: ["-q", "-X", "-9", archive, "-@"],
            cwd: stage,
            environment: commonEnvironment,
            stdinFile: memberList,
        };
    }
    return {
        command: archiveCommand,
        args: ["--format", "ustar", "--options", "gzip:!timestamp", "-czf", archive, ...commonArguments],
        cwd: root,
        environment: commonEnvironment,
    };
}

export async function prepareArchiveBundle(stage, bundle) {
    const directories = [bundle];
    const files = [];
    await collectArchiveEntries(bundle, directories, files);
    directories.sort(compareArchivePaths);
    files.sort(compareArchivePaths);

    for (const directory of directories) {
        await chmod(directory, 0o755);
        await setModificationTime(directory, ARCHIVE_MTIME);
    }
    for (const file of files) {
        await chmod(file, isExecutableArchiveFile(file) ? 0o755 : 0o644);
        await setModificationTime(file, ARCHIVE_MTIME);
    }

    const members = [...directories, ...files]
        .map((entry) => path.relative(stage, entry).split(path.sep).join("/"));
    const nullMemberList = path.join(stage, ".archive-members-null");
    const lineMemberList = path.join(stage, ".archive-members-lines");
    await writeFile(nullMemberList, `${members.join("\0")}\0`);
    await writeFile(lineMemberList, `${members.join("\n")}\n`);
    return { nullMemberList, lineMemberList };
}

export function bunBuildEnvironment(environment, { instructions, agentVersion, buildId }) {
    const sanitized = Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith("SNEEAI_AGENT_")));
    return {
        ...sanitized,
        SNEEAI_AGENT_INSTRUCTIONS: instructions,
        SNEEAI_AGENT_PACKAGE_JSON: JSON.stringify({ version: agentVersion }),
        SNEEAI_AGENT_BUILD_ID: buildId,
    };
}

export function createReleaseManifest(plan, artifacts) {
    return {
        schemaVersion: 1,
        agentVersion: plan.agentVersion,
        buildId: plan.buildId,
        releaseId: plan.releaseId,
        codexVersion: plan.codexVersion,
        artifacts: artifacts.map((artifact) => ({
            target: artifact.target,
            platform: artifact.platform,
            arch: artifact.arch,
            codexPackageVersion: artifact.codexPackageVersion,
            archive: artifact.archive,
            checksumFile: artifact.checksumFile,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
        })),
        delivery: createInstallerDelivery(plan, artifacts),
    };
}

export async function publishRelease(output, releaseStage, releaseFiles) {
    await validateReleaseDirectory(output);
    const parent = path.dirname(output);
    const replacement = await mkdtemp(path.join(parent, `.${path.basename(output)}-publish-`));
    const backup = path.join(parent, `.${path.basename(output)}-backup-${process.pid}-${randomUUID()}`);
    let outputExists = true;
    let outputBackedUp = false;
    let replacementPublished = false;
    try {
        let entries;
        try {
            entries = await readdir(output, { withFileTypes: true });
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            outputExists = false;
            entries = [];
        }
        for (const entry of entries) {
            if (isManagedReleaseFile(entry.name)) continue;
            await cp(path.join(output, entry.name), path.join(replacement, entry.name), { recursive: true, verbatimSymlinks: true });
        }
        for (const file of releaseFiles) {
            if (path.basename(file) !== file) throw new Error(`Invalid release filename: ${file}`);
            await rename(path.join(releaseStage, file), path.join(replacement, file));
        }
        if (process.platform !== "win32") await chmod(replacement, RELEASE_DIR_MODE);

        if (outputExists) {
            await rename(output, backup);
            outputBackedUp = true;
        }
        await rename(replacement, output);
        replacementPublished = true;
        if (outputBackedUp) await rm(backup, { recursive: true, force: true });
    } catch (error) {
        if (outputBackedUp && !replacementPublished) {
            await rm(output, { recursive: true, force: true });
            await rename(backup, output);
            outputBackedUp = false;
        }
        throw error;
    } finally {
        if (!replacementPublished) await rm(replacement, { recursive: true, force: true });
        if (replacementPublished && outputBackedUp) await rm(backup, { recursive: true, force: true });
    }
}

export function isManagedReleaseFile(name) {
    return name === "manifest.json" || MANAGED_RELEASE_FILE_PATTERN.test(name);
}

export async function sourceBuildId(rootDirectory) {
    const inputs = [
        "agent-instructions.md",
        "package.json",
        "package-lock.json",
        ...await listFiles(path.join(rootDirectory, "src")),
        path.resolve(rootDirectory, "..", "installer", "release-plan.mjs"),
    ].sort();
    const hash = createHash("sha256");
    for (const input of inputs) {
        const relative = path.isAbsolute(input) ? path.relative(rootDirectory, input) : input;
        const contents = await readFile(path.resolve(rootDirectory, input));
        hash.update(relative.split(path.sep).join("/"));
        hash.update("\0");
        hash.update(String(contents.length));
        hash.update("\0");
        hash.update(contents);
        hash.update("\0");
    }
    return hash.digest("hex").slice(0, 40);
}

async function buildTarget({ plan, specification, instructions, releaseStage, compilerPath, environment }) {
    const stage = await mkdtemp(path.join(os.tmpdir(), `sneeai-agent-${specification.target}-`));
    try {
        const bundleName = `sneeai-agent-${plan.agentVersion}-${specification.platform}-${specification.arch}`;
        const bundle = path.join(stage, bundleName);
        await mkdir(bundle, { recursive: true });

        const executableName = specification.platform === "windows" ? "sneeai-agent.exe" : "sneeai-agent";
        const executable = path.join(bundle, executableName);
        const compileArgs = [
            "build",
            "src/index.ts",
            "--compile",
            `--target=${specification.bunTarget}`,
            `--outfile=${executable}`,
            "--no-compile-autoload-dotenv",
            "--no-compile-autoload-bunfig",
            "--no-compile-autoload-tsconfig",
            "--env=SNEEAI_AGENT_*",
        ];
        if (compilerPath) compileArgs.push(`--compile-executable-path=${compilerPath}`);
        await run("bun", compileArgs, {
            cwd: root,
            environment: bunBuildEnvironment(environment, {
                instructions,
                agentVersion: plan.agentVersion,
                buildId: plan.buildId,
            }),
        });
        if (specification.platform !== "windows") await chmod(executable, 0o755);

        const codexPackage = await unpackCodexPackage(specification, stage, environment);
        const vendor = path.join(codexPackage, "vendor", specification.triple);
        await cp(vendor, path.join(bundle, "codex-runtime"), { recursive: true });
        if (specification.platform !== "windows") {
            await chmod(path.join(bundle, "codex-runtime", "bin", "codex"), 0o755);
            await chmod(path.join(bundle, "codex-runtime", "bin", "codex-code-mode-host"), 0o755);
            await chmod(path.join(bundle, "codex-runtime", "codex-path", "rg"), 0o755);
        }
        await writeFile(path.join(bundle, "README.txt"), releaseReadme(specification.platform));

        const archiveName = `${bundleName}.${specification.archive}`;
        const archive = path.join(releaseStage, archiveName);
        const memberLists = await prepareArchiveBundle(stage, bundle);
        const archiveCommand = specification.archive === "zip"
            ? await resolveZipCommand(environment)
            : await resolveArchiveCommand(environment);
        const memberList = specification.archive === "zip" ? memberLists.lineMemberList : memberLists.nullMemberList;
        const invocation = archiveInvocation(specification, stage, bundle, archive, memberList, archiveCommand);
        await run(invocation.command, invocation.args, {
            ...invocation,
            environment: { ...environment, ...invocation.environment },
        });
        const archiveContents = await readFile(archive);
        const digest = createHash("sha256").update(archiveContents).digest("hex");
        const checksumFile = `${archiveName}.sha256`;
        await writeFile(path.join(releaseStage, checksumFile), `${digest}  ${archiveName}\n`);

        return {
            target: specification.target,
            platform: specification.platform,
            arch: specification.arch,
            codexPackageVersion: specification.codexPackageVersion,
            archive: archiveName,
            checksumFile,
            sizeBytes: archiveContents.byteLength,
            sha256: digest,
        };
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
}

async function unpackCodexPackage(specification, stage, environment) {
    const packageDirectory = path.join(stage, "codex-package");
    await mkdir(packageDirectory);
    const npm = npmInvocation(npmPackArguments(specification.codexPackageVersion, packageDirectory));
    const stdout = await capture(npm.command, npm.args, {
        cwd: root,
        environment: { ...environment, npm_config_audit: "false", npm_config_fund: "false", npm_config_offline: "true", npm_config_update_notifier: "false" },
    });
    const result = JSON.parse(stdout);
    const packed = Array.isArray(result) && typeof result[0]?.filename === "string" ? path.basename(result[0].filename) : "";
    if (!packed) throw new Error(`npm pack did not return an archive for @openai/codex@${specification.codexPackageVersion}`);
    await run("tar", ["-C", packageDirectory, "-xzf", path.join(packageDirectory, packed)], {
        cwd: root,
        environment: { ...environment, COPYFILE_DISABLE: "1" },
    });

    const extracted = path.join(packageDirectory, "package");
    const packedPackageJSON = await readJSON(path.join(extracted, "package.json"));
    if (packedPackageJSON.name !== "@openai/codex" || packedPackageJSON.version !== specification.codexPackageVersion) {
        throw new Error(`Unexpected Codex package: ${String(packedPackageJSON.name)}@${String(packedPackageJSON.version)}`);
    }
    const codexPackageJSON = await readJSON(path.join(extracted, "vendor", specification.triple, "codex-package.json"));
    const expectedBaseVersion = specification.codexPackageVersion.slice(0, -(`-${specification.codexSuffix}`).length);
    if (codexPackageJSON.version !== expectedBaseVersion || codexPackageJSON.target !== specification.triple) {
        throw new Error(`Unexpected Codex runtime metadata for ${specification.target}`);
    }
    return extracted;
}

async function resolveBunCompilerPath(specification, bunVersion, environment) {
    if (specification.bunTarget === hostBunTarget()) return undefined;
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(bunVersion)) throw new Error(`Unexpected Bun version: ${bunVersion}`);
    const bunInstall = environment.BUN_INSTALL?.trim() || path.join(os.homedir(), ".bun");
    const compilerPath = path.join(bunInstall, "install", "cache", `${bunCompilerCacheTarget(specification.bunTarget)}-v${bunVersion}`);
    try {
        await access(compilerPath, fsConstants.X_OK);
    } catch {
        throw new Error(`Offline Bun compiler is missing for ${specification.target}: ${compilerPath}`);
    }
    return compilerPath;
}

export function bunCompilerCacheTarget(bunTarget) {
    return bunTarget === "bun-darwin-arm64" ? "bun-darwin-aarch64" : bunTarget;
}

function hostTarget() {
    if (process.platform === "darwin") return `darwin-${process.arch}`;
    if (process.platform === "win32") return `windows-${process.arch}`;
    throw new Error(`Unsupported release host: ${process.platform}-${process.arch}`);
}

function hostBunTarget() {
    if (process.platform === "darwin") return `bun-darwin-${process.arch}`;
    if (process.platform === "win32") return `bun-windows-${process.arch}`;
    if (process.platform === "linux") return `bun-linux-${process.arch}`;
    return "";
}

function normalizeBuildId(value) {
    if (!BUILD_ID_PATTERN.test(value || "")) throw new Error("SNEEAI_AGENT_BUILD_ID must contain 1-128 letters, digits, dots, underscores, or hyphens");
    return value;
}

async function validateReleaseDirectory(output) {
    const relative = path.relative(root, output);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe release directory: ${output}`);

    const resolvedRoot = await realpath(root);
    let existingAncestor = output;
    while (true) {
        try {
            existingAncestor = await realpath(existingAncestor);
            break;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            const parent = path.dirname(existingAncestor);
            if (parent === existingAncestor) throw error;
            existingAncestor = parent;
        }
    }
    const resolvedRelative = path.relative(resolvedRoot, existingAncestor);
    if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) throw new Error(`Unsafe release directory: ${output}`);
}

function requireVersion(value, label) {
    if (typeof value !== "string" || !VERSION_PATTERN.test(value)) throw new Error(`${label} must be an exact semantic version`);
    return value;
}

async function listFiles(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await listFiles(absolute));
        else if (entry.isFile()) files.push(absolute);
    }
    return files;
}

async function collectArchiveEntries(directory, directories, files) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
        if (entry.name === ".DS_Store" || entry.name.startsWith("._")) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            directories.push(absolute);
            await collectArchiveEntries(absolute, directories, files);
        } else if (entry.isFile()) {
            files.push(absolute);
        } else {
            throw new Error(`Unsupported release bundle entry: ${absolute}`);
        }
    }
}

function compareArchivePaths(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}

function isExecutableArchiveFile(file) {
    const name = path.basename(file);
    return name === "sneeai-agent"
        || name === "sneeai-agent.exe"
        || name === "codex"
        || name === "codex.exe"
        || name === "codex-code-mode-host"
        || name === "codex-code-mode-host.exe"
        || name === "rg"
        || name === "rg.exe"
        || name === "zsh"
        || name.endsWith(".exe");
}

async function setModificationTime(file, time) {
    await utimes(file, time, time);
}

async function resolveArchiveCommand(environment) {
    const candidates = process.platform === "win32" ? ["bsdtar", "tar.exe", "tar"] : ["bsdtar", "tar"];
    for (const candidate of candidates) {
        try {
            const version = await capture(candidate, ["--version"], { cwd: root, environment });
            if (/bsdtar|libarchive/i.test(version)) return candidate;
        } catch {
            // Try the next platform-provided tar executable.
        }
    }
    throw new Error("A libarchive bsdtar executable is required for reproducible release archives");
}

async function resolveZipCommand(environment) {
    try {
        const version = await capture("zip", ["-v"], { cwd: root, environment });
        if (/Info-ZIP/i.test(version)) return "zip";
    } catch {
        // Report one stable error below.
    }
    throw new Error("Info-ZIP is required for reproducible Windows release archives");
}

async function readJSON(file) {
    return JSON.parse(await readFile(file, "utf8"));
}

function releaseReadme(platform) {
    return platform === "windows"
        ? "Sneeai Agent\r\n\r\n双击 sneeai-agent.exe 启动。保持窗口运行，然后返回 sneeai.com 的 Agent 面板重新检测。\r\n"
        : "Sneeai Agent\n\n首次启动：在终端进入本目录，运行 ./sneeai-agent。保持终端运行，然后返回 sneeai.com 的 Agent 面板重新检测。\n";
}

function run(command, args, { cwd = root, environment = process.env, stdinFile } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env: environment, stdio: [stdinFile ? "pipe" : "inherit", "inherit", "inherit"] });
        if (stdinFile) {
            readFile(stdinFile).then((contents) => child.stdin.end(contents), (error) => {
                child.kill();
                reject(error);
            });
        }
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
    });
}

function capture(command, args, { cwd = root, environment = process.env } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env: environment, stdio: ["ignore", "pipe", "inherit"] });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code}`)));
    });
}

function isMainModule() {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
