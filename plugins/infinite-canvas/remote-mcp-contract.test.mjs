import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pluginDir = dirname(fileURLToPath(import.meta.url));
const read = (relativePath) => readFile(resolve(pluginDir, relativePath), "utf8");

test("declares the SneeAI service as a remote HTTP MCP server", async () => {
  const config = JSON.parse(await read(".mcp.json"));
  const server = config?.mcpServers?.sneeai;

  assert.deepEqual(Object.keys(config.mcpServers), ["sneeai"]);
  assert.equal(server?.type, "http");
  assert.equal(server?.url, "https://sneeai.com/api/v1/agent/mcp");
  assert.deepEqual(server?.oauth, { client_id: "sneeai-codex-plugin" });
  assert.equal(typeof server.startup_timeout_sec, "number");
  assert.equal(typeof server.tool_timeout_sec, "number");

  // A remote plugin must not silently fall back to a local process or carry
  // credentials in its connection declaration.
  for (const forbiddenKey of ["command", "args", "cwd", "env", "headers", "token", "apiKey", "api_key"]) {
    assert.equal(Object.hasOwn(server, forbiddenKey), false, `unexpected local/credential key: ${forbiddenKey}`);
  }
  assert.equal(new URL(server.url).protocol, "https:");
});

test("does not ship the retired local Node bridge inside the plugin", async () => {
  await assert.rejects(
    access(resolve(pluginDir, "bin/sneeai-bridge.mjs")),
    (error) => error?.code === "ENOENT",
  );
});

test("manifest points to the remote MCP declaration", async () => {
  const manifest = JSON.parse(await read(".codex-plugin/plugin.json"));
  assert.equal(manifest.name, "sneeai");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.match(manifest.description, /remote MCP/i);
  assert.match(manifest.interface.longDescription, /OAuth/i);
});

test("keeps the existing canvas tool contract visible to the plugin", async () => {
  const skill = await read("skills/canvas/SKILL.md");
  const expectedTools = [
    "canvas_get_state",
    "canvas_get_selection",
    "canvas_create_text_node",
    "canvas_generate_text",
    "canvas_generate_image",
    "canvas_generate_video",
    "canvas_generate_audio",
    "canvas_create_generation_flow",
    "canvas_apply_ops",
  ];

  for (const toolName of expectedTools) {
    assert.match(skill, new RegExp(`\\b${toolName}\\b`), `missing tool: ${toolName}`);
  }
});

test("automates the first remote MCP authorization instead of handing a command to the user", async () => {
  const skill = await read("skills/open-canvas/SKILL.md");

  assert.match(skill, /codex mcp login sneeai/);
  assert.match(skill, /authorization URL|授权地址/i);
  assert.match(skill, /open|打开.*授权/i);
  assert.match(skill, /wait|等待.*回调/i);
  assert.match(skill, /retry|重试.*canvas|重试.*画布/i);
  assert.doesNotMatch(skill, /(?:让|要求|请)用户(?:手动)?运行\s*`?codex mcp login sneeai/i);
});

test("documents OAuth ownership and cross-user isolation", async () => {
  const [readme, skill, protocol, development] = await Promise.all([
    read("README.md"),
    read("skills/open-canvas/SKILL.md"),
    read("../../docs/AGENT_PROTOCOL.md"),
    read("../../docs/PLUGIN_DEVELOPMENT.md"),
  ]);
  const documentation = [readme, skill, protocol, development].join("\n");

  assert.match(documentation, /OAuth/i);
  assert.match(documentation, /user isolation|用户隔离/i);
  assert.match(documentation, /does not start a Node process|不启动 Node Bridge/i);
  assert.match(documentation, /must not.*(token|credentials)|不得.*(token|凭据)/is);
  assert.match(protocol, /protocol major version/i);
  assert.match(development, /custom distribution must use its own name and identity/i);
  assert.doesNotMatch(documentation, /rmcp_client/i);
});
