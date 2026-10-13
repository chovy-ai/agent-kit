# 文件能力

[index.ts](index.ts) 提供 FilesystemService 和五项文件操作类型。读写内容是 Uint8Array；范围与大小使用字节语义，路径交给所选 Go 环境解释。

[live.ts](live.ts) 借用 Bridge、转换 base64 并验证响应；写入无法确认时保留可能已修改的状态。[tools.ts](tools.ts) 负责 Pi Schema、文本或 base64 展示及续读位置。文件操作不在 TS 宿主执行。

服务替换与展示预算见 [TS 模块说明](../../../docs/architecture/typescript-modules.md)，验证见 [模块测试](../../../test/modules.test.ts)。
