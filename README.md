# WeChat AI 好友

24小时在线的微信 AI 聊天机器人，拥有真实人格、长期记忆和多模态表达能力。通过多模型编排（DeepSeek + 智谱），让 AI 像真人好友一样聊天。

## 核心特性

- **真实人格**：可切换人设（损友/温柔知己/高冷佛系/自定义），有固定背景故事和宠物，回答自然不机械
- **长期记忆**：语义向量记忆系统，自动从聊天中提取关键信息，下次聊到时能回想起来
- **多模态交互**：能识别表情包内容、生成 AI 图片（会说"给你看看"就真的发图），图片外观根据持久设定保持一致性
- **情绪感知**：追踪对方情绪轨迹，自动调整回复风格（开心时一起嗨/难过时安慰/生气时站队）
- **工具调用**：自动搜索实时信息（多引擎 fallback），AI 生成图片
- **人性化行为**：随机延迟回复、消息分段发送、主动概率聊天、夜间免打扰

## 架构

```
微信消息 → 消息分类 → 上下文构建（人设+情绪+记忆）
         → DeepSeek thinking 长链推理 + 工具调用
         → 三重图片自纠正管线
         → 微信回复
```

### 多模型协作

| 模型 | 用途 |
|---|---|
| DeepSeek Chat + thinking | 核心对话推理、工具调用决策 |
| 智谱 GLM-4V-Flash | 表情包文字识别、语义匹配 |
| 智谱 embedding-2 (256维) | 记忆向量化、相似度检索 |
| 智谱 CogView-3-Flash | AI 图片生成 |

## 快速开始

### 前提条件

- Node.js 22+
- PC 微信（用于 wechaty-puppet-wechat4u 扫码登录）
- DeepSeek API Key（https://platform.deepseek.com）
- 智谱 API Key（https://open.bigmodel.cn，用于视觉识别+图片生成）

### 1. 克隆并安装

```bash
git clone https://github.com/foerever-lh-03/wechat-ai-friend.git
cd wechat-ai-friend
npm install
```

### 2. 配置

```bash
cp .env.example .env
# 编辑 .env，填入你的 API Key 和配置
```

### 3. 运行

```bash
npm start
```

首次运行会弹出二维码，用 PC 微信扫描登录。

### Docker 部署（推荐）

```bash
docker build -t wechat-ai-friend .
docker run -d --name wechat-ai-friend \
  --restart unless-stopped \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/.env:/app/.env \
  wechat-ai-friend
```

## 自定义人设

编辑 `config/facts.js` 修改持久设定（宠物、居住地、职业等），编辑 `config/personas/me.js` 调整对话风格。

`config/personas/` 下提供了多套预设人设，修改 `.env` 中的 `PERSONA` 即可切换。

## 项目结构

```
├── src/
│   ├── index.js          # 入口
│   ├── bot.js            # 机器人核心逻辑
│   ├── chat.js           # AI 引擎（DeepSeek + 智谱）
│   ├── tools.js          # 工具定义（搜索、生图）
│   ├── persona.js        # 人设加载与 System Prompt 构建
│   ├── memory.js         # 语义向量记忆
│   ├── emotion.js        # 情绪追踪状态机
│   ├── sticker.js        # 表情包管理
│   ├── reminder.js       # 提醒功能
│   └── store.js          # 数据持久化
├── config/
│   ├── index.js          # 配置加载
│   ├── facts.js          # 持久人设事实
│   └── personas/         # 人设模板
├── Dockerfile
├── .env.example
└── package.json
```
