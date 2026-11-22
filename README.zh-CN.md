# LingShu — 灵枢

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

[English](./README.md) | 简体中文

> 一个个人私有的长期陪伴智能体——记忆持续沉淀，人格持续涌现。

## 项目定位

灵枢（LingShu）是一个**实验性研究项目**。现有大模型缺乏跨会话记忆，会话之间相互独立，难以形成长期关系；本项目以此为出发点，为智能体构建长期记忆，作为长期关系的基础，并在此之上引入人格演化机制，使人格随记忆积累而变化。实验在人的全程参与下进行，考察智能体与人之间的双向影响：

- **智能体对人的影响**：长期被记忆与理解，会对人的情绪与心理状态、事务效率、日常生活产生何种改变？其中哪些是期望的正向效应，哪些是应当警惕的风险？
- **人对智能体的影响**：人的反馈与共同经历如何沉淀为记忆并反哺人格？在此基础上，人格能否实现类人的自我演化，即由自身经历塑造、全程可观察、可追溯，而非固定不变的角色设定？

上述实验依托一个本地桌面应用开展，主要机制如下：

- **长期记忆**：对话、事件与人格状态持续沉淀，涵盖记忆分块、召回、人格块与记忆回声。
- **人格机制**：影响（affect）、自我状态（self-state）、基线（baseline）与种子（seed）、见证（witness）在长期交互中持续作用，构成人格演化的机制基础。
- **长期上下文**：对话体验以个人知识库与以月、年计的历史上下文为中心设计，而非以单次会话为优化目标。
- **生活场景**：语音对话、主动消息、定时任务与 MCP 工具、技能扩展，使智能体进入日常生活情境，上述影响即在其中被观察。

## 当前能力

- 记忆：完整召回管线（digest / AKIN / 语义召回）、proactive 动力学、baseline / self-state / affect、seed 与 witness；本地 SQLite + 向量检索。
- 语音：TTS（多 provider，情绪标签链路）+ 流式 ASR + 声纹。
- MCP：server CRUD、Claude Desktop 格式导入、stdio / SSE / streamableHttp 三种传输、工具发现与调用、审批流。
- 技能：`SKILL.md` 扫描、会话级绑定、system prompt 注入、技能元工具。
- Tauri 桌面打包；后端仅监听 `127.0.0.1`。

## 目录结构

```
LingShu/
├── backend-node/          # Node.js/TypeScript 后端（Fastify）
│   ├── src/
│   │   ├── index.ts       # 入口：健康检查 + 路由注册
│   │   ├── config.ts      # 环境变量配置
│   │   ├── routes/        # 已实现路由 + generated 兜底
│   │   ├── services/      # 记忆 / 语音 / MCP / 技能 / 调度
│   │   └── tools/         # 原生工具与 MCP 工具注册
│   └── package.json
├── lingshu-gui/           # Vue 3 + Tauri 2 桌面 GUI
├── docs/                  # 公开文档
├── LICENSE                # AGPL-3.0 协议全文
├── CLA.md                 # 贡献者许可协议
└── README.md
```

## 快速开始

灵枢是**桌面应用**——桌面窗口是唯一的产品形态，没有网页版（`dev.sh` 是开发脚本，发布形态是打包后的安装包）。

前置要求：**Node.js 20+**（脚本会自动校验）；构建桌面窗口需要 **Rust 工具链**（[rustup](https://rustup.rs) 安装）。

```bash
./dev.sh             # 后端 + Tauri 桌面窗口（默认）
./dev.sh --backend   # 只启动后端
./dev.sh --gui       # 只启动前端（连接已在跑的后端）
./dev.sh --web       # 仅开发调试：在浏览器里预览前端，代替桌面窗口
./dev.sh --help      # 全部参数
```

脚本会检查 Node 版本、自动补装依赖、等后端 `/health` 就绪再起前端，Ctrl-C 时一并回收子进程；日志写在 `.dev-logs/`。

端口默认 8600（后端）/ 1420（前端），被占用时自动顺延到下一个空闲端口并同步给前端。想钉死端口就用 `--port 8601` / `--gui-port 1421`。

单独启动后端：

```bash
cd backend-node
npm install
npm run dev          # 默认端口 8600
```

环境变量：`PORT`、`HOST`、`LOG_LEVEL`、`DB_PATH` 等，见 `backend-node/src/config.ts`。

想从源码打出安装包：跟着 **[docs/BUILDING.md](./docs/BUILDING.md)** 走即可——这份文档就是为「把仓库交给 AI 编码助手、让它打包」的场景写的，步骤确定、每步有成功判据。

## 开源协议

本项目代码以 **[GNU AGPL-3.0](./LICENSE)** 协议开源，版权所有 © 2026 灵枢（LingShu）作者。"灵枢 / LingShu" 名称、logo 与品牌视觉不随代码授权；衍生项目对外发布时须更换名称与品牌素材，不得暗示与本项目的作者或社区存在关联。

### 项目性质

灵枢是一个**实验性研究项目**（研究方向：长期记忆与智能体人格演化），以学习交流为目的开源，不是成熟产品。

- **本地优先**：记忆与数据只保存在本地设备上，模型接入所需的 API 由运行者自行配置。
- 智能体的全部回复均为 **AI 生成内容**，请自行辨别；不构成医疗、心理、法律等专业意见，也不应作为其替代。
- 拟人化交互（人格设定、情感表达、主动消息、长期记忆）本身是本项目的实验内容，请理性使用。

### 米家（MIoT）集成声明

本项目的米家（MIoT）功能使用小米**非官方接口**，与小米公司无任何隶属、认可或授权关系。该集成可能违反小米服务条款，由此产生的账号限制等一切后果由运行者自行承担。

### 第三方组件与素材

各第三方依赖沿用其自身协议（以 MIT / Apache-2.0 为主），其中需要特别说明的：

- **Twemoji**（`lingshu-gui` 内嵌 emoji 图形）：[CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) —— *Twemoji by Twitter, licensed under CC-BY 4.0*。
- **Silero VAD**（`silero_vad.onnx`）：MIT。
- **sherpa-onnx streaming paraformer ASR 模型**：[Apache-2.0](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-zh)（权重来自阿里 FunASR 训练，经 [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 项目 ONNX 转换发布）。
- **米家（MIoT）云集成**（`backend-node/src/services/mijiaService.ts`）：基于 [Do1e/mijia-api](https://github.com/Do1e/mijia-api)（GPL-3.0）移植为 TypeScript 并有增删改动，依 GPL-3.0 保留原项目版权声明；该部分仍按 GPL-3.0 授权，依 GPLv3 §13 / AGPLv3 §13 与本仓库的 AGPL-3.0 部分组合为一件作品一并分发，两部分各自保留原授权。

## 贡献

欢迎 Issue 与 Pull Request。首次提交 PR 前，请阅读 [CLA.md](./CLA.md)；按其中说明评论确认，即视为接受该协议。
