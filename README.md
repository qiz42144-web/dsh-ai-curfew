# AI Curfew · AI 熄灯

[中文](README.md) | [English](README.en.md)

**把「AI 永远在线」拧成「AI 也要下班」。**

到点之后回复越来越短，深夜档把 `max_tokens` 从 2048 慢慢压到 64，凌晨三点只回一句「明天再说」。
高峰时段不上班、低谷时段上班；已下班状态照样收消息，但只回一个「。」。

> 卖点不是让模型**演**下班，而是**真的**下班：下班后一个 API 请求都不发 —— 0 token、0 成本、毫秒返回。

![node >=22](badges/node.svg)
![platform DeepSeek Harness](badges/platform.svg)
![dependencies none](badges/dependencies.svg)
![tests node --test](badges/tests.svg)
![off-duty cost 0 tokens](badges/cost.svg)
![license MIT](badges/license.svg)

```
on-duty 上班中 ──→ winding 打烊倒计时 ──→ off-duty 已下班 ──→ lights-out 熄灯
   (满血)          maxTokens 2048→64        只回「。」        只回「明天再说。」
```

## 行为

| 时刻 | 判定 | 回法 |
|---|---|---|
| 周二 10:00 | 高峰 | `。` |
| 周二 20:00 | 低谷、未到宵禁 | 正常上班 |
| 周二 23:30 | 宵禁 winding | 短回复，预算 ≈1824 |
| 周三 01:30 | 宵禁 winding | 一句话，预算 ≈560 |
| 周三 02:30 | 宵禁 winding | 最多 20 字，预算 ≈192 |
| 周三 03:10 | 宵禁到底 | `明天再说。` |
| 周日 14:00 | 周末全天低谷 | 正常上班 |

两条独立的轴，**取谁更严谁生效**：

- **A 峰谷班表** —— 高峰不上班、低谷上班（周一至周五 9:00–12:00、14:00–18:00，扣掉周末与法定节假日）
- **B 宵禁曲线** —— 到点后预算沿锚点表从 2048 滑到 64，凌晨 3 点彻底熄灯

闸门 A 可以单独关掉，退化成纯宵禁插件。

## 安装

```sh
dsh plugin --profile <你的 profile> add link:/absolute/path/to/ai-curfew
```

装好后客户端半体会由 `/plugins` 提供（侧栏底部的状态胶囊），Host 半体即刻生效。

## 配置

配置是 `$DSH_HOME/dsh-ai-curfew/config.json`，**改完即生效**（按 mtime 热读，不用重启）。
文件里只写你想改的键，其余走默认值：

```json
{
  "curfewStart": "23:00",
  "lightsOut": "03:00",
  "wakeUp": "09:00",
  "peakShift": true,
  "offDutyReply": "。",
  "lightsOutReply": "明天再说。",
  "debugNow": "01:30"
}
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `timezone` | `Asia/Shanghai` | 班表按时区本地时间算 |
| `wakeUp` / `curfewStart` / `lightsOut` | `09:00` / `23:00` / `03:00` | 一天的四个相位，窗口可跨午夜 |
| `anchors` | 23:00→2048 … 03:00→64 | 预算锚点表，`[时刻, tokens]` |
| `curve` | `linear` | `linear`（锚点间插值） / `step`（阶梯） / `easeIn`（先稳后崩） |
| `peakShift` / `peakWindows` / `weekendValley` / `holidays` | 开 / 9-12,14-18 / 开 / 2026 表 | 峰谷闸门 |
| `offDutyReply` / `lightsOutReply` | `。` / `明天再说。` | 不请求时回什么 |
| `tiredPersona` / `tierTexts` | 开 / 四档 | 往提示词注入的疲惫档位，每四分之一窗口一档 |
| `denyToolsWhenOffDuty` | `true` | 下班后不再执行工具调用 |
| `windingReasoningEffort` | `null` | 可选：宵禁期间降到某个 reasoning effort id |
| `dryRun` | `false` | 只判定并记录，照常发请求（安全试跑） |
| `debugNow` | `null` | 时间机器：`HH:MM` 或 `YYYY-MM-DD HH:MM` |
| `applyToSubagents` | `true` | 子代理是否一起宵禁；设 `false` 让派出去的活继续干完 |
| `exemptSessions` | `[]` | 豁免的会话 id，完全不干预 |
| `safetyMaxTokens` | `null` | 见下方说明，默认关闭 |

### 命令行

```
/curfew                    看班表：当前判定、预算与依据
/curfew overtime 30m       强制加班 30 分钟（宵禁暂停，期间正常上班）
/curfew off                立刻下班
/curfew auto               恢复自动班表（加班 / 强制下班 / 时间机器 全部取消）
/curfew debug 01:30        时间机器，随时试任何时段
/curfew debug clear        回到真实时间
```

命令不经过模型，所以下班状态下也能用 —— 这是「把自己关在门外」的逃生口。

**为什么是「加班」不是「请假」**：请假的主语是 AI，是它在请求不上班；但 `/curfew overtime`
实际发生的是**你命令它加班**。同理 `off` 只管「AI 下班」这一件事，不再兼职表示「宵禁关掉」。

### 关于 `safetyMaxTokens`

默认**关闭**，这是有意的。下班由 `llm/stream` 短路保证，所以第二道上限在它有用的地方都是多余的；
而在它不该管的地方反而有害 —— reasoning 模型会把很小的预算全花在思考上，于是既没有正文也没有
工具调用，供应商直接判这一轮失败：

```
Command Code reached the output token limit without producing answer text or a tool call
(finish_reason=length, max_tokens=16, outputTokens=16, reasoningTokens=16)  [OUTPUT_TOKEN_LIMIT]
```

想加一道硬上限可以自己填数字，但请按模型的**思考预算**来给，而不是按你期望的回复长度。

## 原理

下班回复走 `llm/stream` waterfall 的**短路**：直接吐一段合成的流，完全不触网。
这不是 `agent/pre-step` 的 `reject` —— 那样这一轮会彻底没有回复，用户看到的是「AI 死了」。
需求是「照样收消息，只回一个句号」，所以必须产出一条**真实的 assistant 消息**，由 agent loop 自己
组装并写入会话日志，我们只负责提供 chunk。

完整设计、踩过的坑、以及「为什么不能用 `agent/pre-step` + 手写事件」见
[`docs/architecture.md`](docs/architecture.md)；核实过的 DSH 契约见
[`docs/dsh-contracts.md`](docs/dsh-contracts.md)。

## 开发

```sh
node --test          # 零依赖；验收表就是断言
```

行为判定全是纯函数（`duty.js` / `clock.js`），所以整套班表不需要跑 Host 就能测。

徽章是**提交进仓库的本地 SVG**（`node scripts/make-badges.mjs` 重新生成），不走 shields.io ——
不依赖任何第三方服务，也不会因为图片代理不可达而裂图。

**改完代码要重启 DSH 才生效。** 运行中的进程按 URL 缓存插件的 ES module，停用再启用只会重跑
`apply()`，不会重新 import。`scripts/dev-reload.ps1` 用一个新 revision 目录 + 重接 junction 绕开它，
代价只要一次停用/启用。为什么 HMR 那条路走不通，也记在
[`docs/architecture.md`](docs/architecture.md#developing-against-a-running-host)。

## 状态

**尚未发布到 npm**，从 GitHub 装上就能用（见上面的安装一节）；版本 `0.1.0`。
哪些行为已经实测验收、哪些还没有，见 [`docs/acceptance.md`](docs/acceptance.md)。

## 许可与出处

MIT。峰谷口径与 2026 节假日数据的来源、署名，以及必须每年 11 月补表的维护责任，见
[`PROVENANCE.md`](PROVENANCE.md)。
