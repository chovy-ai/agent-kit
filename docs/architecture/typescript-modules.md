# TypeScript 模块与统一启动

状态：五个 TS 模块、Effect 服务图、Pi 会话所有权与兼容入口已实现。模型与认证沿用 Pi 配置；`createAgentKit` 的诊断和能力调用不创建模型会话。

读取触发：修改 TS 能力服务、工具、模块依赖、Layer、Pi 创建或应用关闭。

## 从一个入口启动 Pi 和 Go

`createPiAgent` 先构造应用服务图，启动 Go Runner、完成 Hello，再创建使用本项目工具白名单的 Pi 会话。创建失败会释放已经启动的 Runner：

```ts
import { createPiAgent } from "agent-kit";

const app = await createPiAgent({ runner: { args: ["--cwd", "."] } });
try {
  await app.session.prompt("在 local 环境中列出当前目录");
  console.log(app.session.getLastAssistantText());
} finally {
  await app.close();
}
```

嵌入应用可以先调用 `createAgentKit(options, clientLayer?, layers?)` 获取服务和工具，再调用 `app.createSession(sessionOptions, signal?)`。两种方式都使用一个 ManagedRuntime；创建多个会话共享同一个 Go Bridge。`app.closeSession(session)` 可以提前释放本应用拥有的会话。

`sessionOptions` 透传 Pi 的模型、ResourceLoader、设置等配置；工具集合由应用装配决定。会话默认使用内存 SessionManager。远端 Server 仍由目标宿主管理，本机配置远端地址后连接它。

## 按职责找代码

| 模块 | 公开契约与职责 | 实现位置 |
| --- | --- | --- |
| go-bridge | RuntimeClient、RunnerConfig、协议与错误；拥有本机 Go 进程和 stdio 连接 | [模块入口](../../src/modules/go-bridge/index.ts)、[Live](../../src/modules/go-bridge/live.ts) |
| environment | EnvironmentService；查询已注册 ID，运行时目标路由仍在 Go | [模块入口](../../src/modules/environment/index.ts)、[工具](../../src/modules/environment/tools.ts) |
| filesystem | FilesystemService；目标文件的字节读写、目录、信息和创建目录 | [模块入口](../../src/modules/filesystem/index.ts)、[工具](../../src/modules/filesystem/tools.ts) |
| process | ProcessService；执行、双流字节输出及完成状态 | [模块入口](../../src/modules/process/index.ts)、[工具](../../src/modules/process/tools.ts) |
| agent | AgentService、AgentSessionFactory；Pi 会话和工具集合装配 | [模块入口](../../src/modules/agent/index.ts)、[工具装配](../../src/modules/agent/tools.ts) |

领域服务使用 `Context.Service` 声明契约；Live Layer 实现契约，负责调用 Bridge 并验证返回值。文件和进程服务返回 Uint8Array；base64 留在 RPC 适配边界。工具负责 Schema、编码选择和模型可见结果，不直接调用通用 request。

```text
Pi 工具 → Environment / Filesystem / Process 服务 → RuntimeClient → Go SDK
bootstrap → 选择 Live Layer → 一个 ManagedRuntime 与资源 Scope
```

跨模块依赖通过 `index.ts`；工具注册器是装配入口，可以导入各模块公开的 `tools.ts` 适配器。启动层与旧入口兼容层可以选择具体 Live 实现。`tooling/` 只包含多个工具实际共享的 Promise / AbortSignal 边界、Schema 和结果展示。

## 共享资源如何释放

[Layer 装配](../../src/bootstrap/layers.ts) 先提供一份 Bridge，组合三个能力 Layer，再构造依赖 Bridge 的 AgentService。替换 Layer 同样进入这一个服务图，不额外创建子进程。

关闭应用会中断 ManagedRuntime 的活动调用。AgentService 先等待正在创建的会话落定，并对已拥有的会话执行 abort / dispose，之后释放 Bridge；会话清理失败仍释放其余资源，并报告关闭错误。初始化失败由 Scope 释放已经获取的依赖。

Pi 当前默认异步创建函数没有 AbortSignal 参数。调用中断后，迟到会话仍由 AgentService 拥有并清理；应用关闭会等待这一过程。替换的 AgentSessionFactory 可以接收 AbortSignal 并提前停止创建，不能把默认实现描述成即时取消。

单个命令或文件调用取消沿 RPC 传到 Go；正常共享连接继续可用。写入响应失效时保留可能已修改的状态，非法执行终态标为未确认，不自动重试或切换环境。

## 工具结果与按需读取

工具名与参数保持兼容，按 Hello.methods 启用。七个业务工具和诊断工具仍可使用；环境查询当前返回 ID，完整环境描述尚待扩展。

模型可见文本上限为 16 KiB，包含截断提示。文件工具在 UTF-8 字符边界截断并给出字节 nextOffset；原 offset / length 始终按字节解释。Process 的展示截断通过 displayTruncated 表达，SDK 捕获截断继续使用 outputTruncated，输出不完整使用 outputIncomplete。SDK 服务返回完整的受限捕获数据，工具展示不改变底层执行预算。

`details` 保留文件环境、路径、读取范围等诊断信息。命令的完成状态、退出码和截断字段同时写入模型可见结果。大目录可以通过同环境的 Process 筛选。完整命令日志持久化与自动上下文索引展开尚未实现。

## 兼容与替换

旧 `bootstrap.ts`、`client.ts`、`runtime-client.ts`、`stdio-client.ts`、`protocol.ts` 保留兼容导出；Effect 标识没有改变。旧 `createFrameworkTools` 仍接受只有 RuntimeClient 的 ManagedRuntime，纯能力 Layer 借用它的连接。新的应用启动路径一次性构造全部能力服务。

包新增 `agent-kit/environment`、`agent-kit/filesystem`、`agent-kit/process`、`agent-kit/agent`、`agent-kit/go-bridge` 契约入口。`createAgentKit` 的第三个参数接受 environment、filesystem、process、sessionFactory 的替换 Layer；第二个参数继续接受替换客户端 Layer。

## 验证入口

`npm run check` 覆盖类型、构建、导入规则、Go / TS / Pi 集成和资源关闭。专项验证见 [模块测试](../../test/modules.test.ts)、[依赖检查](../../test/architecture.test.ts)、[真实 Pi 测试](../../test/pi.test.ts)、[远端跨语言测试](../../test/execution.test.ts)。导入规则包含拒绝跨模块私有实现的反例；它检查字面量导入，不覆盖运行时拼接模块名。
