import type { Run, RunPhase } from "./schema";

/**
 * 产物代际。历史运行文件不回写，所以这里从现有字段推导；
 * 新开局由 seedRun 写入 generation，后续以字段为准。
 *
 * 第 1 代 09-10：只有关键词 scores，没有 evaluations / userGenerator。
 * 第 2 代 09-11：template-v1 / frozen 台词来源 + LLM evaluations。
 * 第 3 代 09-18：llm-v1 台词生成，带 generatorSnapshot / generations。
 *
 * 界面上的兼容分支（历史规则分回退、快照“未记录”）就是靠这个区分边界，
 * 不能当成仍在生效的能力。
 */
export function runGeneration(run: Pick<Run, "generation" | "userGenerator" | "evaluations" | "generatorSnapshot" | "generations">): 1 | 2 | 3 {
  if (run.generation === 1 || run.generation === 2 || run.generation === 3)
    return run.generation;
  if (
    run.generatorSnapshot !== undefined ||
    run.generations !== undefined ||
    run.userGenerator === "llm-v1"
  )
    return 3;
  if (
    run.userGenerator === "template-v1" ||
    run.userGenerator === "frozen" ||
    (run.evaluations?.length ?? 0) > 0
  )
    return 2;
  return 1;
}

export function phaseOf(run: Pick<Run, "phase">): RunPhase {
  return run.phase === "running" || run.phase === "failed" ? run.phase : "done";
}

export function isRunning(run: Pick<Run, "phase">): boolean {
  return phaseOf(run) === "running";
}

export function isFailed(run: Pick<Run, "phase">): boolean {
  return phaseOf(run) === "failed";
}

export function canDecide(
  run: Pick<Run, "mode" | "phase" | "dialogueStatus">,
): boolean {
  return (
    !isRunning(run) &&
    run.mode === "hunt" &&
    (run.dialogueStatus === "done" ||
      (!run.dialogueStatus && phaseOf(run) === "done"))
  );
}

export function isReviewable(
  run: Pick<Run, "mode" | "status" | "phase" | "dialogueStatus">,
): boolean {
  return (
    canDecide(run) && (run.status === "pending" || run.status === "unclear")
  );
}

export function progressLabel(
  run: Pick<Run, "eventDone" | "eventTotal" | "phase" | "stage">,
): string {
  if (phaseOf(run) === "running") {
    if (run.stage === "judging") return "自动评审中";
    if (run.eventTotal && run.eventTotal > 0) {
      return `${run.eventDone ?? 0}/${run.eventTotal} 拍`;
    }
    return "正在对接被测";
  }
  if (phaseOf(run) === "failed")
    return run.stage === "judging" ? "评审失败" : "对话失败";
  return "已跑完";
}

export function stateLabel(
  run: Pick<Run, "mode" | "status" | "phase" | "stage" | "reviewedAt">,
): string {
  if (isRunning(run))
    return run.stage === "judging" ? "运行中 · 自动评审" : "运行中 · 仿真对话";
  if (isFailed(run))
    return run.stage === "judging" ? "未完成 · 评审失败" : "未完成 · 对话失败";
  if (run.mode === "replay") return run.reviewedAt ? "已查看" : "待查看";
  return {
    pending: "待审",
    accepted: "已纳入回归",
    rejected: "已驳回",
    unclear: "无法判定",
  }[run.status];
}

/**
 * 待审口径：跑完但还没有最终判定的局（含「无法判定」——它要回来补证）。
 * 侧栏角标与页内「待审」筛选**必须共用这一个**，否则两个数字会差一两个，
 * 人就不知道该信哪个（曾经就是这样：角标漏算 unclear 的局）。
 */
export function needsHumanReview(
  run: Pick<Run, "status" | "phase">,
): boolean {
  if (isRunning(run) || isFailed(run)) return false;
  return run.status === "pending" || run.status === "unclear";
}

/**
 * 把上游/内部的失败原因翻成一句人话，原文留在 raw 里给悬停看。
 * 被测与模型连接报的都是英文码或厂商措辞，直接铺在列表里没人看得懂下一步该做什么。
 */
export function failureHint(error?: string): { hint: string; raw?: string } {
  const text = (error ?? "").trim();
  if (text === "") return { hint: "本次未完成" };
  const rules: [RegExp, string][] = [
    [
      /conversation_not_current|historical and read-only/i,
      "同一账号的另一局抢走了可写会话。平台已按账号串行，若反复出现请报维护者",
    ],
    [
      /initialization_in_progress|another conversation is initializing/i,
      "被测在初始化另一个会话，稍等片刻重跑",
    ],
    [
      /SOULPALS_SESSION|未登录或会话已过期/i,
      "被测登录态过期：到「被测」页更新凭据",
    ],
    [
      /CHATBOT_API_KEY|Chatbot API Key 无效/i,
      "被测服务 API Key 失效：更新被测连接的凭据（CHATBOT_API_KEY）",
    ],
    [
      /仿真 agent 接口 HTTP 401|评审接口 HTTP 401/i,
      "仿真 agent / 评审的模型凭据失效：检查 OPENCODE_API_KEY 一类配置",
    ],
    [
      /仿真 agent 接口 HTTP 429|评审接口 HTTP 429/i,
      "模型接口限流（429）：稍后重跑",
    ],
    [
      /FAILED\s*·\s*Fault|Runtime response could not be confirmed|runtime_transport_uncertain/i,
      "被测运行时中断（服务端 Fault / 无法确认响应），通常是它那边的问题",
    ],
    [/被测 HTTP 5\d\d/i, "被测返回 5xx：它那边出错，稍后重跑或找被测维护者"],
    [/被测 HTTP 4\d\d/i, "被测拒绝了这个请求（鉴权或字段）：看这一局的请求 trace"],
    [/评审超时|无法连接评审接口/i, "评审不可达或超时：对话已保留，可以只重试评审"],
    [/额度不足/, "今日 token 额度不够：换小剧本、明天再跑，或找管理员提额"],
  ];
  for (const [pattern, hint] of rules) {
    if (pattern.test(text)) return { hint, raw: text };
  }
  return { hint: text, raw: undefined };
}
