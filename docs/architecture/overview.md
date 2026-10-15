# Agent Kit 当前架构

状态：首版执行能力已实现。本页描述正式源码；历史 TypeScript 执行器位于 prototypes/typescript，不参与正式入口。读取触发：核对整体职责、启动、通信、模块边界与当前交付范围。

## 从 Pi 到目标环境

```text
Pi 会话与工具
  → TS Effect 能力服务
  → 本机 Go Runner（stdio JSON）
  → Directory / Environment
      → Filesystem / Process
          → Local：宿主文件与 Bash
          → Remote：共享 WS / Protobuf → 独立执行器 → 目标宿主
```

TS 拥有 Pi 会话与本机桥接进程；Go 拥有执行环境、文件操作、命令及其受管理进程范围。Environment 返回 Filesystem / Process，调用方不依赖具体 Local 或 Remote。具体实现由 Effect Layer 和 Wire 在启动边界选择。

## 按名称配置环境

[具名配置](../development/configuration.md) 当前只支持 local 类型。宿主通过配置文件或 TS 对象声明名称与默认目录，工具的 environmentId 使用该名称。多个 local 是同一宿主上的不同实例，不提供文件权限或沙箱隔离。

不提供具名配置时，旧入口继续注册 local，并允许通过旧参数接入一个 remote。Remote SDK、独立 Server 和 WS 能力已经实现，尚未加入新配置的类型集合。SDK 的 Manager 可以注册任意实现 Environment 契约的实例。

## 模块与资源所有权

| 范围 | 契约与实现 | 构造与释放 |
| --- | --- | --- |
| TS 五个能力模块 | go-bridge、environment、filesystem、process、agent | Effect 服务与 Layer，由一个 ManagedRuntime 管理 |
| Pi 会话 | AgentService / AgentSessionFactory | createPiAgent 或 app.createSession；应用关闭时先清理会话 |
| 本机 Go 程序 | RuntimeClientService / stdio | 会话创建前完成 Hello，最后关闭 Runner |
| 环境注册与路由 | Directory / Manager | Wire provider 构造具名 Local，旧模式可构造 Remote binding |
| 宿主执行 | Environment / Filesystem / Process | Local 的文件接口和私有平台执行内核 |
| 远端执行 | Client / Environment / Target / Server | Client 拥有 WS，Environment 借用连接；Server 独立部署 |

[模块依赖](module-dependencies.md) 列出公开入口、导入检查与替换测试；[TS 模块](typescript-modules.md) 说明服务替换、会话取消与关闭顺序。Go 普通构造函数不依赖 Wire 的运行时容器，生成的 wire_gen.go 已纳入版本控制。

## 文件和命令契约

Filesystem 提供 ReadFile、WriteFile、ReadDir、Stat、Mkdir；不要求 io/fs.FS 兼容或提供远端文件句柄。复制、移动、删除、搜索等通过同一环境的 Process 执行 Bash。

Process.Exec 是一次性、无 stdin、无 PTY 的 Bash 调用，显式指定 cwd / env，Shell 状态不跨调用保留。输出为 stdout / stderr 原始字节，支持回调与有界捕获；终态区分 not_started、finished、unconfirmed。非零退出不是传输错误。

未知环境不回退；文件写入和命令不自动重试。取消确认与进程结束分开处理，断线不能被描述为执行已停止。所有权、预算与平台边界分别见 [Process](process.md)、[Local](local-execution.md)、[远端执行器](remote-executor.md)。

## 两条通信链路

TS 到本机 Go 使用 [stdio v1](../../protocol/README.md)，包括诊断、环境、文件、命令、输出事件、取消和关闭。Go 到远端执行器使用一条共享 [WS 通道](../../protocol/remote-channel.md)，通过独立版本的 Protobuf 信封复用请求、双流和控制消息。

Remote 在初始化时完成 Hello 和目标 GetInfo；单个请求取消不关闭共享连接，连接失效后立即失败，不自动重连或补发原操作。本版不提供身份权限、沙箱创建或远端程序上传启动。

## Agent 上下文

[AGENTS.md](../../AGENTS.md) 提供短入口，[上下文索引](../context/index.md) 按任务指向规则、源码和测试。运行时已有显式环境的文件工具、UTF-8 分段与固定展示预算；自动主题展开、累计上下文预算和缓存仍未实现。

新的 [运行时上下文方案](context-runtime-plan.md) 以 ContextService、来源注册与只读展开作为根本方案，保留沿索引使用现有文件工具的兼容路径；本轮只记录方案，不描述为已经交付。

## 构建与验收

[打包指南](../development/packaging.md) 提供宿主包和多平台包，安装包携带对应 Go 程序并注册 CLI；当前只生成本地 tarball，不执行发布。源码构建需要 Go，安装包运行需要 Node.js，执行命令的目标需要 Bash。

[统一检查](../../scripts/check.sh) 覆盖 TS 类型与构建、生成一致性、Go 格式 / vet / race、边界与接口替换、跨语言和离线 Pi 工具循环。具名环境与安装包有独立验收入口。macOS 有运行证据，Windows / Linux 的交叉编译不能代替各自实机验证。

## 明确的扩展边界

- 新配置后续可增加 remote 类型，但需先明确连接配置与资源所有权，不把旧参数混入新定义。
- PTY、持续 Shell、stdin、后台服务、FUSE、沙箱自动创建和断线续传未纳入当前 Process / 文件契约。
- 本地默认 cwd 只是路径基准，Remote 服务同样沿用执行侧宿主权限；更强隔离需要独立适配器或部署边界。
- 独立 Go module 发布、npm 发布和更多平台实机验收仍需各自完成，打包成功不表示这些工作已经完成。
