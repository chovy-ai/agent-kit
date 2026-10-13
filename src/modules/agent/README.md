# Pi 会话与工具装配

[index.ts](index.ts) 提供 AgentService、AgentSessionFactory 与会话配置。[tools.ts](tools.ts) 是工具适配器的装配入口；各工具执行时调用能力服务。

[live.ts](live.ts) 拥有本应用创建的 Pi 会话，负责创建、取消、释放及迟到会话的清理。工具白名单由应用装配；模型、ResourceLoader 和设置通过会话选项接入。当前没有自动上下文检索服务。

统一启动与默认 Pi 创建函数的取消限制见 [TS 模块说明](../../../docs/architecture/typescript-modules.md)。验证见 [模块测试](../../../test/modules.test.ts) 与 [真实 Pi 测试](../../../test/pi.test.ts)。
