# 构建并验收安装包

状态：打包脚本、可执行 CLI、Go 二进制清单与包内定位已实现。本轮生成本地 tarball，不向 npm 或 GitHub 发布。Pi 的同组运行依赖在 package.json 中固定为已验收的 1.1.0，避免独立安装时混用不兼容的 1.2.0。开发使用 package-lock.json；安装包不依赖消费方遵守开发锁文件。包仍标记 private；Go SDK 的 module 名仍为 `agent-kit`，源码在仓库 go module 内使用，尚未作为独立 Go module 发布。

## 生成产物

构建机器需要 Node.js、npm 和 Go，依赖先通过 `npm ci --ignore-scripts` 安装。运行已经生成的安装包不需要 Go 编译器或 protoc。

```sh
npm run pack:local
npm run pack:release
```

两种模式都生成 `.build/packages/agent-kit-0.1.0.tgz`，同版本后一次会覆盖前一次。local 包只含构建宿主的二进制；release 包包含 [打包配置](../../packaging/targets.json) 中所有目标。普通 `npm pack` 也会通过 prepack 构建宿主包。

当前目标是 macOS、Linux、Windows 的 arm64 与 x64；`win32` 是 Node 平台名称，构建时映射到 Go 的 windows。`targets.json` 可以缩小目标矩阵或去掉 remote-server，但必须保留 runtime-runner。Windows 平台行为仍需实机验收，交叉编译成功不代表运行通过。

```text
package/
  dist/                              TypeScript JS、声明与 CLI
  binaries/manifest.json             包版本、协议版本、目标与 SHA-256
  binaries/darwin-arm64/runtime-runner
  binaries/darwin-arm64/remote-server
  binaries/win32-x64/runtime-runner.exe
  examples/agent-kit.config.json
```

实际目录由目标矩阵决定。打包采用 CGO_ENABLED=0、trimpath 与去除调试符号的 Go 构建。清单记录校验值供分发方核验；当前运行时校验清单版本、协议、平台和文件存在性，不自动验证二进制哈希或下载程序。

## 安装并启动

```sh
npm install /absolute/path/agent-kit-0.1.0.tgz
npx agent-kit
npx agent-kit --config ./agent-kit.config.json
```

启动器先使用显式 runnerPath 或 AGENT_KIT_RUNNER，再查源码开发的 `.build`，最后使用包内对应平台程序。包内清单版本必须与 package.json 一致，协议须为 v1；缺失的平台或文件明确失败。覆盖路径仍通过实际 Hello 校验协议，不承诺外部二进制与 npm 包的产品版本相同。

安装目标需要 Node.js；执行命令的环境需要 Bash。文件能力不依赖 Bash，Windows 可以只使用文件能力，也可以显式配置 Git Bash 等原生 Bash 路径。

## 本地验收

```sh
npm run check
npm run pack:local
npm run verify:package
```

包验收把 tarball 安装到临时项目，验证公开导出、可执行 CLI、两个具名 local 的文件和命令互通、取消后复用及 Runner 关闭。POSIX 宿主把 PATH 缩小到 Node 可执行文件目录及系统目录，让测试不依赖 Go 编译器；不调用在线模型。真实模型验收与离线 Pi 工具循环的证据分开记录。

依赖安装仍需要 npm registry 或本机缓存；tarball 不内置 Node.js 和 npm 依赖。检查脚本使用 sh，完整统一检查当前在 macOS 运行；打包脚本使用 Node，可在支持的构建宿主调用。
