# SneeAI Codex Plugin

SneeAI is the stable Codex-side bridge for a separately installed SneeAI Agent. Users install the plugin in Codex and download the Agent from the SneeAI website; the Agent owns local discovery and current-canvas routing.

## Install

```bash
git clone https://github.com/sneeai/sneeai-agent.git
cd sneeai-agent
codex plugin marketplace add "$(pwd)"
codex plugin add sneeai@sneeai
```

Windows PowerShell uses `"$PWD"` instead of `"$(pwd)"`.

## Use

1. Install this Codex plugin once.
2. Download and install SneeAI Agent from the SneeAI website.
3. Open a new Codex task and say: `打开并连接 SneeAI Canvas`.

The plugin contains its small Codex bridge, but not the Agent runtime. It does not download, start, or pin an Agent version. Agent upgrades are independent. If the Agent is missing, stopped, or incompatible, the bridge reports that the user should download or update it.

## Secondary development

This plugin directory is licensed under `AGPL-3.0-only`. Custom distributions must use a distinct plugin name, branding, and marketplace identity. Plugins may extend prompts, skills, workflows, and authorized tools, but must not bypass Agent authorization, read website credentials, or choose arbitrary users or browser sessions.

See [plugin development](../../docs/PLUGIN_DEVELOPMENT.md) and the [Agent protocol boundary](../../docs/AGENT_PROTOCOL.md).
