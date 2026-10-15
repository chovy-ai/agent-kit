# 上下文索引

先按任务选择条目，再读对应说明和必要代码。索引区分已实现框架与业务设计；业务实现落地后补充实际源码和验证入口。

| 任务或主题 | 摘要与读取触发条件 | 首选说明 | 源码与验证入口 |
| --- | --- | --- | --- |
| 启动与当前能力 | 查看框架如何启动，核对已实现能力或原型状态 | [项目入口](../../README.md) | [main.ts](../../src/main.ts)、[bootstrap 测试](../../test/bootstrap.test.ts) |
| 领域边界 | 新增能力、拆分职责或改变依赖与公开接口 | [规范入口](../architecture/standards.md)、[领域规范](../architecture/domain-boundaries.md) | 当前模块与源码见模块依赖条目，新能力按职责新增 |
| 上下文披露 | 修改指令、文档路由、检索、读取或摘要 | [披露规范](../architecture/context-disclosure.md) | [仓库指令](../../AGENTS.md)、本索引；已有文件读取，专用索引展开尚未实现 |
| 具名环境配置 | 修改名称、配置文件、路径基准与 local 类型 | [配置指南](../development/configuration.md) | [公开定义](../../go/environment/config.go)、[解析](../../go/internal/runner/config.go)、[验收](../../test/configuration.test.ts)、[本地记录](../development/local-acceptance.md) |
| 打包与交付 | 修改二进制矩阵、CLI、包内定位与安装验收 | [打包指南](../development/packaging.md) | [矩阵](../../packaging/targets.json)、[构建](../../scripts/build-go.mjs)、[包验收](../../scripts/verify-package.mjs) |
| 运行时上下文设计 | 后续实现 ContextService、来源注册、索引和累计预算 | [设计方案](../architecture/context-runtime-plan.md) | 待实现，现有文件工具为兼容路径 |
| 当前模块依赖 | 核对 Directory / Target / RuntimeClient 契约、具体实现装配与兼容入口 | [模块依赖与装配](../architecture/module-dependencies.md) | [Go 导入检查](../../go/internal/architecture/dependencies_test.go)、[TS 导入检查](../../test/architecture.test.ts)、[Server 替换测试](../../go/remote/target_test.go) |
| TS 依赖与资源 | 修改模块服务、Layer、Scope、Pi 创建或桥接释放 | [TS 模块说明](../architecture/typescript-modules.md) | [启动装配](../../src/bootstrap/layers.ts)、[Bridge](../../src/modules/go-bridge/)、[模块测试](../../test/modules.test.ts) |
| TS 能力模块 | 修改环境、文件、命令服务与对应 Pi 工具；领域服务通过公开契约交互 | [环境模块](../../src/modules/environment/README.md)、[文件模块](../../src/modules/filesystem/README.md)、[命令模块](../../src/modules/process/README.md) | [TS 模块测试](../../test/modules.test.ts)、[导入检查](../../test/architecture.test.ts) |
| Pi 会话所有权 | 修改会话工厂、统一启动、取消或关闭竞态 | [Agent 模块](../../src/modules/agent/README.md) | [应用](../../src/bootstrap/application.ts)、[Agent Live](../../src/modules/agent/live.ts)、[真实 Pi 测试](../../test/pi.test.ts) |
| Go 启动装配 | 修改 provider、injector 或 Wire 生成 | [架构设计](../architecture/overview.md) 中的 Wire 约定 | [DI 入口](../../go/internal/di/)、[统一检查](../../scripts/check.sh) |
| 通信与请求生命周期 | 修改消息、并发关联、超时、取消或关闭 | [框架协议 v1](../../protocol/README.md) | [TS 协议](../../src/protocol.ts)、[stdio 客户端](../../src/modules/go-bridge/live.ts)、[Go Runner](../../go/internal/runner/)、[跨语言测试](../../test/bootstrap.test.ts) |
| Pi 集成 | 修改工具定义、白名单或 Pi / Effect 边界 | [项目入口](../../README.md) 中的 Pi 用法 | [工具装配](../../src/modules/agent/tools.ts)、[main.ts](../../src/main.ts)、[Pi 集成测试](../../test/pi.test.ts) |
| 环境管理与能力接口 | Manager 管理 Environment，返回同一目标的 Filesystem / Process；修改公开接口与所有权时读取 | [环境设计](../architecture/environments.md)、[领域规范](../architecture/domain-boundaries.md) | [公开 Go 契约](../../go/environment/environment.go)、[Local](../../go/environment/local/)、[Remote](../../go/remote/) |
| 远端传输决策与实施 | 核对共享 WS、RPC 职责与兼容接入；代码已实现，更多平台实测仍待完成 | [传输决策](../architecture/remote-transport.md) | [使用与验证](../development/execution.md)、[stdio](../../protocol/README.md) |
| 远端 WS 通道 | 修改 SDK Dial、Server Accept / Session、握手、取消、心跳、队列或断线时读取 | [WS 通道](../../protocol/remote-channel.md) | [Client](../../go/remote/client.go)、[Server](../../go/remote/server.go)、[channel](../../go/remote/channel.go) |
| 远端 v1 消息与默认值 | 修改 11 个方法、2 个事件、状态、错误详情及预算时读取；字段源与生成代码已提供 | [v1 契约](../../protocol/remote/v1/README.md) | [消息源](../../protocol/remote/v1/)、[生成代码](../../go/internal/remoteproto/v1/)、[生成脚本](../../scripts/generate-protocol.sh) |
| 远端文件 RPC | 修改五项文件方法、字节范围、路径、错误与副作用时读取；文件复用同一 WS | [文件 RPC](../../protocol/filesystem-rpc.md) | [文件 Client](../../go/remote/filesystem_client.go)、[文件 Server](../../go/remote/filesystem_server.go) |
| Process 接口与传输 | 修改一次性 Bash、双流、终态、取消与远端状态时读取 | [Process](../architecture/process.md)、[RPC](../../protocol/process-rpc.md) | [执行内核](../../go/internal/execution/engine.go)、[远端 Process](../../go/remote/process_client.go)、[两进程测试](../../go/remote/integration_test.go) |
| 本地执行实现 | 修改宿主文件、Bash 启动、输出管道、平台清理时读取；macOS 已实测，Windows / Linux 已交叉编译 | [本地执行](../architecture/local-execution.md) | [Local](../../go/environment/local/)、[平台内核](../../go/internal/execution/)、[本地测试](../../go/environment/local/local_test.go) |
| 远端双进程与部署 | 修改远端入口、目标绑定、连接所有权、Wire 或关闭时读取 | [远端执行器](../architecture/remote-executor.md) | [Server 入口](../../go/cmd/remote-server/main.go)、[Wire](../../go/internal/di/wire.go)、[stdio 远端测试](../../test/execution.test.ts) |

## 增加领域条目

确定一个正式领域后，记录其职责摘要、读取触发条件、局部说明与公开入口，以及源码和验证位置。列出直接依赖的公开契约，通过指针按需展开；不复制其他领域的完整说明。

技术初始化文件的位置不等于业务领域划分。历史原型用于参考行为，运行状态和事实以正式实现及契约核对。
