# 命令执行

[index.ts](index.ts) 提供 ProcessService、ExecRequest、ExecResult 与双流输出类型。stdout / stderr 保持字节，完成状态区分 not_started、finished 与 unconfirmed。

[live.ts](live.ts) 借用 Bridge、转发输出并验证终态；[tools.ts](tools.ts) 展示有界文本，保留退出码、执行错误与两种截断标记。取消与进程范围回收由 Go 执行，服务不自动重试。

预算与资源规则见 [TS 模块说明](../../../docs/architecture/typescript-modules.md)，验证见 [模块测试](../../../test/modules.test.ts) 与 [远端测试](../../../test/execution.test.ts)。
