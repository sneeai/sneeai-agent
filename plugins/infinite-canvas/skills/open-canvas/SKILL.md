---
name: open-canvas
description: 打开 SneeAI 在线或本地画布，并通过远程 MCP 服务连接当前用户。用户要求打开、启动、进入或使用 SneeAI 画布时使用。
---

# Open SneeAI Canvas

默认打开在线版。插件通过远程 MCP 服务工作，不启动 Node Bridge，不要求用户安装或保持本机 Agent 进程运行。

前提：`https://sneeai.com/api/v1/agent/mcp` 及其 OAuth 元数据已由服务端部署并通过验收。仅安装本插件不会创建远程服务；服务未发布时应明确报告暂不可用。

## 在线版

1. 在浏览器打开：

```text
https://sneeai.com/canvas?mode=new
```

2. 如果 Codex 尚未获得 SneeAI 授权，使用 Codex 的 MCP OAuth 登录流程完成授权。

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
