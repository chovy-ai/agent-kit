# 使用聊天页面

状态：默认提供以对话为主的 Agent Kit 界面，使用 React 与 `@nextop-os/ui-system`；后端复用社区 [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) 0.104.4 与 Pi 1.1.0。网页中的 Agent 文件和命令工具经过 Agent Kit / Go；页面目前在本地运行。

## 在对话中查看执行

输入任务后，回复流式显示。文件读写、目录查询和命令执行作为对话中的操作记录，默认收起；点击可查看目标环境、命令、输出、退出码、耗时与调用参数。工具失败显示错误，明确的取消结果显示“已停止”。这是一套参考 Codex 交互的独立界面，不复制上游页面组件。

输入框下方选择执行环境，默认优先 `workspace`，其次 `local`。选择只影响下一条任务；已执行记录保留实际 environmentId。Enter 发送，Shift+Enter 换行；执行过程中可以追加排队消息，也可以点击停止。左上角打开历史，右上角新建对话。向上阅读时不强制滚到底部，可点击“回到最新消息”。

断开连接会保留输入并自动重连，不自动重发命令或任务。URL 中的会话标识用于恢复原对话；临时空白快照不会覆盖恢复目标。历史不可用时明确提示。取消时尚未写入会话的实时输出只在当前页面保留，刷新或重连后不保证恢复；完整执行日志持久化仍未实现。

## 打开页面

在仓库根目录运行：

```sh
npm ci --ignore-scripts
cp .env.example .env.web.local
```

将本地 Sub2API 后台中已有的 `codex-local` API Key 填入 `.env.web.local` 的 `AGENT_KIT_API_KEY`。当前开发机已配置，可以直接启动：

```sh
npm run start:web
```

打开 <http://127.0.0.1:8787>。默认模型为 `gpt-6.1-sol`，API 为 `http://127.0.0.1:8080/v1`，使用 Responses 协议。需要先启动 Sub2API。停止服务按 Ctrl+C；再次启动保留聊天记录。构建产物会复制到独立的运行目录，随后运行检查或重新构建不会清掉已启动页面的环境配置。

首次对话可以输入：

```text
列出可用环境，然后使用 local 环境查看当前目录。
```

如果配置了下面的具名环境示例，将 `local` 改成 `workspace`。模型先通过 `environment_list` 发现名称，每次文件或命令调用仍显式传 `environmentId`，未知名称不会回退本机。

## 配置环境与模型

`.env.web.local` 支持以下配置。环境变量优先于该文件；密钥仅由服务进程读取。`.env.web.local` 与 `.agent-kit/` 已被 Git 忽略。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `AGENT_KIT_API_KEY` | 必填 | Sub2API 客户端 Key，不能填写 Codex OAuth token |
| `AGENT_KIT_MODEL_BASE_URL` | `http://127.0.0.1:8080/v1` | Responses API 地址 |
| `AGENT_KIT_MODEL` | `gpt-6.1-sol` | 新会话的默认模型 |
| `AGENT_KIT_WEB_PORT` | `8787` | 页面端口 |
| `AGENT_KIT_WEB_CWD` | 仓库根目录 | 页面工作目录与未具名 local 环境的默认目录 |
| `AGENT_KIT_ENV_CONFIG` | 不设置 | [具名环境 JSON](configuration.md)，当前只支持 local |
| `AGENT_KIT_WEB_STATE_DIR` | `.agent-kit/web` | 隔离的 Pi 配置、聊天记录与页面状态 |
| `AGENT_KIT_WEB_UI` | `chat` | `chat` 使用简洁对话框，`classic` 使用原版上游页面 |

使用具名环境：

```sh
npm run start:web -- --config ./examples/agent-kit.config.json --port 8787
```

也可以在 `.env.web.local` 设置 `AGENT_KIT_ENV_CONFIG=./examples/agent-kit.config.json`。启动器将路径转成绝对路径；配置内 cwd 仍以 JSON 文件所在目录为基准。当前开发机使用此示例，提供 `workspace` 与 `examples`。

`--cwd`、`--config`、`--port`、`--state-dir`、`--ui` 覆盖对应环境变量；`--env-file` 可以选择其他本地环境文件。修改模型地址、环境配置、前端构建或凭据后重启服务。环境变量定义新目录的初始模型，不覆盖已有的 Pi 模型选择；默认对话框只显示当前模型，更多设置可使用兼容页面。

原版页面的兼容入口：

```sh
npm run start:web -- --ui classic
```

启动器生成的 `models.json` 只包含 `${AGENT_KIT_API_KEY}` 引用，不包含实际 Key。模型上下文 32768、最大输出 4096 是本接入的保守客户端预算，不代表模型服务上限；费用元数据未接入，页面金额不作为账单依据。

## 接入边界

```text
Agent Kit 对话框 → pi-web-ui WebSocket / Pi 会话
                       ↓ Pi extension
                 Agent Kit 公开入口
                       ↓ Effect 服务
                 Go Runner → 具名 Environment → Filesystem / Process
```

页面宿主拥有 Pi 会话；扩展只创建工具应用，不额外创建 Pi 会话。每个扩展运行时拥有一个 ManagedRuntime 和 Go Runner，同一会话中的工具共享它们。`session_start` 完成 Go 握手后才注册工具；`session_shutdown` / reload 等待关闭，清理命令和进程。

根本方案是自有对话展示层消费已有会话协议，执行能力经统一 Pi extension 使用领域服务。兼容方案保留 `--ui classic`、原来的 `createPiAgent`、SDK 与单次 CLI。前端不持有模型 Key，不直接调用模型或操作宿主文件。其他 Pi 宿主也可以加载包内扩展：

```sh
npm run build
./node_modules/.bin/pi --extension ./dist/integrations/pi-extension.js
```

模型凭据沿用该宿主的 Pi 配置；这条兼容命令不会自动读取网页的 `.env.web.local`。扩展默认使用当前会话 cwd，也可通过 `AGENT_KIT_ENV_CONFIG` 指定配置。公开工厂为 `agent-kit/pi-extension` 的 `createAgentKitExtension(runnerOptions?)`。

聊天 Agent 的活动工具集合限定为握手后注册的 Agent Kit 工具，宿主重置预设后会在下一轮恢复。其他工具调用被拒绝；`!` / `!!` 快捷命令提示使用显式环境工具。此约束属于本接入路由，不是操作系统沙箱。

默认页面仅提供对话、执行记录、具名环境选择和历史，不包含上游文件浏览器、终端或 Git 面板。兼容页面启用聊天与设置标签，其侧边文件浏览和附件处理仍访问页面服务器所在宿主，不是远端文件管理器。切换页面工作目录不会改写显式具名环境；当前具名环境只支持 local，云端部署与权限沙箱不在本次接入范围内。

前端位于 `web/`：`state.ts` 适配消息与工具事件，`session.ts` 处理恢复目标，`connection.ts` 用 Effect Layer / Scope 管理 WebSocket、订阅和重连定时器。只消费固定上游版本的协议 29：`hello`、`snapshot` / `snapshot_delta`、`message_delta`、`tool_delta` / `tool_status`、会话与任务操作；字段和顺序保持上游协议，修订不连续时请求完整快照，不把后台对话增量混入当前对话。`process_exec` 的实时预览是累计文本，前端替换而不重复拼接。

职责归属、状态流和兼容决策见 [对话架构](../architecture/chat-interface.md)。

按钮、输入框、选择器、确认区域、状态点和加载指示均使用 UI System 的公开入口，导入 `@nextop-os/ui-system/styles.css`。自定义样式只组织对话布局、Markdown 和执行记录，颜色、字体、边框与阴影使用语义 token。

网页作为开发入口依赖 `devDependencies`，不增加 SDK 消费方的前端依赖。打包产物包含 extension 与类型声明；网页需在源码仓库安装开发依赖运行。升级 Pi 或前端时，固定版本一起验证，不使用全局 Pi SDK 替换。

## 验证

```sh
npm run test:web
npm run check
```

2026-10-15 在 macOS arm64 通过浏览器发出真实任务，模型经 Sub2API 调用 `environment_list`、`filesystem_write`、`process_exec`、`filesystem_read`，在 `workspace` 写入并读回 `agent-kit-web-ok`，最终输出 `AGENT_KIT_WEB_OK`。原始会话位于被忽略的 `.agent-kit/web/agent/sessions/`；开发机截图为 `.build/web-ui-acceptance.jpg`。

浏览器 `/reload` 的兼容入口验收确认旧 Go Runner 退出，并只保留一个新 Runner。默认对话框另通过真实中文文件读写、命令执行、实时输出、停止及实际进程退出、环境选择、历史恢复、服务重启重连与草稿保留验收；原版页面兼容启动也通过。默认界面的证据为 `.build/dialog-acceptance.jpg`、`.build/dialog-stop.jpg` 与 `.build/dialog-stop-result.json`。

专项测试覆盖延迟初始化、具名路由、未知环境拒绝、宿主工具拦截、关闭中断执行、密钥不写入模型配置，以及累计预览、重复事件、跨会话隔离、缺失修订、取消识别和历史恢复竞争。完整检查通过 45 项 TS 测试、2 项网页配置测试，以及 Go、Wire、Protobuf、模块边界和原有跨语言回归。SDK 宿主 tarball 的独立安装验证包含 `pi-extension` 公开入口；Windows / Linux 尚未做网页实机验收。
