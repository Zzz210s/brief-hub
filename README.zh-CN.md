# brief-hub（简报集散地）

[English](./README.md) | **简体中文**

一台机器上所有 AI 会话的**本地简报集散地**:任何会话任务完成时投一条带标签的简报,其它会话按**标签订阅**,自动读取与自己相关的,且**同一条只看一次**。

协作成本几乎为零。集散地本体、CLI 与协议**不需要任何 AI 工具**;pi / Claude Code / Codex / opencode 的集成都只是可选适配器。

## 它解决什么

并排跑的多个 AI 会话彼此看不见。一个改了 GitHub 仓库或系统配置,"专管 GitHub""专管电脑优化"的会话根本不知道。brief-hub 是一条发布/订阅通道,只在**内容真的相关**时才把东西送进上下文,并把开销压到很低。

## 工作流

```
会话 A 完成 ──► 带标签的简报 ──► ~/.ai-brief-hub/briefs/YYYY-MM-DD.jsonl   (归档,可 grep)
                                    └─► shards/<标签>.jsonl                (共享索引)
会话 B(已订阅) ──► 纯代码标签匹配 ──► 注入标题摘要 ──► 立即标记已读
                                          └─ 下一轮:同一条不再被检测到
```

## 噪声控制

通知系统的典型失败是噪声淹没信号。三道闸门,全部在**核心层**,因此**所有 harness 自动继承**:

| 类 | 例子 | 处理 |
|---|---|---|
| **noise** | `[object Object]`、`[rtk] … No hook installed`、`SyntaxWarning`、`unexpected EOF`、`Could not find edits[0]`、`Dangerous command blocked`、我们自己的维护命令、多行 `123: 代码` 输出 | **丢弃** —— 根本不投 |
| **tool** | `ENOENT`、`EACCES`、超时、权限 | 投 `sev:warn` → 落"需要核对/仅供参考",**不占"必须处理"配额** |
| **task** | `npm ERR!`、测试 `FAIL`、`Traceback`、`exit code N` | 投 `sev:err` → 必须处理 |

已实测并消除的其它浪费:

- **自简报抑制**:会话不会收到自己刚投的简报。
- **协议只发一次**:之后注入用一行表头(每次省约 120 token)。
- **首次对齐改为显式标记**(`alignedAt`):集散地为空时对齐后不再把下一批简报静默吞掉。
- **`bh purge`**:命中简报先落成文件 → **移入系统回收站** → 再从归档与分片剔除,并清掉各会话的 `unread`。
- **`bh status --orphans`**:列出没有任何会话处理过的简报 —— 用来发现残余噪声源。

## token 预算

| 机制 | 做法 | 效果 |
|---|---|---|
| 零 token 匹配 | 标签集合运算 + 算术打分,不调模型 | 判断相关性免费 |
| 投稿零额外 token | 标题/要点从会话已有产物派生 | 投稿免费 |
| 标题先行 | 一级投递只给标题摘要(实测单条约 17 token);正文按需 `bh read <id>` | 无关内容不进上下文 |
| 增量读取 | 按文件**字节游标**;文件没变大就完全不读 | 空闲会话近乎 0 |
| 合并 | 同去重键在 10 分钟窗口内合并(20 次推送 → 1 条) | 不刷屏 |
| 每小时预算 | 默认 2000 token/小时;超出按分数排队并只给计数 | 突发不会淹没上下文 |

实测(8 个订阅者,20 条简报按每分钟一条到达):

| 模式 | 注入次数 | token |
|---|---|---|
| `immediate` | 152 | 3120 |
| `auto`(fanout ≥ 4 → 按小时合并) | **8** | **160** |

## 规模:拥挤度合并 + 共享分片

**投递**:一条简报的标签有 **≥ 4 个订阅者**(`fanoutBatchK`)时,`auto` 订阅自动改为按小时合并 —— 一小时一条摘要,展开前 3 条标题,其余只给计数。错误(`sev:err`)与点名(`sess:<会话名>`)始终立即。

**IO**:投稿时按标签链把简报写入 `shards/<标签>.jsonl`(一次写入),同一标签的所有订阅者读**同一份文件**,不再各自扫归档;分片的 `size`/`mtime` 未变化则整轮跳过。

实测(8 订阅者 × 20 条简报):

| 指标 | 修前 | 修后 |
|---|---|---|
| 累计读取字节 | 853,248 | **77,768** |
| 空转 160 次轮询 | — | **读 0 字节,跳过 160 个分片** |

## 接收端处理协议

注入发生在会话的**下一轮开工**(扩展无法唤醒空闲会话)。每条简报对接收端分为三类:

| 类 | 触发 | 期望 |
|---|---|---|
| **act 必须处理** | `sev:err`、被 `sess:` 点名、带建议动作 | 必须处理;错误不能只延迟 |
| **check 需要核对** | 同仓库 / 同目录 / 标签精确命中 | 读全文核对 |
| **fyi 仅供参考** | 父级标签命中、陈旧条目 | 看过即可 |

```bash
bh read <id>                          # 全文:要点 / 工件 / 建议动作 / 来源
bh handle <id> --note "结论"          # 处理完:永不再浮现
bh defer <id>                         # 延迟:4 小时后重新提醒
bh pending --sess=<会话id>            # 当前队列(按优先级分组)
```

## 安装

```bash
bash setup.sh
```

建 `~/.ai-brief-hub/`、装 `bh` 命令(bash + cmd)、检测到哪个 AI 工具就接线哪个适配器。唯一依赖是 Node ≥ 24。

| Harness | 投稿 | 消费 |
|---|---|---|
| **pi** | 扩展 `brief-publisher`(任务完成/出错) | 扩展 `brief-subscriber`(下一轮注入,`/hub`) |
| **Claude Code** | hook `adapters/claude/hook.mjs`(`PostToolUse` 累积 → `Stop`/`SessionEnd` 投稿) | 同一 hook 的 `UserPromptSubmit` 打印摘要(需 `disableAllHooks: false`) |
| **Codex** | `notify` hook `adapters/codex/notify.mjs`(载荷是最后一个 argv,并解析 rollout) | `bh digest` |
| **opencode** | 插件 `adapters/opencode/plugin.js`(`session.idle` / `session.error`) | 同一插件的 `chat.message` 注入 `output.parts` |
| 其它 CLI | `bh publish --tool=<名> --sess-id=<id> …` | `bh digest --sess=<id>` |

新增 harness:把事实转成快照后调 `bh publish`(或 `bh publish-from <文件> --harness <名>`);消费调 `bh digest --sess=<id>`;订阅用 `bh sub add <标签> --sess=<id>`。标签推导、噪声过滤、合并、预算与已读标记都在核心层完成。

## 用法

```bash
bh doctor                             # 自检:目录、命令、检测到的 harness
bh status                             # 总览:简报数、订阅数、各消费者未读与预算
bh status --orphans                   # 无人处理的简报(找噪声源)
bh list [--unread] [--sess=<id>]      # 最近简报(尾部有界读取)
bh read <id>                          # 全文
bh publish --tool manual --sess-id demo --title "第一条简报" --changed a.txt [--tag system]
bh sub add git config "repo:owner/name" --sess=<id>
bh digest --sess=<id>                 # 打印待读摘要并标记已读
bh poll --sess=<id>                   # 手动跑一轮(调试)
bh purge --noise                      # 预览:清噪声类简报
bh purge --noise --yes                # 执行:命中内容移入系统回收站
bh purge --kind task.error --before 2026-09-22 --yes
```

## 标签体系

| 命名空间 | 例子 | 来源 |
|---|---|---|
| 领域 | `git`、`git.push`、`config`、`deps`、`system`、`github`、`pi.config` | 执行的命令、改动的路径 |
| 仓库 | `repo:owner/name` | 会话目录的 `.git/config` |
| 项目 | `proj:<目录名>` | 工作目录 |
| 工具/会话 | `tool:pi`、`sess:<会话名>` | 会话元数据 |
| 严重度 | `sev:err`、`sev:warn`、`sev:info` | 错误分类 |
| 类型 | `task.done`、`task.error`、`git.push` | 事件类型 |

订阅父标签会命中子标签:订阅 `git` 也能收到 `git.push` / `git.commit`。

## 环境变量

| 变量 | 作用 |
|---|---|
| `BRIEF_HUB=0` | 关闭投稿与订阅 |
| `BRIEF_HUB_HOME` | 仓库目录(默认 `~/brief-hub`) |
| `BRIEF_HUB_HOME_OVERRIDE` | 覆盖**数据**目录(默认 `~/.ai-brief-hub`) |

## 架构

```
src/schema.ts        数据模型与默认值(纯)
src/tags.ts          标签推导、层级、打分(纯)
src/errors.ts        失败文本提取 + noise/tool/task 分类(纯)
src/brief.ts         简报构建、噪声过滤、shouldPublish(纯)
src/match.ts         投递计划:过滤/打分/合并/预算,摘要渲染(纯)
src/handling.ts      接收端协议:分类 / 浮现策略 / 协议渲染(纯)
src/purge.ts         清理选择 + JSONL 行剔除(纯)
src/transcript.ts    跨 harness 事实抽取(Codex 载荷、通用 JSONL)
src/shards.ts        标签分片:一次写入、多读者、mtime 跳过
src/inbox.ts         一轮轮询(io)
src/store.ts         追加式 JSONL + 游标读取(io)
src/store-config.ts  订阅 / 状态 / 配置 / 拥挤度索引 / 统计(io)
src/recycle.ts       把文件移入系统回收站
src/inject.ts        所有 harness 共用的注入措辞
src/cli.ts           CLI 命令
src/cli-support.ts   参数解析、读取助手、doctor、orphans、purge
extensions/          pi 投稿器 + 订阅器
adapters/            Claude hook · Codex notify · opencode 插件
test/                58 个用例(纯逻辑 + 适配器端到端,跑在临时集散地上)
```

## 验证

```bash
node --test test/*.test.js      # 58/58
```

跨 harness 实测:pi 会话投稿 → Claude 会话的 `UserPromptSubmit` 打印「1 条相关」并标记已读 → 下一轮无输出。独立可用实测(临时 `HOME`、无任何 AI 工具):`setup.sh` 建好集散地、装好 `bh`、接线 0 个适配器,CLI 往返正常。

## 边界

- 仅本机;跨机传输不在范围内(可后续接 git 或 ntfy)。
- 标题由规则生成,≤60 字,最多 3 条要点 —— 不调模型。
- 一个消费者只会看到自己订阅范围内的简报。
- 扩展无法唤醒空闲会话,投递发生在它下一轮开工时。

## License

MIT
