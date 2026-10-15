# 本地验收记录

日期：2026-10-15。宿主为 macOS arm64，Node.js 24.14.0，Go 1.25.5。以下区分真实宿主执行、离线 Pi 工具循环和在线模型调用。

## 已通过的验收

| 命令或场景 | 观察结果 |
| --- | --- |
| npm ci --ignore-scripts --no-audit --no-fund | 从开发锁文件重新安装成功 |
| npm run check | TS 类型与构建、Wire / Protobuf 一致性、Go 格式 / vet / race、37 项 TS 测试及实际启动通过 |
| 具名 local 配置 | workspace 与 scratch 在各自目录写入同名文件，再用各自 Bash 读取，内容互不混用；未知名称拒绝 |
| 配置文件与错误 | 相对 cwd 基于配置文件目录；重复名称、未知类型、未知字段、非法目录和混用参数拒绝 |
| 真实 Pi SDK 离线工具循环 | 真实 Pi SDK 调用项目工具，经真实 Go Runner 完成状态、文件和命令；模型响应由测试替身提供 |
| 本机远端服务测试 | 两个本机 Go 进程通过真实 WS 完成文件、输出、取消和断线清理；不是云端部署验收 |
| npm run pack:local | 宿主 tarball 生成，包含 darwin-arm64 二进制 |
| npm run pack:release | 六个目标构建通过：darwin / linux / win32 的 arm64 与 x64；共 12 个 Go 可执行文件 |
| 清单与 tarball | 二进制 SHA-256 与清单逐项一致，包内未包含 Go 源码、测试或环境文件 |
| npm run verify:package | 将 tarball 安装到临时独立项目，公开子入口、包内 Runner、具名文件与命令、取消后复用、进程清理和带 config 的 CLI 均通过 |
| node dist/main.js 配置启动 | 使用 examples/agent-kit.config.json 完成握手与 ping 并退出 |

安装包验收在独立目录运行，POSIX PATH 只包含 Node 目录、/usr/bin 和 /bin，不借用仓库的 .build 或开发依赖，不在运行时构建 Go。

## 独立安装发现并修复的问题

开发 lockfile 固定了 Pi 同组依赖 1.1.0；安装 tarball 的消费方不会沿用该 lockfile。Pi Coding Agent 1.1.0 的 ^1.1.0 间接依赖解析到了 1.2.0，其中 pi-codemode 删除了调用方需要的 MCP_TYPESCRIPT_PREAMBLE 和 mcpStructuredContentSchema 导出，导致 SDK 导入阶段失败。

修复是在 package.json 中直接固定现有依赖树里的 Pi 同组运行依赖为已验收的 1.1.0，不改变工具与 RPC 接口。再次独立安装确认这些包均为 1.1.0，SDK 导入及完整包验收通过。后续升级 Pi 需要同步验证该依赖组。

## 在线验收与覆盖边界

此前使用本机默认 Pi 配置的在线尝试返回 401 authentication_error / Invalid bearer token。随后通过本地 Sub2API 的独立配置接入 `gpt-6.1-sol`，真实 SDK 与网页对话均已通过环境查询、文件写入、命令执行、文件读取验收，网页最终输出 `AGENT_KIT_WEB_OK`。这不表示原来的默认 Pi 登录已被修改；详细入口与边界见 [聊天指南](web-chat.md)。

Windows / Linux 目前只有交叉编译产物，没有实机运行证据。构建目标与平台运行能力不能等同。新环境配置只支持 local，云端沙箱部署、身份权限与独立 Go module 发布不属于本次验收结果。

上下文 ContextService 仍是 [待实现方案](../architecture/context-runtime-plan.md)，本轮不将其列为通过能力。
