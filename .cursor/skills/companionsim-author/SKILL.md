---
name: companionsim-author
description: >-
  Authors CompanionSim personas and event scripts against the closed capability
  spec. Use when the user wants to design, add, revise, or batch-generate
  personas or scripts for CompanionSim.
---

# CompanionSim 编排（人群 / 剧本）

本 Skill 只编写能被平台校验的人群与事件剧本。

先完整读 [docs/agent-spec.md](../../../docs/agent-spec.md)。那是仓库内路径。Skill 装在别处时，先 `GET /api/catalog` 看已有产物与 `issues`，不要凭印象造字段。

写之前确认要加的东西不与已有产物重复：两类人的 `expectedDiff` 相同，或剧本只是换了名字，平台会拒绝。

## 何时用

- 用自然语言新增或修改一类人、一份剧本。
- 批量产出人群或场景。
- 不要做人机字段表单。

## 不变量

1. 只做一次连续时间的对话。通道动作只有 `speak` / `silence` / `leave`。`jump`、`dnd`、`busy`、`sad`、`ask-impossible`、`correct`、第二人、视觉、连续时钟、仿真用户工具调用，一律校验失败。
2. 剧本事件的 `clock`（HH:MM）只是会话内先后标注，不是被测读到的时间。时间只能向前。允许跨午夜（`23:55 → 00:03`），单拍跨度不得超过 12 小时。
3. 低落、纠正、做不到、口头别找我，都写成 `speak` 的 `intent` / `tone` / `constraints`。
4. `intent` 与 `constraints` 是给演员的行为准则，不是台词。
5. 失败家族只有四个：`short-term-memory`、`taboo-topic`、`hallucination`、`over-promise`。每份剧本声明打哪一类。

### 自然表达

真实的人不会向对方宣告自己的需求。不准出现：

- 预告需求：「你别给我建议」「我不想聊这个」「先别问」
- 解释自己：「我只是想找个人说说话」「我这是在回避」
- 报菜名式地罗列信息

用语气、话题、答多长、要不要转开来体现。不想接，用 `silence`（人还在）或 `leave`（离开），而不是让用户说出口。

反例：「今天心情不好，先别给我建议。」
正例：`intent: 低落开场，只想有人听着`，`tone: 短、低落`，`constraints: 不给对方派活、不要方案`。

## 人群（`artifacts/people/{id}@{version}.json`）

```json
{
  "id": "p-linxia",
  "name": "林夏",
  "version": "v1",
  "immutable": true,
  "summary": "25岁年轻女性，单身，INTJ，喜欢动漫。",
  "age": 25,
  "gender": "女",
  "relationship": "单身",
  "personality": "INTJ",
  "occupation": "内容运营",
  "interests": ["动漫", "手办"],
  "expectedDiff": "跑细节回指时会把具体名字和时限说死；话少的人更含糊、更早放掉。",
  "expectedDiffScripts": ["s-short-memory"],
  "behaviors": [
    {
      "name": "把话说死",
      "instructions": ["偏好会说清楚、说满", "发现对方记松了就立刻改口"],
      "violations": ["只含糊说一句", "该纠正时不纠正"]
    }
  ]
}
```

- `summary` 必须能认出人群特征（含年龄）。`age` 18–80。`gender`、`interests`（1–4 项）必填。
- `behaviors` 1–3 条。`instructions` 进入仿真用户提示词；`violations` 用来判断仿真用户有没有演歪，不是被测失败。
- `expectedDiff` 必填，且要点名 `expectedDiffScripts` 里已存在或本次同时提交的剧本，说清换这类人后哪一拍会变。差异相同的两类人应合并。

## 剧本（`artifacts/scripts/{id}@{version}.json`）

一等公民是事件，不是台词。台词由仿真用户现场生成，或来自冻结快照。

```json
{
  "id": "s-short-memory",
  "name": "晚间长聊 · 细节回指",
  "version": "v1",
  "family": "short-term-memory",
  "events": [
    {
      "id": "e1",
      "clock": "21:10",
      "kind": "speak",
      "intent": "随口交代明天上午要交的材料，今晚得熬一会儿",
      "tone": "随意、有点累",
      "constraints": ["当成闲话讲，不强调让对方记住"]
    },
    {
      "id": "e2",
      "clock": "21:24",
      "kind": "speak",
      "intent": "提到猫在闹，顺口说出猫的名字",
      "tone": "被逗到、无奈",
      "constraints": ["猫的名字只出现这一次，后面只用「它」"]
    },
    { "id": "e3", "clock": "21:40", "kind": "silence" },
    { "id": "e4", "clock": "22:05", "kind": "speak", "intent": "聊一件完全无关的事", "tone": "放松" },
    {
      "id": "e5",
      "clock": "22:40",
      "kind": "speak",
      "intent": "用简称回指 e1 那份材料，语气像对方本来就该知道",
      "tone": "随口一叹",
      "constraints": ["不再解释那是什么材料", "不用「你还记得吗」"]
    },
    {
      "id": "e6",
      "clock": "23:05",
      "kind": "speak",
      "intent": "用代词回指 e2 那只猫",
      "tone": "又好笑又烦",
      "constraints": ["不再重复猫的名字"]
    },
    { "id": "e7", "clock": "23:30", "kind": "leave" }
  ]
}
```

- `speak` 必须有 `intent`。`tone` / `constraints` 只约束生成，不是新动作。
- 每份剧本 5～8 拍较好。
- 测「记不记得」靠回指（简称、代词），不靠「你还记得吗」。
- 测「禁忌」：不解释那件事，漏一句就转开。
- 测「幻觉」：把没发生过的事当成共同经历。
- 测「过度承诺」：顺口托付做不到的事。
- 改画像、行为或事件必须新 version。同路径不同内容会被拒绝。

## 批量生成

1. 先定覆盖轴（例如关系状态 × 性格 × 一种能改变 `speak` 的说话习惯）。每格一个。`expectedDiff` 从轴与目标剧本的交叉推出。
2. 写不出 `expectedDiff` 的格子不要产出，或与相邻格合并。
3. 产出后跑一遍。没有差异就合并或删。
4. 一次提交多个产物时，逐个说明打哪类失败、与已有产物差在哪。

## 提交

```bash
export SIM_EVAL_BASE=http://localhost:5260
curl -s -X POST $SIM_EVAL_BASE/api/artifacts \
  -H "Authorization: Bearer $SIM_EVAL_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"kind":"script","payload":{}}'
```

`POST /api/artifacts` 需要登录用户，或一把带 `author` 范围的 Key。Key 在「我的」页生成。先用 `GET /api/auth/me` 确认 Key 有效。

`kind` 取 `person` 或 `script`。校验失败就改产物，不要要求平台放宽动作表。

服务没跑时可以直接写 `artifacts/people/`、`artifacts/scripts/`，但提交人不会留下，校验会推迟到有人运行时。能走接口就走接口。

禁止手写 `artifacts/snapshots/`。快照只能由人点「纳入回归」生成。

回报：id、version、名称、校验结果。不要替人发起运行、评审或纳入回归。

## 交付前自检

- `GET /api/catalog`：产物在列表里，`issues` 里没有它。
- 同版本按相同内容再提交一次：应当通过。
- 报告写清 id、version、名称、失败家族、与哪个已有产物的差异、校验结果。

## 反例

- 只有策略、没有画像。
- 预期差异相同，却按年龄堆出很多类人。
- 把剧本写成逐句对白，并声称可以回归。
- 把「隔日再问」改成「下一句换话题」来绕过本版没有跨日的限制。
- 把低落写成 `kind: sad`。
- 台词里出现「你别给我建议」。
