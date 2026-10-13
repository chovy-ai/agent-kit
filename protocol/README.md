# Agent Kit stdio 协议 v1

本文对应已实现的 TypeScript ↔ Go Runner 通信。远端 Go ↔ Go 使用独立的 [WS 通道](remote-channel.md) 与 [Remote v1](remote/v1/README.md)。框架诊断保持原格式，文件与命令能力通过 Hello 的 methods / events 声明。

## 请求与能力

stdin / stdout 传输 UTF-8 逐行 JSON，Go 日志写入 stderr。本项目格式不声明兼容 JSON-RPC 2.0：

```json
{"version":1,"id":"request-001","method":"system.ping","params":{}}
```

id 在活动请求中唯一，SDK 使用 UUID；version 必须为 1。Hello 返回 name、protocolVersion、methods 和 events，当前事件为 process.output。调用方只调用协商的方法；旧诊断调用不会产生输出事件。

| 方法 | 参数与结果 |
| --- | --- |
| system.hello | 空对象 → 框架名称、版本、方法及事件 |
| system.ping | 可选 delayMs，0–60000 → ok=true |
| request.cancel | requestId → cancelled=true/false，确认找到请求并提交取消 |
| system.shutdown | 空对象 → stopping=true，随后清理请求及所属环境 |
| environment.list | 空对象 → 已注册的环境 ID |
| filesystem.read | environmentId、path、可选十进制字符串 offset 与字节 length → base64 data |
| filesystem.write | environmentId、path、base64 data → 十进制字符串 bytesWritten |
| filesystem.readDir | environmentId、path → name / type 条目 |
| filesystem.stat | environmentId、path、followSymlinks → type、十进制字符串 size、RFC 3339 modifiedAt |
| filesystem.mkdir | environmentId、path、recursive → created=true |
| process.exec | environmentId、command、可选 cwd / env / timeoutMs / maxOutputBytes → 输出事件与终态摘要 |

Runner 默认注册 local，提供远端参数后增加 remote。所有文件与命令参数中的路径均属于目标；未知环境失败，不回退。基本文件内容默认限制为 512 KiB，还检查完整编码消息额度。

## 响应与命令事件

普通结果与错误互斥：

文件错误可附带 details.reason 与 details.mutationState，TS 的 RunnerError 保留这些详情，区分尚未修改与可能已修改。

```json
{"version":1,"id":"request-001","type":"result","result":{"ok":true}}
```

```json
{"version":1,"id":"request-001","type":"error","error":{"code":"CANCELLED","message":"Request cancelled"}}
```

Process 使用同一 id 发送零到多个事件，事件不结束等待：

```json
{"version":1,"id":"exec-001","type":"event","event":"process.output","data":{"stream":"stdout","data":"aGVsbG8="}}
```

最终结果只携带完成摘要，避免 base64 输出超出单消息额度：

```json
{"version":1,"id":"exec-001","type":"result","result":{"completion":"finished","exitCode":0,"signal":"","durationMs":10,"outputTruncated":false,"outputIncomplete":false}}
```

摘要可以包含 executionError，与部分执行结果同时存在。非零退出属于 finished 的正常结果。TS 客户端按双流捕获上限重建 stdout / stderr base64 字节；Pi 工具再解码并将非零退出或执行错误标记为工具失败。

取消确认还需要原调用终态。单个执行取消不关闭共享 WS；无法确认时返回明确错误，不把它统计为成功停止。程序不提供交互式 stdin 或 PTY。

## 预算、限制与失败

诊断请求默认等待 5 秒。文件调用等待 12 秒；Exec 等待默认运行预算加 5 秒，支持单调用覆盖。执行中断使用独立确认窗口。终态未确认的命令可能仍由执行侧继续清理，不代表副作用回滚。

Go Runner 默认普通并发 32，TS 默认活动普通请求 64；控制请求越过普通并发上限。完整 JSON 消息默认上限 1 MiB，输入、事件及终态均检查编码后大小。

| 错误 | 意义 |
| --- | --- |
| INVALID_REQUEST / INVALID_PARAMS / UNSUPPORTED_VERSION | 信封、参数或版本无效 |
| UNKNOWN_METHOD / NOT_FOUND | 方法或所选环境不可用 |
| DUPLICATE_REQUEST / BUSY / RESOURCE_EXHAUSTED | 活动 ID 或资源限制 |
| CANCELLED / DEADLINE_EXCEEDED / OUTCOME_UNKNOWN | 取消、超时或执行结果无法确认 |
| MESSAGE_TOO_LARGE / PROTOCOL_ERROR | 编码消息或协议无效 |
| CONNECTION_CLOSED / CANCELLATION_FAILED / OUTPUT_FAILED | 连接、取消确认或输出消费失败 |

操作不自动重试或切换环境。输入 EOF、输出写入失败及 owner 关闭都会触发资源清理。实际入口见 [Runner](../go/internal/runner/server.go)、[业务分发](../go/internal/runner/business.go)、[TS 客户端](../src/client.ts) 与 [验证指南](../docs/development/execution.md)。
