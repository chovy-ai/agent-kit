# Remote 协议 v1 首版

状态：四份消息已生成 Go 代码并接入 WS Client / Server，尚未发布稳定版本。字段唯一来源仍为四份 `.proto`；[生成代码](../../../go/internal/remoteproto/v1/)、[运行入口与验证](../../../docs/development/execution.md) 已提供。Server 当前支持基本 CLI 参数，完整配置文件与 TLS 部署形式留待后续确定。

## 本版确认的行为

- Client 侧 Go SDK 初始化时主动建立 WS，完成 Hello 和初始目标 GetInfo；任一步失败则初始化返回错误并清理已获取资源，不返回半就绪对象，不延迟到首次文件或命令调用才拨号。
- 一条连接复用文件、命令输出和控制消息，子协议为 `agentkit.remote.v1.pb`，业务版本为 1。ws / wss 按 endpoint 使用，TLS 处理不引入调用者身份认证。
- 第一版不做用户身份认证、账号或角色权限、Token 和目标 ACL。未知 targetId 仍报错，宿主文件和进程操作自身的权限错误仍保留。
- 检测到断线后立即让活动等待失败，不自动重连、不等待恢复、不补发请求。失效 Client 的新调用立即报 CONNECTION_CLOSED；调用方可以显式重新初始化 Client 发起新的业务，原调用结果不恢复。
- 已发送但没有权威终态的 Exec 返回 unconfirmed / OUTCOME_UNKNOWN，写入或目录创建报告结果未知，并保留 CONNECTION_CLOSED 原因。尚未发送的操作可以确认 not_started；已完成的结果不因稍后断线改写。
- Server 按断开 Session 清理活动上下文和命令范围，继续承担未确认执行的回收责任；SDK 直接报错不等待断线后的查询。SDK 返回后不再调用原输出回调。

第一版 Session 是实际连接的资源归属，不是身份或认证令牌。执行登记按 serviceInstance、Session、targetId、executionId 区分；Cancel / GetState 查询当前 Session 的记录，客户端不能通过填写另一个 sessionId 切换所属连接。新 Client 对应新 Session，不接管旧执行。执行器近期记录独立于 socket 保留，用于在仍连通的原 Session 确认、限制重复启动及服务自身清理。

## 字段与方法唯一来源

| 文件 | 内容 |
| --- | --- |
| [channel.proto](channel.proto) | Envelope、请求 / 响应 / 事件、通用错误、请求取消、通道限制与预算 |
| [system.proto](system.proto) | Hello、GetInfo、平台、目标能力及有限启动接纳租约 |
| [filesystem.proto](filesystem.proto) | 五项文件消息、条目与元数据、错误副作用、文件限制 |
| [process.proto](process.proto) | Exec、started / output、terminal、Cancel / GetState、状态枚举与执行限制 |

所有 body 都是下表对应消息的 Protobuf 编码，方法名大小写严格匹配。不定义 gRPC service，不把领域对象、函数、context 或 Go error 直接传输。当前不固定 Go 包生成位置，后续生成时明确映射。

| method | request.body | response.body | event.name / body |
| --- | --- | --- | --- |
| system.hello | HelloRequest | HelloResponse | 无 |
| environment.getInfo | GetInfoRequest | GetInfoResponse | 无 |
| request.cancel | CancelRequest | CancelRequestResponse | 无 |
| filesystem.read | ReadRequest | ReadResponse | 无 |
| filesystem.write | WriteRequest | WriteResponse | 无 |
| filesystem.readDir | ReadDirRequest | ReadDirResponse | 无 |
| filesystem.stat | StatRequest | StatResponse | 无 |
| filesystem.mkdir | MkdirRequest | MkdirResponse | 无 |
| process.exec | ExecRequest | ExecTerminal | process.started / ProcessStarted；process.output / ProcessOutput |
| process.cancel | ProcessCancelRequest | ProcessCancelResponse | 无 |
| process.getState | ProcessGetStateRequest | ProcessGetStateResponse | 无 |

error.details 按原请求方法确定：五项文件方法使用 FileErrorDetail；三个 process 方法及 ExecTerminal.execution_error 使用 ProcessErrorDetail；Hello / GetInfo / request.cancel 使用 RequestErrorDetail。能关联到请求时错误详情应提供；连接级错误可能没有响应。

## 消息校验与终态

Envelope.request_id 使用 SDK 生成的 UUID 且不复用；request / response / event 必须选中一种。RpcResponse 必须选中 body 或 error，空 MkdirResponse 也显式选 body。RpcRequest.timeout_ms 必须是正数且不超过对应方法额度；Hello 之前仅允许 system.hello，HelloRequest.protocol_version 必须为 1，后续请求的 service_instance 必须匹配已协商实例。

同一 Session 收到重复的活动 request_id 属于协议错误，关闭连接并取消该 Session 的活动处理，不能向同一等待项发送两个有歧义的响应。服务端不承诺永久保存所有历史 RPC ID，SDK 不复用 ID；executionId 的保留与重复启动规则另行执行。

HelloResponse 必须提供版本、服务实例、Session ID、支持的方法、通道限制与预算。GetInfoResponse 必须匹配请求 target_id，提供合法平台、目标原生绝对 default_cwd、能力和对应限制；Bash 可用时还提供启动租约。Bash 不可用不影响基础文件能力，Exec 在启动前明确失败。操作前继续校验目标存在，不默认回退其他目标。

已启用能力的预算和限制必须为正且相互可满足，例如输出 / 读取片段编码后不能超过整消息额度。SDK 在初始化时检查这些关系，发现不一致返回 PROTOCOL_ERROR 并释放连接；接收 Server 策略不重新增加已经消耗的初始化预算。

ExecRequest.command 非空，cwd 为空表示默认目录，env 只覆盖本次执行。body.timeout_ms=0 使用 60 秒运行预算，max_output_bytes=0 使用 1 MiB；超过公布上限时启动前拒绝。目标运行预算、信封 RPC 等待和启动接纳期分别校验。

普通调用 sequence=0。Exec 的 started / output 及 terminal 使用从 1 开始的连续序号，序号在消息实际被写调度器接纳时分配；主动停止转发后的字节不占序号。started 在确实启动并纳入管理后产生；ProcessOutput 必须有合法 stdout / stderr 和非空、有界 data。只有 terminal 响应结束该次请求等待，发送一次，不同时发送 terminal 事件与第二条 response。

ExecTerminal 必须匹配 execution_id 并提供合法 completion。未启动时没有 exit_code、没有 started，使用 NOT_STARTED 并提供执行错误；已知退出码使用 optional int64，显式 0 与未提供不同。FINISHED 表示管理范围已结束，允许非零退出码或取消 / 超时等执行错误；非零退出本身不填 execution_error。UNCONFIRMED 不宣称已经停止，必须携带 OUTCOME_UNKNOWN。terminal 不携带完整 stdout / stderr。

ProcessGetStateResponse 的 NOT_STARTED / FINISHED 必须提供对应 terminal；活动状态和 MISSING 不提供 terminal。MISSING 不证明从未执行。GetState 不重放输出，得到后来确认的结果也不改写已返回的 ExecResult。

ProcessCancelResponse 的 ACCEPTED 表示停止请求已提交或启动前取消标记已保存；ALREADY_TERMINAL 保留权威终态；MISSING 表示当前 Session 无可确认的记录且未保存启动前标记。三者都不自动等同于“刚刚成功杀死进程”。控制确认后仍看 terminal / GetState；容量不足返回错误，不伪造 ACCEPTED。

启动前 Cancel 使用原 admission_lease。没有执行记录但租约仍有效时可原子保存取消标记，阻止迟到 Exec；存在执行记录时即使租约已过期仍允许取消和查询。实例或 Session 不匹配不能重启执行；SDK 不为同一次 executionId 换租约或重发请求。

## 接纳租约与记录

租约仅用于限定启动接纳窗口，第一版使用服务端内存表和随机 16 字节引用，绑定实际 Session、实例和 targetId，不做签名凭证、用户认证或跨连接恢复。Server 使用自己的时钟和单调计时检查过期；SDK 以 GetInfo 发起时的本机单调时间加 remaining_ttl_ms 保守估算有效期，不依赖两端墙上时钟同步。

默认租约 30 秒，SDK 在新 Exec 前发现剩余不足 5 秒时于仍连通的连接刷新 GetInfo。同一 Session / target 的现有租约剩余充足时复用；刷新保留旧租约直到其有效期结束，已分配给 executionId 的期限不延长。普通 RPC timeout 不能代替此校验。

服务端在登记和实际启动前均检查租约。取消标记、重复启动简要记录至少保留至原租约到期；确认未启动或已结束的终态默认保留 120 秒，需要拒绝重复启动时取两类期限中的较晚者。未确认、仍待回收的执行一直计入活动容量，不能按终态 TTL 删除。容量不足在启动或保存取消标记前拒绝，不能提前驱逐承诺保留的记录。

## 超时默认值

这些是本版初始运行策略，不是 Server 配置文件设计。1 秒=1000 毫秒；调用方更早的 ctx 截止时间优先。网络和业务阶段共享初始化总预算，阶段上限不能累加扩大总预算。

初始化等待上下文与连接存活上下文分开。初始化失败直接中止临时连接并回收资源，不再启动额外的关闭握手等待；初始化成功后的读循环和写调度器使用 Client 所有者的连接上下文，10 秒初始化预算不是连接存活期限。

| 项目 / 字段 | 默认值 | 范围与规则 |
| --- | --- | --- |
| SDK 初始化 / sdk_init_ms | 10 秒 | 包含拨号、Hello 和初始目标 GetInfo；失败释放已创建资源 |
| WS 拨号 / ws_connect_ms | 5 秒 | 包含 TCP / TLS / Upgrade，受初始化剩余预算约束，尝试一次 |
| Hello / hello_ms | 3 秒 | 首次业务握手，受初始化总预算约束 |
| GetInfo / get_info_ms | 3 秒 | 初始化和仍连通时的租约刷新 |
| 文件 RPC / file_rpc_ms | 10 秒 | Read / Write / ReadDir / Stat / Mkdir |
| 文件 RPC 上限 / max_file_rpc_ms | 60 秒 | 超过方法预算上限返回 INVALID_ARGUMENT |
| 控制 RPC / control_rpc_ms | 2 秒 | request.cancel、process.cancel、process.getState |
| 控制 RPC 上限 / max_control_rpc_ms | 10 秒 | 正常控制和 GetInfo 受此上限约束；初始化仍受总预算限制 |
| 命令运行 / default_timeout_ms | 60 秒 | 输入 0 使用默认，SDK 发送前扣除本机已消耗的预算 |
| 命令运行上限 / max_timeout_ms | 1 小时 | 大于上限在启动前拒绝 |
| 命令清理确认 / cleanup_grace_ms | 2 秒 | 独立上下文；仍未确认则返回 unconfirmed，Server 继续清理 |
| Exec 终态传输余量 / exec_delivery_grace_ms | 3 秒 | 信封 RPC 等待默认为剩余运行预算 + 2 秒清理 + 3 秒传输；初始默认 65 秒 |
| WS 心跳间隔 / heartbeat_interval_ms | 15 秒 | 无业务数据时也保持检测 |
| Pong 等待 / pong_wait_ms | 5 秒 | 到期视为连接故障，触发所有挂起调用失败 |
| 单次 WS 写入 / write_io_ms | 5 秒 | 连接级 I/O 截止，失败影响整条连接 |
| 关闭总宽限 / close_grace_ms | 5 秒 | SDK 释放及服务 draining 的初始预算；不表示必定确认目标停止 |
| 租约 / admission_lease_ttl_ms | 30 秒 | Server 限制最晚接纳启动时间 |
| 租约刷新余量 / lease_refresh_margin_ms | 5 秒 | 新执行前检查；不触发断线重连 |
| 终态保留 / terminal_retention_ms | 120 秒 | 确认结束后计时，活动清理记录不按此过期 |

Exec 的信封 timeout_ms 上限为公布的 max_timeout_ms + cleanup_grace_ms + exec_delivery_grace_ms。客户端取消时停止运行，仍连通才在独立 2 秒预算内发送 Cancel / 等待或查询；一旦断线直接失败，不用关闭预算重新拨号。GetState 确认可立即查询，后续以 100 毫秒间隔在剩余确认预算内进行，不无限轮询。

连接读循环使用连接上下文，不设置某个文件 / Exec 的业务等待时间为 socket 读取期限；静默故障由心跳与 I/O 检测。断线“直接报错”指检测到连接失效后立即失败，不等待重连；不能把心跳检测时间当作业务执行结果。

## 资源默认值

KiB=1024 字节，MiB=1024 KiB。限额按实际字节和完整编码消息检查，条目数与字节额度同时满足；SDK 在发送前检查，Server 在副作用前再次检查。

| 项目 / 字段 | 初始默认值 | 作用范围 |
| --- | --- | --- |
| max_message_bytes | 2 MiB | 每个完整 WS 消息，包含 Envelope 与 body；接收库显式设置读取限制 |
| max_pending_requests | 32 | 每个 SDK Client / Session 的普通活动请求 |
| max_control_requests | 8 | 每 Session 独立控制额度；Hello、GetInfo、Cancel、GetState 不被普通调用占满 |
| max_sessions | 32 | 单个 Server 的同时连接数 |
| max_active_requests / max_active_control_requests | 128 / 32 | Server 全局普通 / 控制调用上限 |
| max_write_queue_bytes / max_write_queue_messages | 4 MiB / 256 | 每连接普通发送队列，两端分别执行 |
| control_queue_bytes / control_queue_messages | 256 KiB / 64 | 每连接为控制与终态预留，终态不越过本次已保留输出 |
| max_read_chunk_bytes | 64 KiB | 单次文件读取原始字节 |
| max_write_bytes | 1 MiB | 单次完整覆盖写入原始内容 |
| SDK 整文件读取返回上限 | 8 MiB | SDK 本地缓冲，多个 Read 仍受整体预算，不宣称服务器文件快照 |
| max_directory_entries | 10000 | ReadDir 条目数，超限整个操作失败 |
| max_directory_response_bytes | 1 MiB | ReadDir 编码 body 上限，还检查整个 WS 消息额度 |
| max_concurrent_session_requests / max_concurrent_global_requests | 16 / 64 | 活动文件操作；同时受普通请求总额度限制 |
| max_path_bytes / max_cwd_bytes | 64 KiB | 合法 UTF-8 路径字节，不进行 Shell 展开 |
| default_capture_bytes / max_capture_bytes | 1 MiB / 8 MiB | 每个 Exec 的 stdout / stderr 合计捕获 |
| max_output_chunk_bytes | 64 KiB | 单个 output 原始字节片段 |
| max_forward_bytes | 8 MiB | 每个 Exec 的总转发上限，独立于最终捕获额度 |
| execution_output_queue_bytes / execution_output_queue_messages | 1 MiB / 128 | 每个 Exec 的输出队列，超限停止后续转发并排空宿主管道 |
| max_active_session_executions / max_active_global_executions | 4 / 16 | 活动 Exec，包含未确认但仍待回收的执行 |
| max_execution_records | 4096 | Server 的活动 / 近期终态 / 去重记录，按 executionId 计 |
| max_cancel_marker_records | 1024 | Server 的启动前取消标记，不提前清除仍有效标记 |
| max_admission_leases | 4096 | Server 有效租约记录，过期后回收 |
| max_command_bytes | 64 KiB | 单次 Bash 脚本的 UTF-8 字节数 |
| max_env_entries / max_env_total_bytes | 128 / 64 KiB | Env 条目数与键值合计字节；另校验空键、等号及 NUL |
| target_id 字节上限 | 128 | 非空 UTF-8 目标标识 |
| RpcError.message 字节上限 | 4 KiB | 业务错误文案；错误详情也要满足消息额度 |
| TS ↔ Go stdio 完整消息上限 | 1 MiB | 沿用现有独立框架限制 |
| Agent 文件工具原始内容额度 | 512 KiB | 后续 Runner 文件 DTO 的初始读 / 写额度，还检查 base64 后完整 JSON |

普通请求或文件结果超限返回 RESOURCE_EXHAUSTED，且写入超限在打开 / 截断前拒绝。超过 WS 整消息限制导致库关闭连接时按通道错误处理，不承诺还能收到单请求错误响应。捕获或转发受限使用 OutputTruncated；未知缺口使用 OutputIncomplete。命令不因输出截断而自动中断。

## 错误与兼容

文件 code / reason / mutation_state 以 [文件契约](../../filesystem-rpc.md#rpc-错误与文件详情) 为准。本版不产生调用者 UNAUTHENTICATED 或目标 ACL 错误，PERMISSION_DENIED 只保留宿主操作失败。

| code | 语义 |
| --- | --- |
| INVALID_ARGUMENT / UNKNOWN_METHOD / UNSUPPORTED_VERSION | 参数、方法或握手业务版本无效 |
| NOT_FOUND | 未知目标或路径；详情 reason 区分 |
| RESOURCE_EXHAUSTED | 调用、记录、队列或结果额度不足 |
| CANCELLED / DEADLINE_EXCEEDED | 已知取消或预算耗尽，不自动表示副作用撤销 |
| INSTANCE_MISMATCH / LEASE_EXPIRED | 绑定实例变化或启动租约过期，启动前拒绝 |
| DUPLICATE_EXECUTION | 同 Session / 目标 / executionId 已登记，不重新执行 |
| BASH_UNAVAILABLE / START_FAILED / OUTPUT_FAILED | 命令能力、启动或输出消费失败 |
| OUTCOME_UNKNOWN | 未确认目标执行结束或副作用结果，保留部分结果 |
| UNKNOWN / INTERNAL | 未归类的宿主 I/O 错误或执行器内部错误，详情保留 reason |
| CONNECTION_FAILED / CONNECTION_CLOSED / PROTOCOL_ERROR | SDK 本地初始化、断线或信封校验错误；没有服务端响应时不伪造 RpcError |

schema 校验还需执行必需字段、枚举合法值、范围及状态不变量。未知 Protobuf 字段可忽略；未知必需语义、事件类型或不支持的业务版本不得默默当成功。正式发布后新增兼容字段使用新编号，删除保留编号及名称；当前首版草案尚不承诺与之前 Markdown 示例构成已发布 wire 兼容。

完整消息源与普通构造函数供后续 Client / Server 实现复用；兼容接入保留现有 stdio，并由 Runner 转换领域结果。用户身份、权限、Server 配置及持久日志 / 文件操作恢复不加入本轮。

## 验证入口

从本目录以 protoc 编译四份消息的描述符，标准 Timestamp import 由已安装编译器的 include 目录提供。检查所有 11 个方法与 2 个事件的消息引用，验证缺失 / 空 data、未设置 / 空成功 body、缺失 / 0 exit_code 和全部状态枚举的往返。

运行实现交付后，再验证初始化失败释放、失效 Client 新调用立即失败、单请求取消保留连接、断线不重连不补发、Session 清理、租约过期、容量拒绝、并发与输出边界及跨平台文件和进程行为。当前语法与编码检查不构成这些运行行为的验证。
