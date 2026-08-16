import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("plugin manifest and license agree", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, "plugins/infinite-canvas/.codex-plugin/plugin.json"), "utf8"));
    const license = await readFile(path.join(root, "plugins/infinite-canvas/LICENSE"), "utf8");
    assert.equal(manifest.license, "AGPL-3.0-only");
    assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
    assert.match(license, /Version 3, 19 November 2007/);
});

test("release and extension documentation entry points exist", async () => {
    const files = [
        "installer/README.md",
        "installer/windows/README.md",
        "installer/macos/README.md",
        "docs/AGENT_RELEASE.md",
        "docs/AGENT_PROTOCOL.md",
        "docs/PLUGIN_DEVELOPMENT.md",
        "plugin-bridge/README.md",
        "installer/windows/Package.wxs",
        "installer/windows/launcher.c",
        "installer/windows/build.ps1",
        "installer/macos/Distribution.xml.in",
        "installer/macos/com.sneeai.agent.plist",
        "installer/macos/build-pkg.sh",
        "installer/macos/uninstall-agent.sh",
        "installer/macos/scripts/preinstall",
        "installer/macos/scripts/postinstall",
    ];
    await Promise.all(files.map((file) => access(path.join(root, file))));

    const release = await readFile(path.join(root, "docs/AGENT_RELEASE.md"), "utf8");
    assert.match(release, /compatibility archive/i);
    assert.match(release, /status: not_built/);
    assert.doesNotMatch(release, /already signed|already notarized/i);
});

test("Windows installer source is per-user, background, and fail-closed for signing", async () => {
    const wix = await readFile(path.join(root, "installer/windows/Package.wxs"), "utf8");
    const launcher = await readFile(path.join(root, "installer/windows/launcher.c"), "utf8");
    const build = await readFile(path.join(root, "installer/windows/build.ps1"), "utf8");
    assert.match(wix, /Scope="perUser"/);
    assert.match(wix, /CurrentVersion\\Run/);
    assert.match(wix, /MajorUpgrade/);
    assert.match(wix, /StopRunningAgent/);
    assert.match(wix, /StartInstalledAgent/);
    assert.match(launcher, /CREATE_NO_WINDOW/);
    assert.match(launcher, /QueryFullProcessImageNameW/);
    assert.match(build, /WiX v4 is required/);
    assert.match(build, /-AllowUnsigned only for local installer testing/);
    assert.match(build, /publishable = \$false/);
    assert.doesNotMatch(build, /password|secret/i);
});

test("macOS installer source uses a user LaunchAgent and fail-closed notarization", async () => {
    const distribution = await readFile(path.join(root, "installer/macos/Distribution.xml.in"), "utf8");
    const plist = await readFile(path.join(root, "installer/macos/com.sneeai.agent.plist"), "utf8");
    const build = await readFile(path.join(root, "installer/macos/build-pkg.sh"), "utf8");
    const uninstall = await readFile(path.join(root, "installer/macos/uninstall-agent.sh"), "utf8");
    assert.match(distribution, /enable_currentUserHome="true"/);
    assert.match(distribution, /enable_localSystem="false"/);
    assert.match(plist, /com\.sneeai\.agent/);
    assert.match(plist, /ProcessType/);
    assert.match(build, /pkgbuild/);
    assert.match(build, /productbuild/);
    assert.match(build, /notarytool submit/);
    assert.match(build, /stapler validate/);
    assert.match(build, /COPYFILE_DISABLE=1/);
    assert.match(build, /'\.\_\*'/);
    assert.match(build, /xattr -cr/);
    assert.match(build, /publishable.*false/);
    assert.match(uninstall, /--remove-data/);
    assert.doesNotMatch(build, /BEGIN (?:RSA |EC )?PRIVATE KEY/);
});
