# 微信 AI 好友 — 更新日志

## 2026-05-26

### 图片生成切换回 CogView + 水印去除
- `src/chat.js` — 重写 `generateImage()`：使用智谱 CogView-3-Flash 生图 → 下载 → sharp 裁剪底部36px（去"AI生成"水印） → 保存本地 → 返回文件路径
  - 新增 `_downloadAndCrop()` 方法：fetch 下载 + sharp extract 裁剪 + 保存到 `/app/data/generated/`
  - 新增依赖 `sharp` (^0.33.0)，Dockerfile 加装 `vips-dev vips-cpp vips-heif`
- `src/bot.js` — `sendGeneratedImage()` 和 `[图片]` 路径同时支持 URL 和本地文件（`FileBox.fromUrl` / `FileBox.fromFile`）
- `config/personas/me.js` — 新增规则：如果回复中说"拍了张照""发给你看"之类的话，必须调用 generate_image，不能把📎表情包当照片发

### 图片请求检测修复
- `src/bot.js` — 重写 `imageReqPatterns` + `contextFollowUp`：
  - 扩展正则：`发[张个一]` 不再强制要求"图"后缀，新增 `再发|重新发|重发`，`图片.*[呢吗吧]|图呢`
  - 上下文追问强化：AI 刚说"拍了一张"但没实际发图时，用户追问 → 强化指令 "你现在必须立即调用 generate_image 工具生成图片！"
  - 新增 `contextFollowUp` 检测 AI 承诺发图但未兑现的场景

### MemeMeow 预过滤优化
- `src/sticker.js` — MemeMeow 请求量 15→5 张，减少垃圾结果对视觉 API 的浪费
  - API盒子新增 3 级回退：原词 → +"表情包" → +"搞笑"
  - 新增 URL 预过滤：排除抖音/小红书/知乎/微信链接、非图片扩展名、超长追踪URL
- `src/chat.js` — 新增 `generateImage(prompt)`，调用智谱 CogView-3-Flash（完全免费，已有 API key）
- `src/tools.js` — 新增 `generate_image` tool 定义
- `src/bot.js` — 检测模型输出的 `[图片]` 标记，用 AI 从对话上下文**提炼画面描述**再传给 CogView 生图，解决正则截取不准确的问题
  - 流程：`[图片]` → AI 读对话上下文提炼 prompt → CogView 生图 → FileBox 发送 → 移除文字中的 `[图片]`
  - 先发图再发文字，模拟真人聊天顺序

### 表情包语境匹配优化
- `src/chat.js` `readStickerText()` — 视觉模型现在接收**回复语境**（replyContext），判断画面+文字是否和当前对话氛围协调，而不只看关键词字面匹配
- `src/bot.js` `stickerTextMatch/sendStickerForKeyword` — 全程透传 replyContext 到视觉判断
- `src/bot.js` `decideSticker()` —
  - **修复 mood 检测失效 bug**：`emotion.mood` → `emotion.emotion`（旧字段名错误，导致情绪分类全部落入 neutral）
  - 告别/结束/忙碌信号不再自动追加表情包
  - neutral 概率 30%→22%

### 向量语义记忆（长效记忆）
- `src/chat.js` — 新增 `embed(text)` 方法，改用智谱 `embedding-2`（256维，免费）。DeepSeek embedding 返回 404 不可用
- `src/memory.js` — 核心重写：
  - 新增余弦相似度检索替代关键词匹配
  - 向量持久化到 `embeddings.json`
  - 后台批量向量化（2秒合并，不阻塞回复）
  - `saveExchange` 自动从用户消息提取事实（名字/职业/地点/爱好等）
  - `getContextMessages` 改为 async
  - 新增 `_backfillEmbeddings()` — 启动时为已有记忆补向量
  - 修复 `extractFacts()` 误提取"叫我起床"→称呼:"起床"（扩充 notNames 过滤表 ~120词）
- `src/bot.js` — 两处 `getContextMessages` 调用添加 `await`
- `config/personas/me.js` — 强化"保持前后一致是底线"，解决模型否认自己刚说过的话

### 表情包位置按语境交错发送
- `src/bot.js` — 新增 `sendStickerForKeyword()` 统一函数
  - 表情包不再总放最后，改为按模型输出的 `📎keyword` 位置发送
  - 例如 `📎好的 行，试试""不好玩找你` → 先发"好的"表情包 → 再发文字
  - 主动消息和普通回复共用，减少 ~130 行重复代码

### 上下文窗口 & 人设优化
- `config/index.js` — `contextWindow` 默认 30→50
- `config/personas/me.js` — few-shot 14对→7对，新增防重复规则
- `src/memory.js` — 构造参数默认 20→50
- `.env` — `CONTEXT_WINDOW` 20→50

### 表情包过滤修复
- `src/chat.js` `readStickerText()` — 修复智谱返回 markdown JSON 导致解析失败（剥离 ```json 包装），失败时拒绝放行
- `src/sticker.js` — 移除 `[抠鼻]`/`[鄙视]`/`[白眼]`，将"无语"移至 funny2 分类
- `src/bot.js` — GIF 放候选末尾（智谱视觉 API 不支持 GIF），新增 `contextEmoji()` 情绪适配
- `src/bot.js` — 新增 `decideSticker()` 根据情绪/分类自动决定是否发表情包

### 消息处理优化
- `src/bot.js` — 区分 Emoticon(`[发了一个表情包]`) vs Image(`[收到一张图片]`)，修复表情包被当视频
- `src/bot.js` — 新增 `normalizeKeyword()` 映射口语词到搜索词（"干饭"→"吃饭"等）

### 表情包数据源 & 本地缓存 + 用户表情包回收
- `src/sticker.js` — 完全重写：
  - 新增 `_searchMemeMeow(keyword)` — MemeMeow API 作为第二数据源
  - 新增 URL 缓存 `sticker_cache.json`（每关键词最多20张）
  - 新增用户表情包缓存 `_matchUserStickers()` + `addUserSticker()`
  - 搜索优先级：用户表情包 → URL缓存 → API盒子 → MemeMeow
- `src/chat.js` — 新增 `tagSticker()` 用视觉模型提取表情包关键词标签
- `src/bot.js` — `sendStickerForKeyword()` 支持 `FileBox.fromFile()`（用户表情包）和 `FileBox.fromUrl()`（在线）
- ⚠️ wechat4u web 协议无法下载 emoticon → 用户表情包回收暂不可用

### 磁盘清理
- Docker 闲置镜像 + 构建缓存：释放 ~8GB
- 旧本地表情包 `/opt/wechat-bot/stickers/`（1654张/187MB）：已删除
- 总磁盘：16G → 7.8G（20%）

### 部署
- 服务端：120.53.225.115 `/opt/wechat-bot/`，Docker `wechat-ai-friend`
- 配置挂载：`./src`、`./config`、`./data` 为 volume
