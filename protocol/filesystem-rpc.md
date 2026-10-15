# 远端文件 RPC 契约

状态：文件 RPC 首版已实现，采用共享 WS / Protobuf。消息源见 [v1 契约](remote/v1/README.md)，实现见 [文件 Client](../go/remote/filesystem_client.go)、[文件 Server](../go/remote/filesystem_server.go) 与 [宿主文件](../go/environment/local/filesystem.go)。平台与测试范围见 [执行指南](../docs/development/execution.md)。

Filesystem 范围已确定为基本文件操作，不要求兼容 io/fs.FS 或提供远端文件句柄。RPC 使用按路径的读写、目录列表、文件信息和创建目录；复杂操作由同一环境的 Process 转发 Bash 命令。

读取触发：设计远端文件请求、字节传输、错误、超时或取消。环境职责见 [环境管理与能力接口](../docs/architecture/environments.md)。

## 请求边界与能力查询

Go Remote Filesystem 持有已配置的远端 targetId，把领域操作转换成文件 RPC。服务端校验实际 Session、targetId、参数与限额，再调用宿主文件实现；本版不做用户认证或目标 ACL。Filesystem 与 Process 共享目标绑定和默认目录，领域对象的方法不要求调用方重复填写 targetId。

| 公共信息 | 位置 | 语义 |
| --- | --- | --- |
| target_id | 各请求的 Protobuf 字段 | 服务端已配置目标的引用，由 Remote Environment 自动填写 |
| path | 各请求的 Protobuf 字段 | 目标环境中的路径，由目标宿主解释 |
| 请求关联 ID | 通道 Envelope.request_id | SDK 生成，关联调用及日志；不是持久幂等键 |
| 调用预算 | 通道 RpcRequest.timeout_ms | 默认文件调用 10 秒，方法上限 60 秒，SDK 与服务端分别计时 |
| 协议版本 | WS 子协议与应用握手，消息包 agentkit.remote.v1 | 文件 RPC 不重复携带 apiVersion 字段，独立于 stdio 版本 |

远端服务拒绝未知目标，不把它解释为默认宿主。宿主操作自身的权限错误仍保留，不引入调用者权限判断，不因失败切换环境。

原草案的 filesystem.capabilities 收敛到共享的 Environment.GetInfo：输入 target_id，返回目标平台、默认目录、支持操作及服务端限制。GetInfo 与 Filesystem 方法均已有 Client / Server 实现；完整的连接握手与 Process 信息见 [远端执行器方案](../docs/architecture/remote-executor.md)。文件相关信息至少包含：

| 信息 | 语义 |
| --- | --- |
| 支持的文件操作 | Read / Write / ReadDir / Stat / Mkdir，SDK 按能力检查 |
| 平台与默认目录 | 目标平台及目标原生绝对路径，文件和 Bash 使用同一基准 |
| max_read_chunk_bytes | 单次 Read 的 length 上限 |
| max_write_bytes | 单次 Write 的原始 data 上限 |
| max_directory_entries | 单次 ReadDir 的条目上限 |
| ChannelLimits.max_message_bytes | Hello 公布的完整编码消息上限 |
| max_directory_response_bytes | ReadDir 编码 body 上限 |
| max_concurrent_session_requests / max_concurrent_global_requests | 文件 Session / 服务全局并发限制 |

GetInfo 字段见 [system.proto](remote/v1/system.proto)，FilesystemLimits 见文件消息源，数值见 v1 首版默认表。能力查询不是客户端豁免限制的依据，服务端每次调用仍校验参数和资源上限。

复制、移动、删除、搜索、批量修改和压缩等不增加文件 RPC 方法。Bash 转发使用 [Process RPC 方案](process-rpc.md)，与文件 RPC 保持同一目标绑定。

## Protobuf 消息与方法映射

五项操作共用一条 WS，在通道信封中产生一次成功或错误响应。方法注册表负责确定 body 的 Protobuf 类型，不生成 gRPC 服务：

| RpcRequest.method | 请求 body | 成功响应 body |
| --- | --- | --- |
| filesystem.read | ReadRequest | ReadResponse |
| filesystem.write | WriteRequest | WriteResponse |
| filesystem.readDir | ReadDirRequest | ReadDirResponse |
| filesystem.stat | StatRequest | StatResponse |
| filesystem.mkdir | MkdirRequest | MkdirResponse |

文件业务消息已有 `.proto` 首版，依赖标准的 google.protobuf.Timestamp。Go 领域模型不依赖生成的 RPC 类型，生成位置为 go/internal/remoteproto/v1。公共 Envelope、RpcResponse 和 RpcError 的字段以 [通道方案](remote-channel.md#消息信封) 为准。

文件消息的字段唯一来源为 [filesystem.proto](remote/v1/filesystem.proto)。公共信封见 [channel.proto](remote/v1/channel.proto)，完整注册表和初始默认值见 [v1 首版契约](remote/v1/README.md)。

服务端校验必需信息：target_id、path 不得为空，Read.length 必须大于零，Write.data 必须显式提供。Protobuf 的默认值不等于已经通过业务校验。optional bytes 保留“未提供内容”和“明确提供空字节”的区别；string 要求合法 UTF-8，bytes 承载任意文件内容。[Protobuf 字段与类型](https://protobuf.dev/programming-guides/proto3/)

成功的 DirectoryEntry / FileInfo 不使用 FILE_TYPE_UNSPECIFIED；已识别但不属于前三种类型的宿主条目使用 FILE_TYPE_OTHER。正式发布后不改用已有字段号表达不同含义，删除字段保留其编号和名称，新增必需语义需检查版本兼容性。

## 路径与链接

path 是目标环境中的原生路径。相对路径按照目标默认工作目录解释；绝对路径属于目标操作系统。客户端不先按自身宿主的 filepath 规则规范化远端路径，不将路径拼接进 Bash。

- 查询默认目录使用 `.`；空路径和包含 NUL 的路径返回 INVALID_ARGUMENT。
- `~`、环境变量与通配符作为字面字符，不做 Shell 展开；不修剪合法文件名中的空白。
- 默认目录用于定位，不构成 chroot 或访问隔离。本版不做目标 ACL，真实文件访问沿用执行器宿主的操作系统权限。
- 第一版使用合法 UTF-8 路径。遇到无法编码的条目名称时返回 PATH_ENCODING_UNSUPPORTED，不替换字符、不跳过条目，也不返回损坏名称。完整原生名称的无损表示需要独立的路径编码契约。
- Read / Write 采用宿主打开路径时的链接语义；Stat.follow_symlinks 只控制该次 Stat，不改变其他操作。ReadDir 不跟随条目链接，目录路径本身按宿主规则解析。

例如 Windows SDK 访问 Linux 目标时，`/workspace/main.ts` 仍由 Linux 解释；访问 Windows 目标时，盘符与路径分隔符由 Windows 解释。

## Read：有界的字节范围

offset 是非负、零起始字节偏移，使用 int64 与 Go 文件偏移范围对齐。length 是正整数，不超过 max_read_chunk_bytes；offset 与 length 的范围计算也要防止溢出。

| 条件 | 行为 |
| --- | --- |
| offset < 0 或 length = 0 | INVALID_ARGUMENT |
| length 超过块上限 | RESOURCE_EXHAUSTED，开始读取前拒绝 |
| offset 位于文件末尾或之后 | 空 data，eof=true |
| 读取遇到 EOF | 返回已读 data，eof=true；EOF 不是错误 |
| 正好读满 length | 可返回 eof=false，由下一次读取确认末尾 |
| 其他读取错误 | 返回错误，不将部分数据作为成功响应 |

成功返回的 data 长度不超过 length；不得返回空 data 且 eof=false，以免 SDK 无法推进偏移。文本字符、行号与字节偏移不同，文本解码由上层负责。

SDK 的 ReadFile 根据公开接口中的范围或整文件需求组织调用：从所需 offset 开始，按实际返回长度推进，直到达到所需长度或遇到 EOF。通信块上限与 SDK 返回数据上限分别配置；整文件读取超过总上限时明确失败，不静默返回前半段。

每次调用独立完成，多个 Read 请求之间允许目标文件被修改，本方案不承诺快照，也不以预先 Stat 的 size 代替实际读取上限判断。

下面用 ProtoJSON 展示一个读取示例，实际 RPC 使用 Protobuf 二进制。目标的 notes.txt 内容为六字节 `hello\n`：

```json
{"targetId":"linux-dev","path":"notes.txt","offset":"0","length":4096}
```

```json
{"data":"aGVsbG8K","eof":true}
```

## Write：单请求创建或覆盖

Write 是有界的创建或覆盖操作。服务端取得完整消息，校验 Session、目标、路径、data 是否提供及大小，并在打开或截断文件前检查取消状态。

| 输入或状态 | 行为 |
| --- | --- |
| 未提供 data | INVALID_ARGUMENT，尚未开始修改 |
| 显式提供空 data | 创建空文件，或清空已有文件 |
| 超过 max_write_bytes 或完整消息上限 | 修改前拒绝，不截断已有文件 |
| 文件不存在 | 按目标宿主配置的创建权限创建 |
| 文件已存在 | 普通覆盖，不改变本方案为原子替换 |
| 父目录不存在 | NOT_FOUND，不自动创建父目录 |
| 全部写入且关闭成功 | 返回 bytes_written，等于输入 data 的字节数 |
| 操作失败 | 返回错误；可能已创建、截断或部分写入 |

显式写入空内容的 ProtoJSON 表达如下，省略 data 的请求与它不同：

```json
{"targetId":"linux-dev","path":"empty.txt","data":""}
```

Go 的普通 WriteFile 先以创建/截断方式打开文件，再写入并关闭；源码说明中途失败可能留下部分内容。因此错误不表示原文件保持不变，也不表示回滚。成功不自动承诺 fsync 持久化。[Go WriteFile 源码](https://go.dev/src/os/file.go)

第一版不提供多请求上传事务、追加、随机写入或原子替换。SDK 不得为绕过上限把内容拆成多个 Write，因为每个请求都是完整覆盖；超限直接失败。也不承诺同一路径的并发写入顺序，需要顺序的调用方自行串行组织。

## ReadDir、Stat 与 Mkdir

| 方法 | 除 target_id、path 外的输入 | 结果与规则 |
| --- | --- | --- |
| ReadDir | 无 | 返回直接子项的 name / type，不递归；按名称 UTF-8 字节顺序排序 |
| Stat | follow_symlinks，默认 false | 返回 FileInfo；false 查看链接本身，true 查看目标 |
| Mkdir | recursive，默认 false | 返回空成功 body；失败使用通道 error 分支 |

ReadDir 结果超过条目或编码消息上限时返回 RESOURCE_EXHAUSTED；条目枚举失败或名称无法编码时整个调用失败，不把部分列表伪装为完整目录。第一版不提供分页游标或目录快照。

FileInfo.size 使用 int64，单位为字节；普通文件表示内容长度，目录、链接及其他类型的大小沿用宿主元数据，不赋予额外的跨平台一致含义。modified_at 使用 google.protobuf.Timestamp 表达时间点，保留宿主可提供的精度。Stat 成功必须提供 info 与合法类型、时间；不把 POSIX mode、Windows ACL 或底层句柄加入本轮公共元数据。

Mkdir.recursive=false 时父目录必须存在，目标目录已存在返回 ALREADY_EXISTS。递归模式允许目录已存在；路径上普通文件阻挡创建时返回 TYPE_MISMATCH。递归创建失败也可能已经创建部分目录，错误详情必须按副作用规则报告。

## RPC 错误与文件详情

每个调用产生唯一的 Envelope.response，RpcResponse.body 与 error 互斥。成功 body 编码对应文件响应，error.code 为稳定错误码，error.details 编码 FileErrorDetail；Go SDK 在边界转换为领域错误。MkdirResponse 即使没有字段，也显式选择成功 body 分支，不能与未设置响应结果混淆。

下表是本项目应用协议的错误类别与 reason，不依赖 gRPC 状态、HTTP 状态或 WebSocket 关闭码。客户端根据 code 与 reason 判断，不解析 message 文案。

| RpcError.code | FileErrorDetail.reason | 含义 |
| --- | --- | --- |
| INVALID_ARGUMENT | INVALID_ARGUMENT | 路径、范围或必需参数无效 |
| PERMISSION_DENIED | ACCESS_DENIED | 宿主操作被操作系统拒绝，不是用户或目标 ACL 校验 |
| NOT_FOUND | UNKNOWN_TARGET / PATH_NOT_FOUND | 目标未配置，或路径不存在 |
| ALREADY_EXISTS | ALREADY_EXISTS | 非递归创建遇到已有目录 |
| FAILED_PRECONDITION | TYPE_MISMATCH / PATH_ENCODING_UNSUPPORTED | 类型不符合操作要求，或目标名称无法无损编码 |
| RESOURCE_EXHAUSTED | LIMIT_EXCEEDED | 请求、结果或并发超限 |
| CANCELLED | CANCELLED | 请求取消 |
| DEADLINE_EXCEEDED | DEADLINE_EXCEEDED | 调用超时 |
| UNKNOWN | IO_ERROR | 未归类的目标宿主 I/O 错误 |
| INTERNAL | INTERNAL_ERROR | 执行器内部状态或协议实现错误 |
| UNAVAILABLE | 通常无文件详情 | 通道无法连接或服务不可用，可能是本地传输错误，不构成未执行证明 |

Write 与 Mkdir 的错误详情还要表达 mutation_state：

| 值 | 语义 |
| --- | --- |
| MUTATION_STATE_NOT_STARTED | 明确尚未进入可能修改目标的操作；参数、大小或取消校验失败可使用 |
| MUTATION_STATE_MAY_HAVE_CHANGED | 已进入可能改变目标的宿主操作，可能已部分或全部修改；不承诺回滚 |
| MUTATION_STATE_UNSPECIFIED | 缺失信息或无法判断；有副作用调用不得将其解释为 NOT_STARTED |

Read / ReadDir / Stat 不承诺或报告写入副作用，mutation_state 可省略。客户端在收到缺失详情的写入错误、超时或断线时，除非本地能证明尚未发送请求，否则按无法确认修改结果处理。SDK 可将这一情况归一为领域错误 OUTCOME_UNKNOWN，同时保留原始传输原因；它是客户端无法确认结果的语义，不伪造服务端响应，也不抹去服务端明确报告的 I/O 错误。

## 生命周期、取消与重试

```text
收到完整请求 → 校验 Session、目标、参数与限制 → 检查取消 → 执行宿主操作 → 返回结果或错误
```

- 文件 RPC 的上下文取消通过同一 WS 上的 request.cancel 控制请求传达，引用原 request_id；公共 Filesystem 不增加 Cancel 或 GetState。控制确认不是原调用终态，不能证明文件没有变化；方法载荷以通道方案为准，与 stdio 的同名消息分别定义。
- 已取消或已超时的请求在修改开始前失败，不产生写入副作用；执行中在能够停止的边界检查取消。
- 普通宿主系统调用可能无法立即中断。停止客户端等待不等于确认宿主操作停止，更不等于撤销写入。
- 服务端已知操作成功时保留成功事实，不因随后取消改写为“未执行”。但本地等待超时或 WS 断线仍可能使客户端收不到成功响应，此时客户端结果可能未知。
- 取消单个调用不关闭共享连接。资源所有者和环境关闭规则见 [环境方案](../docs/architecture/environments.md)。
- Write / Mkdir 不配置应用级自动重试或并行重发；请求追踪 ID 相同不触发去重或重放。
- 读取失败后调用方可以显式重新读取，但重读不提供同一文件快照保证。
- 第一版不提供持久文件操作记录、断线结果查询或跨重启幂等保证；检测断线即报错，不重连等待或补发文件请求。

## 两条链路的编码与限制

远端 Go ↔ Go 使用 WS Binary Message 承载 Protobuf Envelope，body 再编码对应文件消息：文件内容为 bytes，偏移及大小保留 64 位整数，时间使用 Timestamp。Runner 向 TS 转换独立的跨语言 DTO，不要求 Go 领域类型直接使用 RPC 消息。

JSON 边界明确使用 base64 表达 bytes；64 位整数采用十进制字符串，避免 TypeScript number 超过安全整数范围后丢失精度；时间采用规范化的 RFC 3339 表达。这些编码已落实在 stdio 文件 DTO 和两端转换中。[ProtoJSON 编码规则](https://protobuf.dev/programming-guides/json/)

TS ↔ Go 现有 stdio 的 1 MiB 消息上限不会自动成为远端文件块上限。远端独立公布并执行读取块、写入数据、目录条目、编码消息与并发上限；SDK 整文件返回还有单独的内存预算。

Runner 在两个边界都做编码后大小检查。1 MiB 原始字节经 base64 加上 DTO 字段后会超过 1 MiB stdio 消息上限，不能直接以远端原始数据上限作为 Agent 工具上限。Agent 路径采用两个边界允许的有效额度；读取块可以适配，但最终整文件响应同样须受 stdio 限制，不能仅因分段 RPC 成功就返回超限消息。原始内容默认值见 v1 契约：读取块 64 KiB、覆盖写入 1 MiB、SDK 整文件返回 8 MiB、Agent 文件读写 512 KiB；编码余量由跨语言边界和文件额度校验保证。各分段共享一次逻辑 ReadFile 的总调用预算，不逐块重新获得 10 秒。

## 完整解决方案与兼容范围

第一版采用上面的按路径、有界、普通宿主操作契约。更强保证需要独立设计和能力协商，不能只增加 requestId 或改成流式传输就宣称已经解决：

| 问题 | 当前兼容方案 | 根本解决所需能力 |
| --- | --- | --- |
| 分段读取遇到并发修改 | 明确不保证快照 | 快照读取，或可靠的版本校验与冲突处理 |
| 覆盖写入中途失败 | 报告可能部分修改 | 暂存内容，再用各平台验证过的原子替换机制提交；持久化保证另行定义 |
| 修改成功但响应丢失 | SDK 报告结果未知，不自动重试 | 保存操作记录、结果查询与去重，并明确记录保留及重启语义 |
| 大文件写入超限 | 开始修改前拒绝 | 独立上传会话、完整性验证与提交协议 |
| 文件名不是合法 UTF-8 | 明确拒绝，不损坏或跳过名称 | 无损路径编码及 Agent 可使用的表示契约 |

原子替换需核对 Windows 与 POSIX 的不同实现，也需明确链接、权限和文件身份变化；不能直接把 os.Rename 在所有平台上都视为原子提交。这些能力不加入本轮五项基本操作。

现有兼容入口保留 TS ↔ 本机 Go stdio；远端最底层统一为 WS。将来若需要 WS 文本编码，必须独立协商编码并保留同一业务语义，不在当前二进制子协议中混用 JSON；通道规则以远端通道方案为准。

## 落地与验证入口

文件消息生成、GetInfo、公开类型、WS 分发及 stdio 文件 DTO 已实现。本版不做身份权限，Server 已提供基本 CLI 参数，完整部署配置与 TLS 终止尚未提供。当前远端文件业务与 stdio 桥接见 [stdio 协议](README.md) 和执行指南；示例表达实际消息格式。

| 验证范围 | 应验证的结果 |
| --- | --- |
| 协议生成与字段校验 | 生成代码能区分缺失 data 与空 data，必需字段与默认值校验一致 |
| 二进制与读取边界 | 二进制往返、跨块读取、空文件、偏移位于或超过 EOF、精确块边界、溢出与总上限 |
| 路径与元数据 | Windows / macOS / Linux 路径、相对默认目录、字面字符、链接、UTF-8 排序及无损编码失败 |
| 写入与创建 | 空内容、已有文件覆盖、父目录不存在、超限不截断、关闭错误、mkdir 模式与部分创建 |
| 生命周期与错误 | 未知目标、权限、修改前取消、修改期间取消、写入响应丢失、缺失错误详情及结果未知 |
| 资源与两个边界 | 并发请求隔离、句柄释放、目录结果超限、base64 与 64 位值、完整 stdio 消息额度 |

只修改方案时核对 Markdown 链接、消息引用、方法数量及文档状态；业务行为已有正式测试；Windows / Linux 实机验证仍待完成，文档检查不替代运行验证。
