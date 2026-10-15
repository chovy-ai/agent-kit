# Go Bridge

拥有本机 Go Runner 进程、stdio 请求关联、输出事件、取消和关闭。调用方通过 [index.ts](index.ts) 使用 RuntimeClient、配置与错误契约；[live.ts](live.ts) 只由应用启动层选择。

协议转换和返回验证帮助函数属于本模块的适配边界，不访问目标文件系统。连接按应用共享，请求取消保留健康连接。旧 TS 导出指向同一个服务标识。

启动、资源归属与兼容范围见 [TS 模块说明](../../../docs/architecture/typescript-modules.md)。验证见 [启动测试](../../../test/bootstrap.test.ts) 与 [模块测试](../../../test/modules.test.ts)。

具名 local 配置见 [配置指南](../../../docs/development/configuration.md)；Go 程序的源码构建与包内分发见 [打包指南](../../../docs/development/packaging.md)。
