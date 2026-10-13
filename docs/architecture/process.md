# Process 接口方案

状态：Process v1 已进入 [公开 Go 契约](../../go/environment/environment.go)，[本地执行内核](../../go/internal/execution/engine.go) 与 [远端适配](../../go/remote/process_client.go) 已实现一次性 Bash。远端映射见 [Process RPC](../../protocol/process-rpc.md)，实际验证范围见 [执行指南](../development/execution.md)。

读取触发：实现或调整命令输入、输出、退出结果、超时、取消与资源清理。环境选择见 [环境接口](environments.md)。

实现职责分为 LocalProcess 直接执行所在宿主命令、RemoteProcess 通过 RPC 调用远端执行器。远端执行器同样复用 LocalProcess 执行其宿主命令；本机 RPC 调用进程和远端执行进程各自常驻，Bash 是执行侧启动的子进程。细节见 [本地执行](local-execution.md) 和 [远端执行器](remote-executor.md)。

## 公开接口

Process 已绑定环境。调用方通过 Environment.Process() 获取它；Exec 不再接受 environmentId、远端地址或 Shell 路径。下面是可独立编译的接口定义示例，此示例包名用于说明，正式入口为 environment 包：

```go
package processcontract

import (
	"context"
	"time"
)

type Process interface {
	Exec(ctx context.Context, req ExecRequest, onOutput OutputHandler) (ExecResult, error)
}

type ExecRequest struct {
	Command        string
	Cwd            string
	Env            map[string]string
	Timeout        time.Duration
	MaxOutputBytes int64
}

type OutputStream string

const (
	Stdout OutputStream = "stdout"
	Stderr OutputStream = "stderr"
)

type OutputChunk struct {
	Stream OutputStream
	Data   []byte
}

type OutputHandler func(context.Context, OutputChunk) error

type Completion string

const (
	NotStarted  Completion = "not_started"
	Finished    Completion = "finished"
	Unconfirmed Completion = "unconfirmed"
)

type ExecResult struct {
	Completion       Completion
	ExitCode         *int64
	Signal           string
	Stdout           []byte
	Stderr           []byte
	OutputTruncated  bool
	OutputIncomplete bool
	Duration         time.Duration
}
```

onOutput 可以为 nil，表示只要最终结果。Go 应用需要实时输出时传入回调；Pi 工具内部使用回调转发进度，Agent 只需传命令与可选工作目录等参数。

## 命令输入

| 字段 | 语义 |
| --- | --- |
| Command | 必填 Bash 脚本文本；完整地作为一次 bash -c 的参数传递 |
| Cwd | 空值使用环境默认工作目录；相对路径基于该目录，绝对路径属于目标环境 |
| Env | 仅本次命令的环境变量覆盖项；在目标侧合并配置的基础环境，不拼接进脚本 |
| Timeout | 0 使用环境默认值，初始默认 60 秒；负数无效；与 ctx 截止时间取较早者 |
| MaxOutputBytes | 最终结果合计保留 stdout / stderr 的字节上限；0 使用环境默认值，初始默认 1 MiB；负数无效 |

默认值可由宿主配置。Command 为空、路径或环境变量无效、目标不提供 Bash 等情况在启动前失败。

Bash 可执行文件由环境配置提供。命令不复用 Shell 会话，cd / export 不跨调用保留。第一版关闭 stdin，不提供交互式 PTY、持续 Shell、脱离管理的后台进程或 stdin 流。

## 输出

- stdout 与 stderr 分开标识，传递原始字节，不要求每块都是完整行或合法 UTF-8。
- 同一次 Exec 的回调串行执行，保持各流内读取顺序。跨流顺序表示执行器观察顺序，不声称还原进程内部的精确写入时序。
- SDK 为每个 OutputChunk 提供独立字节数据，回调可以保留；回调不修改 SDK 的内部结果缓冲。
- SDK 合计保留最早的 MaxOutputBytes 字节，分别写入结果的 Stdout / Stderr。超过上限设置 OutputTruncated，并继续消费输出。
- 回调输出与最终保留上限分别处理；传输队列、每帧大小与总转发量由执行侧配置限制，见 RPC 方案。
- 最终返回前完成输出排空，或明确标记 OutputIncomplete。返回后不再调用 onOutput。
- 回调应及时返回并遵守传入上下文。回调返回错误时取消该命令、处理清理，再返回 OUTPUT_FAILED；SDK 无法强制终止不响应上下文的用户函数。
- Pi 层按 stdout / stderr 分别进行增量文本解码；展示文本与 SDK 字节结果分开。截断后的不完整字符不能伪装成完整输出。

OutputTruncated 表示有意限制保留或转发量；OutputIncomplete 表示断线、读取错误或清理失败造成输出无法确认完整。两者允许同时为 true。

## 退出结果与错误

| 情况 | Completion 与 error |
| --- | --- |
| Bash 正常结束，退出码 0 | finished，ExitCode=0，error=nil |
| Bash 正常结束，退出码非零 | finished，保留实际退出码，error=nil；Pi 工具将该结果标为执行失败 |
| 参数错误、Bash 不可用或启动失败 | not_started，ExitCode=nil，返回对应错误 |
| 取消或超时，已确认管理的进程已结束 | finished，返回 CANCELLED / DEADLINE_EXCEEDED，并保留可确认的退出信息及部分输出 |
| 断线或清理超时，无法确认已结束 | unconfirmed，返回 OUTCOME_UNKNOWN，保留可获得的信息 |

Finished 表示受本次 Exec 管理的进程生命周期已结束，不表示文件副作用已回滚。Signal 只在目标能够确认信号信息时填写；无退出码时使用 nil，避免将 0 误报为成功。Duration 是执行侧测得的耗时，断线后无法获得权威耗时时使用已确认的部分信息并返回错误。

错误代码包括 INVALID_ARGUMENT、SHELL_UNAVAILABLE、START_FAILED、CANCELLED、DEADLINE_EXCEEDED、OUTPUT_FAILED、IO_ERROR、UNAVAILABLE、RESOURCE_EXHAUSTED、OUTCOME_UNKNOWN。Go 错误保留底层原因，取消与截止时间支持 errors.Is 判断；具体错误类型在源码实现时定义。

任何命令执行错误都不自动重试，不改选环境。返回值与 error 可同时包含信息，调用方遇到错误仍应读取 Completion 和部分输出。

## 生命周期

Exec 的 ctx 只控制本次执行，不关闭共享环境客户端。开始前取消不启动目标；执行中取消要落实到 Bash 及本次管理的子进程，然后确认终态。

Bash 自身正常退出时，同样结束本次管理范围内仍存活的子进程，再确认 finished，防止一次性命令留下持续占用输出管道的后台任务。

运行截止后使用独立、有界的清理上下文，初始确认宽限为 2 秒，可由宿主调整。正常运行预算和清理宽限分别计算；无法在宽限内确认停止时返回 unconfirmed，而非声称已取消成功。

Local Process 负责宿主进程管理。普通 CommandContext 默认只对它的 Process 调用 Kill，不能据此证明命令的子进程均已结束；本地适配器需要单独实现本次进程范围的管理。[Go CommandContext](https://pkg.go.dev/os/exec#CommandContext)

第一版管理 Bash 及适配器建立的进程范围。主动脱离该范围的进程不作为支持能力；环境隔离或更严格的进程容器管理属于后续扩展。原型行为见 [本地命令原型](../../prototypes/typescript/src/local/process.ts)，不能作为正式 Go 的平台验证。

Remote Process 将取消传播到目标执行服务，远端服务承担相同清理责任。仅关闭客户端、收到 RPC CANCELLED 或杀死本机 Runner 都不能证明远端 Bash 已结束。

公开 Exec 不增加启动回调或执行句柄。LocalProcess 与远端执行器共享内部执行内核，由它提供真实启动和清理通知。清理宽限耗尽返回 unconfirmed 后，执行侧所有者仍持有进程范围并继续回收；返回值不再异步修改，也不再调用输出回调。远端可通过内部状态查询获得后来确认的结果，见 [执行范围与通知](local-execution.md#内部执行范围与通知)。

Windows 使用配置的 Bash，取消范围与文件视图需要实机验证；不能静默换 Shell 或切换到另一环境。

## 完整方案与兼容落地

完整方案是 Local / Remote 实现同一个 Exec 契约，远端使用输出事件流与独立取消/状态查询，Pi 工具保持相同参数和结果语义。

兼容落地保留当前 stdio 框架，在两端增加输出事件和按执行预算配置的请求等待。当前 5 秒客户端默认超时只适合已有诊断调用，Exec 应按运行预算加清理宽限等待。现有只接受 result/error 的解析器不能直接处理新增事件。

Go 与 RPC 之间不传函数、context.Context、time.Duration 或 Go error 对象。适配器转换成请求、字节事件、毫秒时间与结构化错误。

## 验证

接口已进入正式代码，本地和远端测试验证了文件互通、成功 / 非零退出、双流、捕获上限、超时、取消与回调失败。更完整的平台及压力验证继续覆盖真实 Bash 成功/非零退出、双流与 UTF-8 跨块、最终输出上限、慢消费者、回调错误、超时/取消、子进程清理、断线终态查询、多环境文件互通与 Windows Bash 行为。
