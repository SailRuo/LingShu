# 从源码构建安装包 / Building from source

> 本文档面向「把仓库丢给 AI 编码助手、让它在本地打包出安装包」的场景：步骤确定、命令可直接执行、每步有成功判据。
> This guide is written to be followed end-to-end by an AI coding agent.

## 会产出什么 / What gets built

| 平台 | 产物 |
|---|---|
| macOS | `灵枢.app` + `.dmg` |
| Windows | NSIS 安装器（`*-setup.exe`） |

安装包**自带 Node 运行时与后端**（后端 dist 已编译为 V8 字节码）。ASR 语音模型**不随包分发**——应用首次使用时从 GitHub Releases 自动下载，或用户在设置页手动导入 zip。安装包**不含任何 API key**，模型服务由用户在设置页自行配置。

## 前置环境 / Prerequisites

| 工具 | 版本要求 | 自检命令 |
|---|---|---|
| Node.js | ≥ 20（npm 随附） | `node -v` |
| Rust 工具链 | 稳定版（[rustup](https://rustup.rs) 安装） | `cargo --version` |
| macOS | Xcode Command Line Tools | `xcode-select -p` |
| Windows | MSVC 构建工具 + WebView2（Win10/11 一般自带） | — |

Rust 未装时：macOS/Linux 执行 `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` 后重开终端；Windows 下载 rustup-init.exe。

## 构建步骤 / Build steps

```bash
# 1. 克隆仓库
git clone https://github.com/SailRuo/LingShu.git
cd LingShu

# 2. 安装依赖（两个包各自独立安装，仓库根目录没有 package.json）
cd backend-node && npm install
cd ../lingshu-gui && npm install

# 3. 打包（唯一推荐的入口，跨平台）
npm run desktop:build
```

**成功判据**：命令结束时无 error，产物位于：

- macOS：`lingshu-gui/src-tauri/target/release/bundle/dmg/*.dmg`（同目录 `macos/灵枢.app`）
- Windows：`lingshu-gui/src-tauri/target/release/bundle/nsis/*-setup.exe`

首次构建会编译数百个 Rust crate，耗时数分钟属正常。

## 构建后验证 / Verify

1. 双击安装/启动「灵枢」——主窗口（标题「灵枢 AI」）应正常打开。
2. 后端自动拉起：`curl -sf http://127.0.0.1:8600/health` 应返回健康信息。
3. 聊天前需在设置页配置一个模型 provider（BYOK，安装包不含 key）。
4. 语音识别首次使用时联网下载 ASR 模型（或导入 zip）。

## 常见故障 / Troubleshooting

| 现象 | 原因与处理 |
|---|---|
| `rust: command not found` | 装完 rustup 后需重开终端让 PATH 生效 |
| Node 版本 < 20 | `nvm install 20 && nvm use 20` |
| macOS 提示「无法打开」（未公证构建） | 右键 → 打开；或 `xattr -cr "/Applications/灵枢.app"` |
| 启动报 `cachedDataRejected` | 字节码与运行时 Node 的 V8 版本不匹配：用同主版本 Node 重新构建；跨机器构建时设 `LINGSHU_NODE_BINARY` 指定与编译机同主版本的 Node |
| `beforeBuildCommand` 阶段失败 | 进 `lingshu-gui` 单独跑 `npm run build && npm run stage:desktop:build` 隔离定位 |

## 给 AI Agent 的注意事项 / Notes for AI agents

- 使用 **npm**（本仓库不用 pnpm/yarn）；**仓库根目录没有 package.json**，依赖分别在 `backend-node/` 与 `lingshu-gui/` 内安装。
- **唯一推荐入口**：在 `lingshu-gui/` 内执行 `npm run desktop:build`。它会注入 `LINGSHU_STAGE_BYTECODE=1`（后端 dist 转 V8 字节码）并在 macOS 自动套用 `src-tauri/tauri.macos.conf.json`。
- `desktop:build:mac` / `desktop:build:win` 直调 `tauri build`，**不含字节码**（除非显式加 `LINGSHU_STAGE_BYTECODE=1` 前缀）——优先用 `desktop:build`。
- `beforeBuildCommand` 的 staging 会**清空并重写** `src-tauri/resources/backend`——不要手工往该目录放文件。
- 不要把 ASR 模型塞进安装包：应用运行时从 GitHub Releases 拉取。
- 字节码绑定构建机 Node 的 V8 版本；staging 自动打包匹配的 `runtime/node`，跨机器构建用 `LINGSHU_NODE_BINARY` 对齐主版本。
- Linux 打包未在本流程中验证（staging 有 target，但 Tauri Linux bundle 未测试），不在支持范围。
