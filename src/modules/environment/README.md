# 环境查询

[index.ts](index.ts) 提供 EnvironmentService 与 EnvironmentRef。当前 list 返回已注册 ID，环境注册、选择和目标绑定由 Go Manager 处理。

[live.ts](live.ts) 借用 RuntimeClient 并验证环境列表；[tools.ts](tools.ts) 将服务接入 Pi。调用方通过公开入口获取服务，不读取其他模块的私有实现。

装配规则见 [TS 模块说明](../../../docs/architecture/typescript-modules.md)，验证见 [模块测试](../../../test/modules.test.ts)。
