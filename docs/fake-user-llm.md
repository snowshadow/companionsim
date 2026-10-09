# 仿真 agent 生成

> 探索时「用户这一句」由 LLM 扮演人群说出，不再用写死的模板。
> 回归永远用冻结原句，不重新生成。

## 边界（不能越）

| 能 | 不能 |
| --- | --- |
| 按画像、性格、兴趣开口 | 改变动作表（`speak` / `silence` / `leave` 由剧本决定） |
| 遵守本拍 `intent` / `tone` / `constraints` | 自己决定这一拍是沉默还是离开 |
| 接上一轮对话自然往下说 | 替被测 Agent 说话 |
| 参考仿真时间 | 改假时钟、改收件箱 |

生成失败时，本局停下并记原因；**不用 `template-v1` 顶替**。一局里混两种生成器，判卷无法归因。

## 提示词

版本 `fake-user-v3`，实现在 `server/fake-user-prompt.ts`，与评审提示词分开。
规范允许同模型，禁止同提示。改提示词必须同时改版本号，否则保存会校验失败。

送给模型的内容：

```json
{
  "simulation_time": "D1 20:18",
  "person": { "name": "陆川", "age": 24, "gender": "男", "personality": "ENFP",
              "interests": ["电子产品", "篮球"], "summary": "...",
              "behaviors": [{ "name": "兴趣先抛出来", "instructions": ["..."] }] },
  "previous_turns": [{ "role": "agent", "text": "..." }],
  "this_beat": { "intent": "...", "tone": "短、低落", "constraints": ["不要向对方要建议"] }
}
```

- `behaviors.instructions` 进提示词；`behaviors.violations` **不进**——那是判卷判「仿真 agent 演歪没有」的依据，不能拿来提示生成端。
- 只接受纯文本一句话。去引号 / 代码围栏，取第一行；空或超过 220 字按无效输出重试。

## 配置

`config/fake-user.json`：

```json
{
  "connectionSutId": "anthropic",
  "model": "claude-sonnet-4-5",
  "temperature": 0.9,
  "promptVersion": "fake-user-v3",
  "maxAttempts": 5,
  "backoffBaseMs": 1000,
  "attemptTimeoutMs": 30000,
  "totalTimeoutMs": 120000
}
```

- `connectionSutId` 指 `config/suts.json` 里一条连接。示例把仿真用户放在 Anthropic Messages，评审放在 OpenAI Chat Completions。密钥用 `${ENV}` 引用，不写进仓库。
- `api` 为 `openai` 或 `anthropic`。`extraBody` 原样进请求体，但不能覆盖 `model`、`messages`、`stream`。
- 换模型只改 `model`；换连接只改 `connectionSutId`。提示词版本和模型是两件事。

## 重试与退避

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `maxAttempts` | 5 | 一句台词最多试几次（含首次） |
| `backoffBaseMs` | 1000 | 退避基数；第 n 次重试等 `base * 2^(n-1)` |
| `attemptTimeoutMs` | 30000 | 单次调用超时 |
| `totalTimeoutMs` | 120000 | 一句台词的总预算，含所有重试与退避 |

- 等待 = 指数退避 + 0～250ms 抖动，且不超过剩余预算。
- 值得重试：网络错误、超时、`5xx`、`429`、输出为空 / 过长 / 截断 / 流未完整结束。
- 不值得重试（立即停）：`401` / `403` / `404` 等非 `429` 的 `4xx`、响应结构无效、非 JSON。
- 预算用尽或次数用尽 → 本局 `phase=failed`，`run.error` 写明哪个事件失败、试了几次。

## 记录

- `run.userGenerator` = `llm-v1` | `template-v1` | `frozen`。
- `run.generatorSnapshot`：开局冻结的 endpoint、模型、温度、提示词与 `promptHash`、重试参数。不含凭据值，只有 `credentialRef`。
- `run.generations[]`：每次 speak 的
  `{ eventId, attempts, startedAt, finishedAt, latencyMs, outcome, requestId?, returnedModel?, error? }`。
- 评审的 `simulator` 判定仍引用真实 `user-e1` 这类 turn id，用来区分「被测有问题」还是「仿真 agent 演歪了」。

## 代码位置

| 文件 | 作用 |
| --- | --- |
| `server/fake-user-prompt.ts` | 提示词、请求体组装、输出解析 |
| `server/fake-user-llm.ts` | 调用、重试、退避、错误分类 |
| `server/fake-user-config.ts` | 配置读写、冻结快照、凭据解析 |
| `server/fake-user.ts` | 旧的 `template-v1` 模板生成器（保留做冒烟） |
| `server/runtime.ts` | `huntUserLine`：按开局冻结的生成器分派，失败停下 |
| `src/screens/FakeUserSettingsForm.tsx` | 界面配置 |
