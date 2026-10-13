# agent-kit

包含 Pi Agent、TypeScript 工具层与 Go 执行底座的 Agent 框架。

当前已实现 **Effect / Pi 工具 → Go Runner → Environment → 本地或远端文件与 Bash 执行**。远端使用一条共享 WS / Protobuf 通道，提供 Client、独立 Go Server、输出事件、取消、状态确认与断线清理。使用入口见 [执行环境指南](docs/development/execution.md)；此前的 TypeScript 执行器保留在 `prototypes/typescript/`。

Environment 返回 Filesystem / Process；基本文件操作走 Filesystem，复杂操作通过同一环境的 Bash。本地直连宿主，远端采用 RPC，不要求本机挂载。macOS 已运行集成测试；Windows 和 Linux 已通过交叉编译，仍需实机验证。

Local 在调用进程所在宿主执行；Remote 由本机 Go Runner 调用独立的远端 Go 执行器，后者复用 LocalProcess / LocalFilesystem 访问自己的宿主。具体实现边界见 [本地执行方案](docs/architecture/local-execution.md) 与 [远端双进程方案](docs/architecture/remote-executor.md)。本机只作 RPC 调用方时无需 Bash。

远端底层使用一条共享 WebSocket 通道承载文件 RPC、命令输出和控制消息；TS ↔ 本机 Go 保留 stdio。分工见 [远端传输决策](docs/architecture/remote-transport.md)，连接规则见 [WS 通道方案](protocol/remote-channel.md)，字段和预算见 [Remote v1](protocol/remote/v1/README.md)。

## 启动框架

需要 Node.js 22.19+、Go 1.25+。已固定 Effect 4.0.3、Pi Coding Agent 1.1.0 和 Google Wire 0.7.0。

```sh
npm ci --ignore-scripts
npm start
```

默认启动会构建 TypeScript 和 Go Runner，通过 Effect Layer 启动 Go 进程，完成协议握手和 ping，打印状态，然后释放资源退出。这个检查不需要模型凭据。

## 让 Pi 检查框架

```sh
npm start -- --prompt "调用 agent_kit_status 检查框架是否可用"
```

该模式使用 Pi 已配置的模型和凭据，会发出真实模型请求。工具白名单按 Go 握手能力注册，包含环境查询、基本文件操作与 Bash。自动测试通过真实 Pi 工具循环和 Go Runner 验证状态、写文件与命令执行，模型输出使用离线测试替身。

## 使用 Effect 服务

以下代码在已经构建框架的项目中运行：

```ts
import { Effect } from "effect";
import { createAgentKit, RuntimeClient } from "agent-kit";

const app = await createAgentKit();
try {
  const result = await app.runtime.runPromise(Effect.gen(function* () {
    const client = yield* RuntimeClient;
    return yield* client.ping();
  }));
  console.log(result);
} finally {
  await app.close();
}
```

可以向 `createAgentKit` 的第二个参数提供替代的客户端 Layer，用于测试或后续接入其他传输实现。每个应用复用一个 ManagedRuntime，Scope 关闭时清理共享 Go 进程。每次请求中断会发送取消消息并等待 Go 请求终态，不关闭正常的共享连接。

`createAgentKit` 可配置 `runnerPath`、`args`、`requestTimeoutMs`、`shutdownTimeoutMs`、`maxMessageBytes` 和 `maxPendingRequests`。默认请求超时 5 秒、关闭等待 2 秒、消息上限 1 MiB、最多 64 个活动普通请求。运行器路径也可通过 `AGENT_KIT_RUNNER` 或 CLI 的 `--runner` 指定。

Go Runner 默认允许 32 个普通并发请求，可用 `--max-concurrent` 和 `--max-message-bytes` 配置。取消与关闭消息独立于普通并发额度。

## 当前初始化目录

```text
agent-kit/
├── src/
│   ├── main.ts                 # 启动入口和 Pi 会话入口
│   ├── bootstrap.ts            # Effect ManagedRuntime 装配
│   ├── runtime-client.ts       # 服务契约与 Effect 标识
│   ├── stdio-client.ts         # stdio Layer、通信与生命周期
│   ├── client.ts               # 旧入口的兼容重导出
│   ├── protocol.ts             # 框架协议类型和错误
│   ├── pi.ts                   # Pi 状态、环境、文件与命令工具
│   └── index.ts
├── go/
│   ├── go.mod
│   ├── go.sum
│   ├── cmd/runtime-runner/main.go
│   ├── cmd/remote-server/main.go
│   ├── environment/            # 公开契约、Manager 与 Local 适配
│   ├── remote/                 # 共享 WS Client、Server 与目标绑定
│   └── internal/
│       ├── di/                 # Wire provider、injector、生成代码
│       ├── runner/             # 框架通信入口与请求管理
│       ├── execution/          # Local 私有执行内核
│       ├── remoteproto/v1/     # Remote 私有消息转换
│       └── architecture/       # Go 依赖边界检查
├── protocol/README.md
├── test/                       # 跨语言、Layer 替换与 Pi 集成测试
├── scripts/check.sh
├── docs/
└── prototypes/typescript/      # 保留的旧执行器原型
```

当前一个 TypeScript 包、一个 Go module。目录按初始化职责组织，后续业务模块不在本阶段冻结。Go module 暂使用本地路径 `agent-kit`，发布时再确定正式 module 路径。

## 开发与验证

```sh
npm run check
```

统一执行 TypeScript 类型检查和构建、Wire / Protobuf 重新生成一致性、Go / TS 依赖边界检查、Go 格式检查、`go vet`、Go 竞态测试、跨语言与 Pi 集成测试，以及实际启动检查。协议生成检查需要本机 `protoc`；运行已生成代码不需要该编译器。

- `npm run build`：构建 TypeScript 与 Go，Runner 输出到 `.build/runtime-runner`。
- `npm run generate:wire`：使用 Go module 中固定版本的 Wire 工具生成初始化代码。
- `npm test`：构建 Go Runner 并运行 TypeScript 测试。

`wire_gen.go` 由工具生成，作为源文件保留，后续纳入 Git 提交；不手工编辑。普通构造函数和 Runner 不依赖 Wire 的运行时容器。

## 文档

- [架构规范入口](docs/architecture/standards.md)：领域边界、依赖方向与变更验收。
- [模块依赖与装配](docs/architecture/module-dependencies.md)：当前接口、Wire / Effect、兼容入口与依赖验证。
- [执行环境使用与验证](docs/development/execution.md)：本地、远端、Pi 工具和 Go SDK。
- [Agent 上下文索引](docs/context/index.md)：按任务定位相关说明、代码与测试。
- [上下文渐进式披露](docs/architecture/context-disclosure.md)：常驻入口与按需读取规则。
- [架构设计](docs/architecture/overview.md)
- [环境管理与能力接口](docs/architecture/environments.md)
- [本地执行方案](docs/architecture/local-execution.md)
- [远端双进程方案](docs/architecture/remote-executor.md)
- [远端传输决策与实施顺序](docs/architecture/remote-transport.md)
- [远端 WebSocket 通道方案](protocol/remote-channel.md)
- [Remote v1 消息与默认值](protocol/remote/v1/README.md)
- [远端文件 RPC 草案](protocol/filesystem-rpc.md)
- [Process 接口方案](docs/architecture/process.md)
- [Process RPC 与输出传输](protocol/process-rpc.md)
- [已实现的框架通信协议](protocol/README.md)
- [旧 TypeScript 原型说明](docs/prototypes/typescript-prototype.md)
