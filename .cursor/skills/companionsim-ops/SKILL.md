---
name: companionsim-ops
description: >-
  Registers an OpenAI- or Anthropic-compatible system under test and drives
  CompanionSim runs: configuring the simulator and judge, launching exploration
  or regression, reading evidence, retrying a judge, and diagnosing auth or
  quota failures. Use when the user wants to connect an agent, start a
  simulation, read a run, or retry a judge.
---

# CompanionSim 操作（登记被测 · 发起运行 · 看证据）

本地开发时平台地址是 `http://localhost:5260`。下文用 `$SIM_EVAL_BASE` 表示它：

```bash
export SIM_EVAL_BASE=http://localhost:5260
export SIM_EVAL_KEY=simk_…    # 人在「我的」页生成后交给 agent
```

本 Skill 登记被测、配置模型、发起探索或回归、读证据、排障。
人群与剧本见 [companionsim-author](../companionsim-author/SKILL.md)。

文中的 `docs/...` 是本仓库内路径。Skill 装在别处时，以平台接口为准：`GET /api/health`、`GET /api/catalog`。读不到文档时不要臆造字段名。

- 契约 → `docs/agent-spec.md`
- 账号、Key、配额 → `docs/auth-and-roles.md`
- 一局留下什么 → `docs/run-evidence.md`
- 架构 → `docs/architecture.md`

## 何时用

- 把一个 OpenAI 或 Anthropic 兼容的 Agent 接进来。
- 改仿真用户或评审所用的连接和模型。
- 发起探索或回归，查看某一局，或只重试评审。
- 运行报错：未登录、额度不足、被测 4xx、模型凭据失效。

## 一、确认平台已启动

```bash
npm install
cp config/platform.example.json config/platform.json
npm run admin-password -- '<密码>'    # 哈希写入 superadmin.passwordHash，并填写 mysql
npm run db:migrate
npm run dev                           # http://localhost:5260
curl -s $SIM_EVAL_BASE/api/health
```

`/api/health` 不需要登录，只返回状态，不返回凭据。

## 二、身份

人用用户名和密码登录。没有自助注册。管理员来自 `config/platform.json` 的 `superadmin`，并可创建其他账号（`POST /api/admin/users`）。

本地 agent 使用人在「我的」页生成的 Key：

| 身份 | 能做 | 不能做 |
| --- | --- | --- |
| 登录用户 | 发起探索/回归、判定、重试评审、生成自己的 Key | 改被测和模型配置（除非是管理员） |
| 管理员 | 上面全部，外加被测、仿真用户、评审、用户与配额 | — |
| Key | 读目录与记录、提交人群/剧本、发起运行、重试评审 | 代人判定；改配置；Key 不是管理员 |

```bash
curl -s -H "Authorization: Bearer $SIM_EVAL_KEY" $SIM_EVAL_BASE/api/auth/me
```

开跑前可先估算额度。超过当日上限会得到 409，响应里有预估、今日已用和上限：

```bash
curl -s -H "Authorization: Bearer $SIM_EVAL_KEY" -H 'Content-Type: application/json' \
  -X POST $SIM_EVAL_BASE/api/quota/estimate \
  -d '{"mode":"hunt","personId":"p-linxia","personVersion":"v1","scriptId":"s-short-memory","scriptVersion":"v1"}'
```

## 三、登记一个 OpenAI 或 Anthropic 兼容的被测

默认被测是 `fixture`（进程内样例）。外部 Agent 用 `transport: "sse"`：

| `api` | 协议 |
| --- | --- |
| `openai` | Chat Completions |
| `anthropic` | Messages |

密钥用 `${ENV}`，真实值放环境变量或 `.env.local`，不要写进 `config/suts.json`。

OpenAI Chat Completions：

```json
{
  "id": "openai-agent",
  "name": "OpenAI 兼容被测",
  "transport": "sse",
  "api": "openai",
  "url": "https://api.openai.com/v1/chat/completions",
  "model": "<模型名>",
  "apiKey": "${OPENAI_API_KEY}"
}
```

Anthropic Messages：

```json
{
  "id": "anthropic-agent",
  "name": "Anthropic 兼容被测",
  "transport": "sse",
  "api": "anthropic",
  "url": "https://api.anthropic.com/v1/messages",
  "model": "<模型名>",
  "apiKey": "${ANTHROPIC_API_KEY}"
}
```

要点：

- `description` 是评审「出戏」的基线，不是备注。写清说话方式、关系边界，以及被问身份时怎么回答。
- 被测要求每局一个独立会话时，用 `sessionIdField` 指明请求体里的字段名。平台每局生成独立 id。
- 有元信息端点就填 `metaUrl`。没有的字段保持未知，不要编造版本号。
- 没有记忆或收件箱接口时，对应维度记「测不了」。

登记需要管理员：在「被测」页保存，或由管理员调用 `POST /api/suts`、`PUT /api/suts/{id}`。保存后用 `GET /api/catalog` 回读。删除被测会使引用它的旧运行无法只重试评审。

## 四、仿真用户与评审

两条配置都通过 `connectionSutId` 引用 `config/suts.json` 里的一条连接。

- `config/fake-user.json`：仿真用户。示例走 Anthropic Messages（`api: "anthropic"`），密钥 `ANTHROPIC_API_KEY`。
- `config/judge.json`：评审。示例走 OpenAI Chat Completions（`api: "openai"`），密钥 `OPENAI_API_KEY`。

两边使用不同模型。文件名和接口路径仍是 `fake-user` / `/api/fake-user`。界面上仿真在「仿真」页，评审在「LLM-as-judge」页，被测在「被测」页。

改提示词要同时改版本号，否则保存会被拒绝。只有管理员能改这些配置。

## 五、发起运行

- 探索：`POST /api/runs`，`{"mode":"hunt","personId","personVersion","scriptId","scriptVersion","sutId"}`。
- 回归：`{"mode":"replay","snapshotId","sutId"}`。回归使用冻结台词，不再调用仿真用户。

界面在探索页和回归页发起。对话结束后自动评审。评审失败可以只重试评审：`POST /api/runs/{id}/judge`。

## 六、读证据

- `turns`：用户台词、被测回复、事件。
- `requests`：发送时间、首字耗时、总耗时、HTTP 状态。
- `evaluations[-1].result`：各维判定与 `evidenceTurnIds`。
- `facts`：缺记忆或收件箱时记「测不了」，不是通过。
- `decisions[-1]`：人的判定。Key 不能代签。

## 七、接口

| 接口 | 谁可以 | 说明 |
| --- | --- | --- |
| `GET /api/health` | 公开 | 进程与数据库状态 |
| `POST /api/auth/login` | 公开 | `{ "username", "password" }` |
| `GET /api/auth/me` | 登录 / Key | 身份、是否管理员、今日额度 |
| `GET /api/catalog` | read | 人群、剧本、快照、被测 |
| `GET /api/runs`、`GET /api/runs/{id}` | read | 列表 / 单局证据 |
| `POST /api/artifacts` | 登录用户或 `author` Key | 提交人群或剧本 |
| `POST /api/runs` | 登录用户或 `run` Key | 发起探索或回归 |
| `POST /api/quota/estimate` | 登录 / Key | 开跑前估算 |
| `POST /api/runs/{id}/judge` | 登录用户或 `run` Key | 只重试评审 |
| `POST /api/runs/{id}/decide` | 仅人 | 纳入回归 / 驳回 / 无法判定 |
| `POST` / `PUT /api/suts`，`PUT /api/judge`，`PUT /api/fake-user` | 仅管理员 | 改配置 |
| `POST /api/admin/users` | 仅管理员 | 创建账号 |

## 八、排障

| 现象 | 处理 |
| --- | --- |
| `401 请先登录` | 检查 Key 或重新登录 |
| `403` 改配置 | 用管理员在界面保存 |
| `403` 且涉及判定 | 判定由人做，Key 会被拒绝 |
| `409` 额度不足 | 响应里有预估、已用、上限；换更短的剧本或请管理员调整 |
| 缺 `config/platform.json` 或表不存在 | 按第一节填写配置并执行 `npm run db:migrate` |
| `环境变量 X 未设置` | 补上对应密钥并重启 |
| 仿真用户未配置 | 检查 `config/fake-user.json` 与密钥。失败会停住，不会用模板顶替 |
| 被测 HTTP 4xx | 看该轮 trace，对照被测自己的接口 |
| 评审 HTTP 5xx | `POST /api/runs/{id}/judge` 只重试评审 |

## 九、红线

- 不替人纳入回归。评审分只用于排序，不是发版门禁。
- 不手写 `artifacts/snapshots/`。快照只来自人确认的跑局。
- 不为了跑通而假装被测有记忆或收件箱。
- 不用别人的 Key。
