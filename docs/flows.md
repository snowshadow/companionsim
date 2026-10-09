# CompanionSim · 工作流程

下列图描述当前工作流程。编排 Agent 生成材料，平台校验并运行，独立模型评审提供带证据的意见，人决定是否纳入回归。
平台要登录：人用用户名和密码，本地 agent 用 Key；每一步都记操作人，开跑前按当日 token 额度预估拦截
（见 [账号与权限](auth-and-roles.md)）。

术语：

- **探索**：现生成用户台词，搜未知失败，结果是候选。
- **待审**：这些候选构成的队列，等人判定。
- **纳入回归**：人确认会破信任，冻结台词。
- **回归**：以后用冻结台词原样再跑，对比被测版本。

## 总览：谁写、谁跑、谁判

```mermaid
flowchart TB
  H["人：登录 · 说意图 · 判定候选"] --> A["编排 Agent（带 Key）"]
  A -->|"人群 / 剧本 JSON"| V["平台校验（记提交人）"]
  V -->|打回| A
  V -->|通过| R["运行时（先过额度预估）"]
  R --> J["自动评审 · 仍在运行中"]
  J -->|"探索"| Q["待审"]
  J -->|"失败"| E["未完成 · 只重试评审"]
  E --> J
  Q -->|"纳入回归"| S["冻结快照"]
  S --> P["回归"]
  J -->|"回归"| P
  P --> H
```

人不必配置模板树。Agent 写不出规范外的能力。没有快照的剧本不能拿来对比版本。

---

## 1. 人群：从一句话到可复用的一类人

```mermaid
sequenceDiagram
  actor 人
  participant Agent as 编排 Agent
  participant Spec as 能力规范
  participant Store as 产物库

  人->>Agent: 要一个 25 岁单身、喜欢动漫的年轻女性，拿去打隔夜记忆
  Agent->>Spec: 读画像要求与剧本优先
  Agent->>Store: 看已有人群，避免重复
  Agent->>Agent: 起草画像 + 1～3 条相处说法 + expectedDiff
  Agent->>Spec: 提交人群 JSON

  alt 缺预期差异、或与已有人无差别、或使用未登记能力
    Spec-->>Agent: 打回
    Agent->>Agent: 修改后再提交
  else 通过
    Spec->>Store: 写入新 version，旧版保留
    Store-->>人: 可与任意剧本组合；尚未绑定台词
  end
```

要点：

- 人群先是能认出来的一类人，再写 1～3 条相处说法。通道动作在剧本里。
- `expectedDiff` 是准入条件，不是文案装饰。必须能点名哪一次 `speak` 会变。
- 改画像或行为必须新 version。回归仍引用旧 version。
- 作息差、连续不回不要写成一类人；去改剧本的 `silence` / `leave`。

---

## 2. 剧本：从一句话到事件序列

```mermaid
sequenceDiagram
  actor 人
  participant Agent as 编排 Agent
  participant Spec as 能力规范
  participant Store as 产物库

  人->>Agent: 做短期记忆：先把材料与猫名说一遍，晚点用简称回指
  Agent->>Spec: 读动作表与时间模型
  Agent->>Agent: 写成 speak / silence / leave；语气写在 speak 的约束里
  Agent->>Spec: 提交剧本 JSON

  alt kind 不在动作表、或把回指写成「你还记得吗」
    Spec-->>Agent: 打回
    Agent->>Agent: 改事件，不改平台能力
  else 通过
    Spec->>Store: 写入剧本 version（无冻结台词）
    Store-->>人: 默认可探索；不可回归对比
  end
```

要点：

- 事件是通道拍。台词属于跑局；情绪和情节属于 `speak` 的提示词约束。
- 本版只有 `speak` / `silence` / `leave` 三个动作。`jump` 已移除（假时钟没接上），
  用「下一句当第二天」也过不了校验。
- `leave` 结束会话；`silence` 人还在。本版只做一次连续时间的对话：
  跨日记忆、隔夜边界这两类考点要等假时钟接上产品。

探索时台词怎么来（剧本本身不负责写对白）：

```mermaid
sequenceDiagram
  actor 人
  participant Run as 运行时
  participant Fake as 仿真 agent
  participant SUT as 被测大脑
  participant Queue as 待审

  人->>Run: 探索（人群 × 剧本 × 被测）
  loop 每个事件
    Note over Run,SUT: 剧本 clock 只是会话内先后标注，不注入被测
    alt kind = speak
      Run->>Fake: 按人群画像 + behaviors + intent/tone/constraints 生成一句
      Fake->>SUT: 用户句
    else kind = silence
      Run->>SUT: 本轮无用户句，会话仍在
    else kind = leave
      Run->>SUT: 结束本段会话
    end
    SUT-->>Run: 回复、记忆写入（收件箱本版无适配器）
  end
  Run->>Run: 自动 LLM 评审，保存配置、用量与证据引用
  Run->>Queue: 待审，尚未纳入回归
  Note over Queue: 现生成台词到此为止，还不是快照
```

---

## 3. 回归：只有纳入回归之后才能对比版本

```mermaid
sequenceDiagram
  actor 人
  participant Queue as 待审
  participant Snap as 快照库
  participant Run as 运行时
  participant SUT as 被测大脑

  人->>Queue: 打开一局探索记录
  人->>Queue: 纳入回归 / 驳回 / 无法判定

  alt 驳回或无法判定
    Queue-->>人: 不生成快照
  else 纳入回归
    Queue->>Snap: 冻结本局用户句 + 时钟 + 人群 version + 剧本 version
  end

  人->>Run: 回归（指定快照，可换被测模型）
  Run->>Snap: 读取冻结台词，禁止现生成
  loop 快照中每一句用户台词
    Run->>SUT: 拨到快照内的时钟
    Run->>SUT: 原样发送该句
    SUT-->>Run: 新回复与新 trace
  end
  Run->>Run: 自动 LLM 评审，仍属于运行中
  Run-->>人: 原局与本次逐事件对照、评审证据、人工查看说明
```

要点：

- 快照的唯一合法来源：人点「纳入回归」。Agent 不准手写快照。
- 回归绑死人群 version 与剧本 version。改人设不是同一实验。
- 对比的是被测大脑，不是仿真 agent 有没有换说法。
- 本版被测只接对话。假时钟已从动作表移除、收件箱无适配器，相关结论记「测不了」或「不适用」。

---

## 已确定的交互边界

1. 创建人群 / 剧本的主路径是「对人说一句 → Agent 出 JSON → 平台校验」，界面只浏览产物、不提供字段 IDE。
2. 没有 `expectedDiff` 的人群、使用未登记动作的剧本，一律不能跑。
3. 探索默认进待审；只有纳入回归才产生可回归快照。
4. 回归时仿真 agent 不得再生成台词。

回归与探索的差别也体现在成本上：回归不调仿真 agent，只付一次评审，所以同样剧本的预估是探索的零头。

自动评审、运行快照和逐轮时间的完整语义见 [运行记录与评审契约](run-evidence.md)。探索台词现在由仿真 agent 扮演人群生成（`llm-v1`），失败重试后退避，用完预算就停下；回归仍用冻结原句。契约见 [仿真 agent 生成](fake-user-llm.md)。
