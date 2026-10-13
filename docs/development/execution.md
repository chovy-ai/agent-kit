# 使用本地与远端执行环境

状态：首版代码已实现。Go SDK 提供 Environment、基本 Filesystem 和一次性 Bash Process；Remote 复用一条 WS / Protobuf 通道。Pi 工具通过 Effect 和本机 stdio 调用这些能力。当前运行验证在 macOS 完成；Windows 与 Linux 已验证交叉编译，仍需各自实机验证。

## 启动远端服务

在仓库根目录构建并启动目标侧程序：

```sh
npm run build
.build/remote-server --listen 127.0.0.1:9220 --target host --cwd .
```

服务在该进程的宿主访问文件和执行 Bash。启动参数提供监听地址、targetId、默认目录与可选 `--bash` 可执行文件路径；当前没有部署配置文件、身份权限或会话恢复。Windows 执行侧需显式配置原生 Bash，例如 Git Bash；仅作为 RPC 调用方时无需 Bash。

本机 Runner 默认注册 `local`，配置远端连接后增加 `remote`。使用 TypeScript API 时通过 Runner 参数初始化：

```ts
import { createAgentKit, RuntimeClient } from "agent-kit";
import { Effect } from "effect";

const app = await createAgentKit({
  args: ["--remote-endpoint", "ws://127.0.0.1:9220", "--remote-target", "host"],
});
try {
  const result = await app.runtime.runPromise(Effect.gen(function* () {
    const client = yield* RuntimeClient;
    return yield* client.request("process.exec", {
      environmentId: "remote", command: "printf 'remote ready'",
    });
  }));
  console.log(result);
} finally {
  await app.close();
}
```

SDK 初始化期间完成 WS、Hello 与目标 GetInfo。连接失败不会返回半就绪应用；断线后原调用失败，不重连或补发命令。重新建立应用用于新的业务，不恢复原执行。

## 让 Pi 选择环境

启动时可向 CLI 提供本机目录与远端地址：

```sh
npm start -- --remote-endpoint ws://127.0.0.1:9220 --remote-target host --prompt "列出环境，然后在 remote 中执行 pwd"
```

Pi 的工具按 Runner 声明的能力注册：

| 工具 | 用途 |
| --- | --- |
| agent_kit_status | 查看握手与可用方法 |
| environment_list | 查找已注册 environmentId |
| filesystem_read / filesystem_write | 读写文件；UTF-8 或 base64 内容，Agent 默认额度 512 KiB |
| filesystem_read_dir / filesystem_stat / filesystem_mkdir | 列目录、查看元数据、创建目录 |
| process_exec | 一次性 Bash，支持目标目录、环境变量、超时与输出捕获额度 |

每次文件和命令调用都填写 environmentId。路径属于所选目标；复制、移动、删除与搜索等复杂操作通过该环境的 Bash 执行。未知环境失败，不改选目标。

TS SDK 可以通过 createPiAgent 统一创建 Pi 和 Go，或用 createAgentKit 与 app.createSession 分步嵌入；生命周期与模块替换见 [TS 模块说明](../architecture/typescript-modules.md)。

Process 的 stdout / stderr 通过事件传输，stdio 终态只携带完成摘要；TS 在受限缓冲中重建 base64 字节结果，Pi 再展示文本。非零退出是已完成的执行结果，Pi 将其标记为工具失败。取消确认不表示文件变更回滚。

## 直接使用 Go SDK

下面的代码在本仓库 `go` module 中可运行；远端服务需要先启动。Go 应用无需 Pi 或本机 Runner：

```go
package main

import (
	"agent-kit/environment"
	"agent-kit/remote"
	"context"
	"fmt"
)

func main() {
	ctx := context.Background()
	client, err := remote.Dial(ctx, "ws://127.0.0.1:9220", []string{"host"})
	if err != nil { panic(err) }
	defer client.Close()
	env, err := client.Environment("host")
	if err != nil { panic(err) }
	defer env.Close(ctx)
	result, err := env.Process().Exec(ctx, environment.ExecRequest{
		Command: "printf 'Go SDK ready'",
	}, nil)
	fmt.Printf("completion=%s stdout=%s error=%v\n", result.Completion, result.Stdout, err)
}
```

Client 是物理连接的所有者，Environment 借用它；先关闭环境再关闭 Client。关闭一个环境不影响同一 Client 上的其他环境，也不停止远端 Server。直接 SDK 应用可以用 Manager.Close 统一关闭注册环境；CLI 的环境与连接由 Wire provider 的 cleanup 统一管理，Runner 只借用 Directory。

本地构造入口为 `environment/local.New(local.Config{Cwd: ...})`。文件与命令共享稳定目录；Process 每次启动独立 Bash，结束时回收管理范围内的后台子进程。平台执行细节见 [本地方案](../architecture/local-execution.md)。

## 定位实现与验证

| 职责 | 入口 |
| --- | --- |
| 公开 Go 能力与环境管理 | [environment](../../go/environment/environment.go) |
| 宿主文件与执行适配 | [local](../../go/environment/local/environment.go)、[执行内核](../../go/internal/execution/engine.go) |
| 共享通道与两端 RPC | [Client](../../go/remote/client.go)、[Server](../../go/remote/server.go)、[channel](../../go/remote/channel.go) |
| 消息生成 | [四份消息源](../../protocol/remote/v1/README.md)、[生成脚本](../../scripts/generate-protocol.sh) |
| 启动装配 | [Wire injector](../../go/internal/di/wire.go)、[远端入口](../../go/cmd/remote-server/main.go) |
| Pi 与跨语言边界 | [工具装配](../../src/modules/agent/tools.ts)、[能力模块](../architecture/typescript-modules.md)、[stdio 适配器](../../src/modules/go-bridge/live.ts)、[Runner 业务分发](../../go/internal/runner/business.go) |
| 接口替换与依赖规则 | [模块依赖与装配](../architecture/module-dependencies.md)、[后端替换测试](../../go/remote/target_test.go)、[Go 导入检查](../../go/internal/architecture/dependencies_test.go)、[TS 导入检查](../../test/architecture.test.ts) |
| 行为证据 | [Go 两进程测试](../../go/remote/integration_test.go)、[本地测试](../../go/environment/local/local_test.go)、[stdio 远端测试](../../test/execution.test.ts)、[Pi 工具循环](../../test/pi.test.ts) |

```sh
npm run check
npm run generate:protocol
```

统一检查覆盖 TS 类型与构建、Wire 生成一致性、Go / TS 导入规则、接口替换、Go 格式、vet、竞态测试、跨语言与 Pi 集成及启动。消息生成使用 Go module 固定的 protoc-gen-go；重新生成还需要本机 protoc 和标准 include。正式服务当前使用 coder/websocket 1.8.15、Protobuf Go 1.36.11。

WS 单通道的发送与接收都有有界队列。网络失败的检测时延由心跳与 I/O 预算控制；已发送但无法确认的执行返回 unconfirmed。Windows Job Object 与 Linux 进程组清理已进入平台实现，交叉编译不能替代实机行为验证。普通文件系统调用的中途取消仍受宿主接口限制。
