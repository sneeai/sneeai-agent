---
name: open-canvas
description: 打开 SneeAI 在线或本地画布，并通过远程 MCP 服务连接当前用户。用户要求打开、启动、进入或使用 SneeAI 画布时使用。
---

# Open SneeAI Canvas

默认打开在线版。插件通过远程 MCP 服务工作，不启动 Node Bridge，不要求用户安装或保持本机 Agent 进程运行。

前提：`https://sneeai.com/api/v1/agent/mcp` 及其 OAuth 元数据已由服务端部署并通过验收。仅安装本插件不会创建远程服务；服务未发布时应明确报告暂不可用。

## 首次连接自动化

在调用任何画布工具前，先确认当前 Codex 任务已经连接 `sneeai` MCP。若工具列表为空、服务返回未授权或连接状态不是 ready，必须由 Codex 自动完成下面的恢复流程，不要把命令交给用户：

1. 在 Codex 的终端执行 `codex mcp login sneeai`，读取命令输出的完整授权地址。
2. 使用浏览器打开这个授权地址；不要让用户复制地址、填写 token、配置端口或手动运行命令。
3. 如果授权页要求登录 SneeAI 或确认权限，只提示用户在已经打开的页面完成登录/确认；不要展示 OAuth、PKCE 或回调端口等内部术语。
4. 等待本地登录命令收到回调并退出成功，然后刷新 MCP 连接并重试原来的画布操作。
5. 只有真实调用 `canvas_get_state` 或其他当前画布工具成功后，才能向用户报告“已连接”。

如果登录命令失败、授权地址打不开或回调超时，明确报告连接失败原因并停止，不要伪造已连接状态，也不要重复执行有副作用的画布写操作。

## 在线版

1. 在浏览器打开：

```text
https://sneeai.com/canvas?mode=new
```

2. 如果 Codex 尚未获得 SneeAI 授权，按上面的“首次连接自动化”流程完成授权。

3. 授权后调用当前 SneeAI 画布工具；用户和画布由远程服务按 OAuth subject 隔离。

## 本地版

1. 在 SneeAI 项目中启动前端，并使用 Vite 输出的 `Local` 地址：

```bash
cd web
pnpm install
pnpm dev
```

2. 打开：

```text
<Vite Local 地址>/canvas?mode=new
```

本地前端仍通过同一个远程 MCP 服务工作，不读取本机 Agent 配置，也不接受手工 token。

## MCP 与连接边界

插件只声明 `sneeai` 远程 MCP 服务：`https://sneeai.com/api/v1/agent/mcp`。Codex 负责 HTTPS、OAuth 登录和 token 刷新；插件不保存或转发 bearer token。服务端必须在每次请求上按 OAuth subject 执行用户隔离、工具授权和画布绑定。

远程服务不可用、OAuth 过期、画布不存在或协议不兼容时，停止重试并给出明确恢复动作；不得猜测其他用户或画布，也不得重复执行写操作。

## 打开模式

用户没有明确指定打开方式时，始终使用 `mode=new` 新建画布。只有用户明确要求时才替换为：

- 最近画布：`mode=recent`
- 自己选择：`mode=choose`
