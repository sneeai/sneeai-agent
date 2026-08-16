# SneeAI

SneeAI connects the Codex plugin to an independently installed local Agent. The intended user flow has two visible steps: install the SneeAI plugin in Codex, then download the Agent from `sneeai.com`. Connection and current-canvas routing are Agent responsibilities; users should not need to copy ports, URLs, or tokens.

## Install the Codex plugin

```bash
git clone https://github.com/sneeai/sneeai-agent.git
cd sneeai-agent
codex plugin marketplace add "$(pwd)"
codex plugin add sneeai@sneeai
```

On Windows PowerShell, use `$PWD` instead of `$(pwd)`.

## Agent delivery

Production users should receive a signed Windows installer or a signed and notarized macOS installer. The current build script still produces ZIP/TAR compatibility archives for development, recovery, and installer input. Those archives are not one-click installers and must not be presented as such while installer delivery remains blocked.

See [installer/README.md](installer/README.md) and [docs/AGENT_RELEASE.md](docs/AGENT_RELEASE.md) for the factual release status.

## Start the local Agent during development

```bash
cd canvas-agent
npm install
npm run build
npm start
```

The Agent is not distributed through npm and is updated independently from the Codex plugin. Codex credentials stay on the user's device.

See [canvas-agent/README.md](canvas-agent/README.md) for commands and configuration.

## Plugin extensions

The plugin source is available for secondary development under its declared license. Custom builds must use a distinct identity and keep the Agent security boundary intact. Start with [docs/PLUGIN_DEVELOPMENT.md](docs/PLUGIN_DEVELOPMENT.md) and [docs/AGENT_PROTOCOL.md](docs/AGENT_PROTOCOL.md).
