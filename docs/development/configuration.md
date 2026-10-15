# 按名称配置本地环境

状态：已实现。配置入口当前只支持 `local` 类型，可以声明多个名称；现有 Remote SDK 与旧 CLI 参数保留兼容，不通过新配置声明远端。

## 使用配置文件

创建配置，目录必须事先存在：

```json
{
  "version": 1,
  "environments": {
    "workspace": { "type": "local", "cwd": "./project" },
    "scratch": { "type": "local", "cwd": "./scratch", "bash": "/bin/bash" }
  }
}
```

源码开发与安装包分别启动：

```sh
npm start -- --config ./agent-kit.config.json
agent-kit --config ./agent-kit.config.json --prompt "列出环境，在 workspace 中查看当前目录"
```

不传 prompt 时只启动、握手、检查并退出，不调用模型。可直接运行 [仓库示例](../../examples/agent-kit.config.json)，其中两个目录已经存在。

配置文件的相对 cwd 以配置文件所在目录解析；省略 cwd 使用该目录。绝对路径保留宿主语义。bash 的裸命令名通过 PATH 查找；包含分隔符的相对路径也以配置文件目录解析。Windows 执行侧需要显式提供可用 Bash，文件操作不依赖 Bash。

## 从 TypeScript 配置

```ts
import { createAgentKit, createPiAgent } from "agent-kit";

const app = await createAgentKit({
  environments: {
    workspace: { type: "local", cwd: "." },
    examples: { type: "local", cwd: "./examples" },
  },
});
await app.close();

const agent = await createPiAgent({ runner: { configPath: "./examples/agent-kit.config.json" } });
try {
  await agent.session.prompt("在 workspace 环境中列出当前目录");
} finally {
  await agent.close();
}
```

内联配置的相对路径以启动进程的工作目录解析。`configPath` 与 `environments` 互斥，不能与 args 中的 cwd、bash、remote 或另一份环境配置混用。启动失败会关闭已构造环境，不返回半就绪应用。

## 名称与兼容规则

- 名称就是工具参数 `environmentId`，大小写敏感。首字符是英文字母或数字，后续可用字母、数字、点、下划线、连字符，总长最多 64 字符。
- 一份配置包含 1–64 个环境，JSON 上限 64 KiB。未知字段、重复环境名、未知类型、无效目录和不支持的版本明确失败。
- 显式配置只注册声明的名称，不自动添加 `local`，不回退其他名称。查询结果按名称排序，目前只返回 ID。
- 不提供配置时继续注册默认 `local`，保留旧 `--cwd`、`--bash`、`--remote-endpoint` / `--remote-target` 行为。新配置尚不接受 `remote` 类型。
- 不同 local 名称使用各自的默认目录、执行内核和生命周期，但共享宿主文件系统及宿主权限；默认目录不是沙箱边界。

## 实现与验收

[公开定义](../../go/environment/config.go) 不依赖 local 实现；[配置解析](../../go/internal/runner/config.go) 负责文件格式与路径基准；[Wire provider](../../go/internal/di/providers.go) 构造并清理每个实例，Runner 仍只依赖 Directory。

[配置测试](../../test/configuration.test.ts) 验证同名文件在不同默认目录下独立、Process 与 Filesystem 命中同一目标、配置文件路径基准、无效配置和未知名称拒绝；[解析测试](../../go/internal/runner/config_test.go) 验证类型、重复名、字节限制及路径转换。统一运行 `npm run check`。
