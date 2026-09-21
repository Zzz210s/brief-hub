# brief-hub（简报集散地）

[English](./README.md) | **简体中文**


本机所有 AI 会话（pi / Claude Code / opencode …）的**任务简报集散地**：会话完成任务时自动投一条带标签的简报，其它会话按**标签订阅**自动阅读与自己相关的简报并标记已读，下一轮不再检测同一条。

设计目标只有一个：**让协调几乎不花 token**。

## 独立可用(不依赖任何 AI)

集散地本体、CLI 与协议**不需要任何 AI 工具**:`bh publish` / `bh sub add` / `bh digest` 装上即可用(唯一依赖是 Node >= 24)。pi / Claude Code / Codex / opencode 的集成都只是**可选适配器**,`setup.sh` 检测到对应工具才接线。

## 它解决什么

多开 AI 会话时，各会话彼此是黑箱：A 会话改了 GitHub 仓库、调了系统配置，B 会话（专管 GitHub / 专管电脑优化）无从知晓。brief-hub 提供一条发布-订阅通路，且**只在真正相关时才把内容送进上下文**。

## 工作流

```
会话 A 任务完成 ──► 自动投稿(标题+要点+标签) ──► ~/.ai-brief-hub/briefs/YYYY-MM-DD.jsonl
                                                        │
会话 B(订阅 git/config) ──► 轮询:纯代码匹配标签 ──► 命中则投递标题批摘要 + 立即标记已读
                                                        │
                                              下一轮:同一条不再检测
```

## 省 token 的六个机制

| 机制 | 做法 | 效果 |
|---|---|---|
| **零 token 匹配** | 标签集合运算 + 算术打分，不调用模型 | 判断相关性不花钱 |
| **投稿零额外 token** | 标题/要点从会话已有产物派生（改动路径、执行过的命令、错误文本），不做 LLM 摘要 | 投稿不花钱 |
| **标题先行** | 一级投递只给标题批摘要（实测单条 ≈17 token）；正文用 `bh read <id>` 或 `/hub read <id>` 按需取 | 不相关的内容永不进上下文 |
| **增量读** | 游标是**按文件的字节偏移**；文件没变大就一次读都不做，也不产生任何注入 | 空闲会话近乎零成本 |
| **同键合并** | 同一来源同类事件在 10 分钟窗口内合并为一条（20 次推送 → 1 条） | 防抖动刷屏 |
| **每小时预算** | 默认 2000 token/小时，超出的按分数排队，只在摘要末尾给一行"另有 N 条未展开" | 突发事件不会淹没上下文 |

首次运行**只对齐游标、不投递历史**（避免一次灌进几百条旧简报）。

## 跨 AI(不只 pi)

核心是 **harness 无关**的:投稿/消费都通过 `bh` CLI 与文件协议,各 AI 只提供薄适配器。

| harness | 投稿(生产) | 消费(订阅投递) | 状态 |
|---|---|---|---|
| **pi** | 扩展 `brief-publisher`(任务完成/出错自动投) | 扩展 `brief-subscriber`(轮询 + 标题批摘要 + `/hub`) | 已实现 |
| **Claude Code** | hook `adapters/claude/hook.mjs`(PostToolUse 累积 → Stop/SessionEnd 投稿;并可解析会话 JSONL 兜底) | 同一 hook 的 `UserPromptSubmit` 分支:把摘要打到 stdout 作为上下文 | 已实现(需 `disableAllHooks: false`) |
| **任意 CLI / 脚本** | `bh publish --tool=<名> --sess-id=<id> …` | `bh digest --sess=<id>`(打印待读摘要并标记已读) | 已实现(通用契约) |
| opencode / 其它 | 调 `bh publish`(其插件 API 的 idle/end 事件) | `bh digest` 或自建轮询 | 契约就绪,适配器待做 |

### Claude Code 安装

```bash
node adapters/claude/install-hooks.mjs      # 幂等合并 hooks 到 ~/.claude/settings.json
```

> 注意:Claude Code 设置里 **`disableAllHooks: true` 会让所有 hook 失效**——本脚本不改这个开关,需要你自己设为 `false`(改前请确认其它 hook 的用途)。

### 新增一个 harness(三步)

1. **投稿**:把该 harness 的事实整理成 `SessionSnapshot`(改动路径 / 命令 / 错误 / cwd / 会话 id),调 `bh publish`(或 `bh publish-from <会话文件> --harness <名>`),核心会负责标签推导与去重。
2. **消费**:用 `bh digest --sess=<该会话 id>` 拿摘要(已在内部完成匹配、预算、合并、已读标记);能在 `UserPromptSubmit`/`idle` 之类时机注入就注入,不能就让人手动跑。
3. **订阅**:`bh sub add git config --sess=<该会话 id>`。所有 harness 共用同一份订阅数据(`~/.ai-brief-hub/subs/`)。


### 会话变多时的节流:拥挤度感知合并(为什么会话数上升不等于 token 上升)

同一条简报会被所有订阅了宽标签(如 `git`)的会话各投一次。brief-hub 维护 **拥挤度索引**(`index/fanout.json`,订阅变化时刷新):当一条简报的标签有 **>= 4 个订阅者** 时(`fanoutBatchK`),`auto` 订阅自动改为 **按小时合并**——一小时一条摘要,展开前 3 条标题,其余只给计数。**错误**(`sev:err`)与**直接点名**(`sess:<会话名>`)的简报始终立即投递。

实测:8 个订阅者、20 条简报按每分钟一条到达(会话每分钟轮询一次):

| 模式 | 注入消息数 | 注入 token |
|---|---|---|
| `immediate`(旧行为) | 152 | 3120 |
| `auto`(fanout 8 → hourly) | **8** | **160** |

**不丢任何东西**:每条简报都留在集散地、保持未读、可用 `bh list --unread` / `bh read <id>` 查看,只是"打扰的时机"变了。

另外两处 IO 优化:`bh list` / `/hub list` 只读文件尾部(`listTailBytes`,64KB)而非整文件;预算按**实际渲染出的摘要**计费,不再按命中条目逐条累加。

## 安装

```bash
# 本地开发目录 -> 家目录链接(扩展默认从 ~/brief-hub 解析)
cmd //c mklink /J %USERPROFILE%\brief-hub F:\0-code\20-active\tool-brief-hub
bash setup.sh          # 部署两个 pi 扩展 + 生成 bh 命令
```

部署内容：

| 位置 | 内容 |
|---|---|
| `~/.pi/agent/extensions/brief-publisher.ts` | 投稿器：`agent_settled` / `session_shutdown` 时投稿；出错立即投稿（`sev:err`） |
| `~/.pi/agent/extensions/brief-subscriber.ts` | 订阅器：轮询投递 + `/hub` 命令 |
| `~/bin/bh`、`~/bin/bh.cmd` | CLI |
| `~/.ai-brief-hub/` | 数据：`briefs/` `subs/` `state/` `config.json` |

重启 pi（或 `/reload`）后生效。

## 用法

```bash
bh status                                  # 集散地总览:简报数/订阅数/各消费者未读与预算
bh list --unread --sess=<会话>              # 未读简报
bh read <id>                               # 读正文(读完自动标已读)
bh sub add git config --sess=<会话>         # 订阅领域标签
bh sub add "repo:Zzz210s/*" --sess=<会话>   # 订阅具体仓库
bh sub add sev:err --sess=<会话>            # 只关心错误
bh poll --sess=<会话>                       # 手动跑一次轮询(调试)
```

pi 内命令：`/hub status | list | read <id> | sub add|rm <标签> | l1 | l2 | off`

## 标签体系

| 命名空间 | 例 | 来源 |
|---|---|---|
| 领域 | `git` `git.push` `git.commit` `config` `deps` `system` `github` `pi.config` `docker` | 从执行过的命令、改动路径自动推导 |
| 仓库 | `repo:Zzz210s/config-ai` | 会话目录的 `.git/config` |
| 项目 | `proj:config-ai` | 工作目录名 |
| 工具 / 会话 | `tool:pi` `sess:<会话名>` | 会话元数据 |
| 严重度 | `sev:err` `sev:warn` `sev:info` | 出错=err |
| 事件类型 | `task.done` `task.error` `git.push` | 事件种类 |

**父级订阅即命中子标签**：订阅 `git` 会收到 `git.push` / `git.commit`。

## 投递级别

| 级别 | 行为 | 何时用 |
|---|---|---|
| `l1`（默认） | 只投标题批摘要 + 状态徽标；要正文自己 `read` | 日常（最省 token） |
| `l2` | 命中即把正文投进上下文 | 高信任、需要自动跟进的会话 |
| `off` | 完全不投递 | 临时静音 |

静默时段：订阅里 `quietHours: [23, 7]`（支持跨零点）。

## 环境变量

| 变量 | 作用 |
|---|---|
| `BRIEF_HUB=0` | 完全关闭投稿与订阅 |
| `BRIEF_HUB_HOME` | 指定仓库目录（默认 `~/brief-hub`） |
| `BRIEF_HUB_HOME_OVERRIDE` | 覆盖**数据目录**（默认 `~/.ai-brief-hub`；测试用） |

## 架构（单文件 ≤200 行）

```
src/schema.ts       数据模型与默认值(纯)
src/tags.ts         标签推导 + 层级展开 + 打分(纯)
src/brief.ts        简报构建(纯,零额外 token)
src/match.ts        投递计划:过滤/打分/合并/预算 + 渲染(纯)
src/inbox.ts        一次轮询的完整流程(io)
src/store.ts        追加式 JSONL + 游标读取(io)
src/store-config.ts 订阅/状态/配置/统计(io)
src/cli.ts          CLI 命令
src/cli-support.ts  参数解析与读取辅助
extensions/         两个 pi 扩展(投稿器/订阅器)
test/               22 个用例(纯逻辑为主 + 临时数据目录的 io 测试)
```

## 验证

```bash
node --test test/*.test.js      # 22/22
```

端到端实测（临时数据目录）：

```
bh publish ...              -> 已投稿 b-…-18f0 [git.push] 推送 提交 → Zzz210s/config-ai
bh sub add git config ...   -> 订阅已更新
bh poll --sess=s2           -> (无投递: 首次运行:已对齐游标)
bh publish ...              -> 已投稿
bh poll --sess=s2           -> 简报集散地:1 条相关  - [git.push] … (b-…-8436)   # ≈17 token
bh poll --sess=s2           -> (无投递: 无命中)                                # 已读不再检测
bh status                   -> 消费者 s2: 未读 0 · 已读 1 · 本小时预算用量 17
```

## 边界

- 仅本机；跨机器不在 v1 范围（可后续换 git-backed 或 ntfy 传输）
- 简报标题由规则生成（不调用模型）；要点至多 3 条、标题 ≤60 字，保证有界
- 消费者只处理**自己订阅范围内**的简报；未订阅的永不进入上下文

## License

MIT
