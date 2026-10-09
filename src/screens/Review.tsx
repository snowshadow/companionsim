import { useEffect, useRef, useState } from "react";
import { FAMILY_LABEL } from "../../shared/actions";
import { constrainJudgeEvidence } from "../../shared/judge-evidence";
import type {
  CatalogResponse,
  JudgeSettings,
  QueueStatus,
  RequestTrace,
  Run,
} from "../../shared/schema";
import {
  canDecide,
  isFailed,
  isRunning,
  runGeneration,
  stateLabel,
} from "../../shared/run-state";
import {
  Badge,
  Button,
  Empty,
  JsonView,
  KeyValues,
  Modal,
  PageHeader,
  duration,
  fmtDate,
} from "../ui";
import { PersonDetail } from "./People";
import { ScriptDetail } from "./Scripts";
import { SutMeta } from "./Agents";
import { RunStatus } from "./Queue";
import JudgeSettingsForm from "./JudgeSettingsForm";
const verdictLabel = {
  pass: "未见异常",
  concern: "值得核对",
  fail: "疑似失败",
  not_applicable: "不适用",
  untestable: "测不了",
};
function RequestDetail({ request }: { request: RequestTrace }) {
  return (
    <KeyValues
      items={[
        [
          "事件 / 请求尝试",
          `${request.eventId ?? "未记录"} / 第 ${request.attempt} 次`,
        ],
        ["仿真时间", request.simulationTime ?? "未记录"],
        ["真实发送时间", request.startedAt],
        ["首段正文", request.firstContentAt],
        ["完成 / 失败", request.completedAt ?? request.failedAt],
        [
          "首字 / 总响应",
          `${duration(request.ttftMs)} / ${duration(request.durationMs)}`,
        ],
        ["请求 ID", request.requestId],
        ["流结束原因", request.finishReason],
        [
          "响应状态",
          `${request.outcome}${request.httpStatus ? ` · HTTP ${request.httpStatus}` : ""}`,
        ],
        [
          "请求 / 返回模型",
          `${request.requestedModel ?? "未记录"} / ${request.returnedModel ?? "未提供"}`,
        ],
        [
          "来源",
          request.source === "fixture"
            ? "本地样例，不是网络延迟"
            : "平台观测的远端请求",
        ],
        [
          "远端版本",
          request.remote ? <JsonView value={request.remote} /> : "未提供",
        ],
        [
          "运行中版本变化",
          request.drift?.length ? request.drift.join("；") : "无已记录的变化",
        ],
        ["错误", request.error ?? "无已记录错误"],
      ]}
    />
  );
}
function Timing({ run }: { run: Run }) {
  const latest = run.evaluations?.at(-1);
  return (
    <>
      <h2>逐轮时间</h2>
      <p className="footnote">
        首字从请求发出到第一段非空正文；总响应截至流结束。保存的时间戳含时区。
      </p>
      <div className="table-wrap" style={{ marginTop: 13 }}>
        <table className="timing-table">
          <thead>
            <tr>
              <th>事件 / 仿真时间</th>
              <th>真实发送</th>
              <th>首字</th>
              <th>总响应</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {run.requests?.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.eventId ?? "未记录"}
                  <small>{r.simulationTime ?? "未记录"}</small>
                </td>
                <td>{fmtDate(r.startedAt, true)}</td>
                <td>{duration(r.ttftMs)}</td>
                <td>{duration(r.durationMs)}</td>
                <td>{r.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!run.requests?.length && <Empty>这局没有逐轮请求时间记录。</Empty>}
      </div>
      <KeyValues
        items={[
          ["运行创建", fmtDate(run.createdAt, true)],
          ["对话阶段耗时", duration(run.dialogueDurationMs)],
          ["当前评审耗时", duration(latest?.durationMs)],
          ["首次执行耗时", duration(run.durationMs)],
          ["对话完成", fmtDate(run.dialogueCompletedAt, true)],
          ["首次执行结束", fmtDate(run.completedAt, true)],
          ["当前评审结束", fmtDate(latest?.completedAt, true)],
        ]}
      />
      {run.requests?.map((r) => (
        <details className="compact-details" key={r.id}>
          <summary>
            {r.eventId ?? r.id} · 第 {r.attempt} 次请求的完整记录
          </summary>
          <RequestDetail request={r} />
        </details>
      ))}
      <p className="footnote">
        未采集不记为 0。首字与请求耗时不含用户生成和评审；平台观测的 API
        延迟不等于模型内部推理耗时。
      </p>
    </>
  );
}
function SnapshotView({
  run,
  tab,
  catalog,
}: {
  run: Run;
  tab: string;
  catalog: CatalogResponse;
}) {
  const person =
    run.personSnapshot ??
    catalog.people.find(
      (p) => p.id === run.personId && p.version === run.personVersion,
    );
  const script =
    run.scriptSnapshot ??
    catalog.scripts.find(
      (s) => s.id === run.scriptId && s.version === run.scriptVersion,
    );
  if (tab === "人群")
    return person ? (
      <>
        {!run.personSnapshot && (
          <p className="help-box">
            按本局引用版本读取的产物文件；当时未内嵌留档。
          </p>
        )}
        <PersonDetail person={person} />
      </>
    ) : (
      <>
        <KeyValues
          items={[
            ["人群", run.personName],
            ["引用版本", `${run.personId}@${run.personVersion}`],
          ]}
        />
        <p className="help-box">
          本局未保存内容快照，也找不到精确引用版本的文件。
        </p>
      </>
    );
  if (tab === "剧本")
    return script ? (
      <>
        {!run.scriptSnapshot && (
          <p className="help-box">
            按本局引用版本读取的产物文件；当时未内嵌留档。
          </p>
        )}
        <ScriptDetail script={script} />
      </>
    ) : (
      <>
        <KeyValues
          items={[
            ["剧本", run.scriptName],
            ["引用版本", `${run.scriptId}@${run.scriptVersion}`],
          ]}
        />
        <p className="help-box">
          本局未保存内容快照，也找不到精确引用版本的文件。
        </p>
      </>
    );
  const s = run.sutSnapshot;
  return s ? (
    <>
      <div className="help-box">
        运行时保存 · {fmtDate(s.capturedAt, true)}
        <br />
        本地配置快照不等于冻结远端部署。
      </div>
      <KeyValues
        items={[
          ["被测 / 地址", `${s.name}\n${s.url ?? "本地样例"}`],
          [
            "协议 / 适配器",
            `${s.transport} · ${s.body ?? "—"} → ${s.parse ?? "—"} / ${s.adapterVersion}`,
          ],
          ["配置指纹", s.configHash],
          ["Prompt 指纹", s.promptHash],
          [
            "Temperature / Top P",
            `${s.temperature ?? "未设置"} / ${s.topP ?? "未设置"}`,
          ],
        ]}
      />
      <SutMeta sut={s} historical />
      <h3 style={{ marginTop: 18 }}>远端证据 · 服务返回</h3>
      {s.remoteMetadata ? (
        <JsonView value={s.remoteMetadata} />
      ) : (
        <p className="footnote">
          远端部署版本未知：服务未提供可核实的版本元信息。
        </p>
      )}
      {s.metaError && <p className="error-banner">Meta 采集：{s.metaError}</p>}
    </>
  ) : (
    <>
      <KeyValues
        items={[
          ["被测名称", run.sutName],
          ["当时接入", run.sutTransport],
          ["完整配置快照", "未记录"],
          ["模型 / Prompt / 远端版本", "未记录"],
        ]}
      />
      <p className="help-box">
        此历史记录仅保留名称与部分能力。当前接入配置不用于补写过去的数据。
      </p>
    </>
  );
}
export default function Review({
  run,
  sourceRun,
  catalog,
  onBack,
  onOpen,
  onDecide,
  onRetry,
  onReviewed,
  busy,
}: {
  run: Run;
  sourceRun?: Run;
  catalog: CatalogResponse;
  onBack: () => void;
  onOpen: (id: string) => void;
  onDecide: (
    status: Exclude<QueueStatus, "pending">,
    reason: string,
    evidence: string[],
    evaluation?: string,
  ) => Promise<void>;
  onRetry: (settings?: JudgeSettings) => Promise<void>;
  onReviewed: (note: string) => Promise<void>;
  busy: boolean;
}) {
  const [tab, setTab] = useState("对话"),
    [snapshotTab, setSnapshotTab] = useState("被测"),
    [snapshotRun, setSnapshotRun] = useState<Run | null>(null),
    [attemptId, setAttemptId] = useState(""),
    [judgeConfig, setJudgeConfig] = useState(false),
    [rejudge, setRejudge] = useState(false),
    [reason, setReason] = useState(
      run.decisions?.at(-1)?.reason ?? run.reviewNote ?? "",
    ),
    [evidence, setEvidence] = useState<string[]>(
      run.decisions?.at(-1)?.evidenceTurnIds ?? [],
    ),
    [target, setTarget] = useState(""),
    [error, setError] = useState("");
  const panel = useRef<HTMLElement>(null);
  const attempts = run.evaluations ?? [];
  const targetFamily =
    run.scriptSnapshot?.family ??
    catalog.scripts.find(
      (s) => s.id === run.scriptId && s.version === run.scriptVersion,
    )?.family;
  const targetDimension = targetFamily ? FAMILY_LABEL[targetFamily] : undefined;
  const selectedAttempt =
    attempts.find((a) => a.id === attemptId) ?? attempts.at(-1);
  const constrained = selectedAttempt?.result
    ? constrainJudgeEvidence(selectedAttempt.result, run)
    : undefined;
  const attempt = selectedAttempt
    ? {
        ...selectedAttempt,
        result: constrained?.result,
        rawResult: selectedAttempt.rawResult ?? selectedAttempt.result,
        evidenceConstraints: [
          ...new Set([
            ...(selectedAttempt.evidenceConstraints ?? []),
            ...(constrained?.constraints ?? []),
          ]),
        ],
      }
    : undefined;
  const running = isRunning(run);
  const eligible =
    canDecide(run) && (run.status === "pending" || run.status === "unclear");
  useEffect(() => {
    if (!target) return;
    const node = panel.current?.querySelector<HTMLElement>(
      `[data-turn-id="${CSS.escape(target)}"]`,
    );
    if (node) {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.focus({ preventScroll: true });
    }
    setTarget("");
  }, [tab, target]);
  async function safely(action: () => Promise<void>) {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    }
  }
  function locate(id: string) {
    setTab("对话");
    setTarget(id);
  }
  function cite(id: string) {
    setEvidence((e) =>
      e.includes(id) ? e.filter((i) => i !== id) : [...e, id],
    );
  }
  function evidenceLinks(ids: string[]) {
    return ids.map((id) => {
      const turn = run.turns.find((t) => t.id === id);
      return turn ? (
        <button key={id} className="evidence-button" onClick={() => locate(id)}>
          {turn.eventId ?? id} ·「{turn.text.slice(0, 100)}
          {turn.text.length > 100 ? "…" : ""}」 ↗
        </button>
      ) : (
        <p key={id} className="footnote">
          引用 {id}：原句未记录
        </p>
      );
    });
  }
  const initialJudge: JudgeSettings | undefined = attempt?.config
    ? {
        connectionSutId: attempt.config.connectionSutId,
        model: attempt.config.model,
        temperature: attempt.config.temperature,
        rubricVersion: attempt.config.rubricVersion,
      }
    : catalog.judge?.settings;
  return (
    <div className="review-page">
      <div className="review-back">
        <Button quiet onClick={onBack}>
          ← 返回{run.mode === "hunt" ? "探索" : "回归"}列表
        </Button>
        <span className="elapsed">
          {run.id} · {fmtDate(run.createdAt)} · 发起人{" "}
          {run.createdBy?.name ?? "未记录（历史）"}
          {run.createdBy?.keyName ? `（key: ${run.createdBy.keyName}）` : ""}
          {run.tokenUsage
            ? ` · 本局用量 ${run.tokenUsage.totalTokens.toLocaleString("en-US")} token${
                run.tokenUsage.source === "estimated" ? "（估算）" : ""
              }`
            : ""}
        </span>
      </div>
      <PageHeader
        title={run.scriptName}
        subtitle={
          <>
            {run.personName} × {run.sutName ?? "被测未记录"}
            <div className="snapshot-strip">
              {["人群", "剧本", "被测"].map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setSnapshotTab(t);
                    setSnapshotRun(run);
                  }}
                >
                  {t}
                  {t === "被测"
                    ? "配置快照"
                    : ` · ${t === "人群" ? run.personVersion : run.scriptVersion}`}{" "}
                  ↗
                </button>
              ))}
            </div>
          </>
        }
        action={<RunStatus run={run} />}
      />
      <div className="review-grid">
        <section ref={panel} className="panel">
          <div className="tabs transcript-tabs">
            {[
              "对话",
              "逐轮时间",
              ...(run.mode === "replay" ? ["前后对照"] : []),
            ].map((t) => (
              <button
                key={t}
                className={`tab ${tab === t ? "active" : ""}`}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          {tab === "逐轮时间" ? (
            <Timing run={run} />
          ) : tab === "前后对照" ? (
            <>
              <h2>同一份用户台词，前后对照</h2>
              {sourceRun ? (
                <>
                  <p className="footnote">
                    来源 {sourceRun.id} / 本次 {run.id}
                    。被测回复分别保存，不能仅据机器评语断定修复。
                  </p>
                  <div className="section-heading" style={{ marginTop: 12 }}>
                    <Button quiet onClick={() => onOpen(sourceRun.id)}>
                      打开来源局 ↗
                    </Button>
                    <Button
                      quiet
                      onClick={() => {
                        setSnapshotTab("被测");
                        setSnapshotRun(sourceRun);
                      }}
                    >
                      来源被测快照 ↗
                    </Button>
                  </div>
                  {run.turns
                    .filter((t) => t.kind === "user")
                    .map((t) => {
                      const id = t.eventId ?? t.id.replace(/^user-/, "");
                      const src = sourceRun.turns.find(
                        (s) =>
                          s.kind === "agent" &&
                          (s.eventId === id || s.id === `agent-${id}`),
                      );
                      const now = run.turns.find(
                        (s) =>
                          s.kind === "agent" &&
                          (s.eventId === id || s.id === `agent-${id}`),
                      );
                      return (
                        <div className="turn" key={t.id}>
                          <div className="turn-header">
                            <strong>{id} · 用户原句</strong>
                          </div>
                          <p>{t.text}</p>
                          <div className="comparison" style={{ marginTop: 10 }}>
                            <div>
                              <strong>
                                来源 · {sourceRun.sutName ?? "未记录"}
                              </strong>
                              <p>{src?.text ?? "这轮回复未记录"}</p>
                            </div>
                            <div>
                              <strong>本次 · {run.sutName ?? "未记录"}</strong>
                              <p>{now?.text ?? "这轮回复未记录"}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                </>
              ) : (
                <Empty>
                  来源运行未找到。已冻结台词仍保留，不能虚构前后对照。
                </Empty>
              )}
            </>
          ) : (
            <>
              <div
                className="footnote"
                style={{ marginTop: 0, marginBottom: 12 }}
              >
                台词来源：
                {run.userGenerator === "template-v1"
                  ? "规则模板生成"
                  : run.userGenerator === "llm-v1"
                    ? `LLM 扮演人群${run.generatorSnapshot?.model ? ` · ${run.generatorSnapshot.model}` : ""}`
                    : run.userGenerator === "frozen" || run.mode === "replay"
                      ? "冻结用户原句"
                      : "历史记录未标注"}{" "}
                · 单场连续对话
              </div>
              {run.memoryDomain && (
                <div
                  className="footnote"
                  style={{ marginTop: 0, marginBottom: 12 }}
                >
                  记忆域 {run.memoryDomain}
                  {run.priorRunIds?.length
                    ? ` · 本域第 ${run.memorySequence} 局，之前同域已跑 ${run.priorRunIds.length} 局（${run.priorRunIds.join("、")}）：共享记忆，本局结果含累积影响。`
                    : " · 本局独立仿真身份，记忆干净。"}
                </div>
              )}
              {!run.turns.length ? (
                <Empty>
                  {running
                    ? "正在对接被测，产生的对话会显示在这里。"
                    : "本局没有对话记录。"}
                </Empty>
              ) : (
                run.turns.map((t) => {
                  if (!["user", "agent", "proactive"].includes(t.kind))
                    return (
                      <div className="system-turn" key={t.id}>
                        {t.text}
                      </div>
                    );
                  const request =
                    run.requests?.find((r) => r.id === t.requestTraceId) ||
                    (t.kind === "agent"
                      ? run.requests?.find(
                          (r) =>
                            r.eventId ===
                            (t.eventId ?? t.id.replace(/^agent-/, "")),
                        )
                      : undefined);
                  return (
                    <article
                      className={`turn ${t.kind}`}
                      key={t.id}
                      data-turn-id={t.id}
                      tabIndex={-1}
                    >
                      <div className="turn-header">
                        <strong>
                          {t.kind === "user"
                            ? run.personName
                            : t.kind === "proactive"
                              ? "主动收件箱"
                              : "被测"}{" "}
                          ·{" "}
                          {t.eventId ??
                            t.id.replace(/^(user|agent|proactive)-/, "")}
                        </strong>
                        <span>
                          {request && t.kind !== "user"
                            ? `首字 ${duration(request.ttftMs)} · 完成 ${duration(request.durationMs)}`
                            : t.recordedAt
                              ? fmtDate(t.recordedAt, true)
                              : "时间未记录"}
                        </span>
                      </div>
                      <p>{t.text}</p>
                      {eligible && (
                        <button
                          className="inline-link"
                          onClick={() => cite(t.id)}
                        >
                          {evidence.includes(t.id)
                            ? "✓ 已加入人工证据"
                            : "＋ 引用这句"}
                        </button>
                      )}
                      {request && (
                        <details className="compact-details">
                          <summary>请求与响应记录</summary>
                          <RequestDetail request={request} />
                        </details>
                      )}
                    </article>
                  );
                })
              )}
              {run.dialogueStatus === "failed" && (
                <p className="error-banner">
                  {run.error ?? "对话中断，已有内容保留。"}
                </p>
              )}
            </>
          )}
        </section>
        <aside className="panel judge-panel">
          <div className="judge-heading">
            <h2>
              {attempt
                ? "LLM-as-a-judge"
                : run.evaluationStatus
                  ? "自动评审"
                  : "规则评分"}
            </h2>
            <Button quiet onClick={() => setJudgeConfig(true)}>
              配置 ↗
            </Button>
          </div>
          {attempts.length > 1 && (
            <select
              className="field"
              aria-label="选择评审尝试"
              value={attempt?.id ?? ""}
              onChange={(e) => setAttemptId(e.target.value)}
            >
              {attempts.map((a) => (
                <option value={a.id} key={a.id}>
                  第 {a.number} 次 ·{" "}
                  {a.status === "done"
                    ? "完成"
                    : a.status === "failed"
                      ? "失败"
                      : "评审中"}
                </option>
              ))}
            </select>
          )}
          {attempt ? (
            <>
              <p className="footnote">
                第 {attempt.number} 次 ·{" "}
                {attempt.status === "running"
                  ? "自动评审中"
                  : attempt.status === "done"
                    ? `已完成 · ${duration(attempt.durationMs)}`
                    : "未完成"}
              </p>
              {attempt.error && <p className="error-banner">{attempt.error}</p>}
              {attempt.result ? (
                <>
                  <p className="small" style={{ marginTop: 10 }}>
                    {attempt.result.summary}
                  </p>
                  {attempt.evidenceConstraints.length > 0 && (
                    <div className="help-box" style={{ marginTop: 12 }}>
                      <strong>平台证据检查</strong>
                      <p>
                        有 {attempt.evidenceConstraints.length}{" "}
                        项模型评分因缺少证据未被接纳，原因见对应维度。
                      </p>
                      <details>
                        <summary>模型原始意见</summary>
                        <JsonView value={attempt.rawResult} />
                      </details>
                    </div>
                  )}
                  {attempt.result.dimensions
                    .filter((d) => d.verdict !== "not_applicable")
                    .sort(
                      (a, b) =>
                        Number(b.dim === targetDimension) -
                        Number(a.dim === targetDimension),
                    )
                    .map((d) => (
                      <div className="judge-item" key={d.dim}>
                        <header>
                          <strong>{d.dim}</strong>
                          <Badge
                            tone={
                              d.verdict === "pass"
                                ? "green"
                                : d.verdict === "fail"
                                  ? "orange"
                                  : "neutral"
                            }
                          >
                            {d.value == null
                              ? verdictLabel[d.verdict]
                              : `${d.value} / 5 · ${verdictLabel[d.verdict]}`}
                          </Badge>
                        </header>
                        <p>{d.reason}</p>
                        {evidenceLinks(d.evidenceTurnIds)}
                      </div>
                    ))}
                  <div className="judge-item">
                    <header>
                      <strong>模拟用户有效性</strong>
                      <Badge>
                        {
                          {
                            valid: "符合意图",
                            deviated: "偏离剧本",
                            untestable: "测不了",
                          }[attempt.result.simulator.verdict]
                        }
                      </Badge>
                    </header>
                    <p>{attempt.result.simulator.reason}</p>
                    {evidenceLinks(attempt.result.simulator.evidenceTurnIds)}
                  </div>
                  <details>
                    <summary>不适用的维度</summary>
                    {attempt.result.dimensions
                      .filter((d) => d.verdict === "not_applicable")
                      .map((d) => (
                        <p key={d.dim}>
                          {d.dim}：{d.reason}
                        </p>
                      ))}
                    <p className="footnote">
                      不适用＝本局未考；测不了＝缺少必要证据。
                    </p>
                  </details>
                </>
              ) : (
                <p className="small muted" style={{ marginTop: 14 }}>
                  {attempt.status === "running"
                    ? "对话已经保留，正在读取本局证据进行评审。"
                    : "对话与快照保留。可重试评审，也可直接读证据，注明机器评审缺失。"}
                </p>
              )}
            </>
          ) : run.evaluationStatus ? (
            <p className="small muted">
              {run.dialogueStatus === "running"
                ? "对话完成后自动评审。"
                : "本局未形成完整评审结果。"}
            </p>
          ) : (
            <>
              <p className="footnote">
                第 {runGeneration(run)} 代记录 · 只有历史规则评分，未调用 LLM 评审。
                规则只识别预设词语，不代表当前能力。
              </p>
              {run.scores.map((s) => (
                <div className="judge-item" key={s.dim}>
                  <header>
                    <strong>{s.dim}</strong>
                    <Badge>
                      {s.value == null
                        ? "未评分"
                        : `${s.value.toFixed(1)} · 规则分`}
                    </Badge>
                  </header>
                  <p>{s.reason}</p>
                </div>
              ))}
              <p className="footnote">
                旧规则只识别预设词语，结论需要核对原句。LLM
                模型、规则版本与评审时间未记录。
              </p>
            </>
          )}
          <details>
            <summary>事实核对 · 规则来源</summary>
            {run.facts.length ? (
              run.facts.map((f, i) => (
                <div className="judge-item" key={i}>
                  <strong>{f.label}</strong>
                  <p>
                    <Badge>
                      {
                        {
                          pass: "规则成立",
                          fail: "规则提示失败",
                          untestable: "测不了",
                          not_applicable: "不适用",
                        }[f.result]
                      }
                    </Badge>
                  </p>
                  <p>{f.note}</p>
                </div>
              ))
            ) : (
              <p>未记录</p>
            )}
          </details>
          <details>
            <summary>记忆与主动收件箱</summary>
            <h3>记忆记录</h3>
            {run.memories.length ? (
              run.memories.map((m, i) => <p key={i}>{m}</p>)
            ) : (
              <p>
                {run.sutCaps?.memory === false
                  ? "未接记忆接口"
                  : "无已记录内容"}
              </p>
            )}
            <h3 style={{ marginTop: 12 }}>主动收件箱</h3>
            {run.inbox.length ? (
              run.inbox.map((m, i) => <p key={i}>{m}</p>)
            ) : (
              <p>
                {run.sutCaps?.inbox === false
                  ? "未接主动收件箱"
                  : "无已记录内容"}
              </p>
            )}
          </details>
          {!running &&
            (run.dialogueStatus === "done" ||
              (!run.dialogueStatus && !isFailed(run))) && (
              <details open={run.evaluationStatus === "failed"}>
                <summary>评审尝试与重评</summary>
                {attempts.map((a) => (
                  <p key={a.id}>
                    第 {a.number} 次 · {a.status} · {fmtDate(a.startedAt)}{" "}
                    {duration(a.durationMs)}
                  </p>
                ))}
                <div className="author-actions">
                  <Button
                    disabled={busy}
                    onClick={() => void safely(() => onRetry())}
                  >
                    {run.evaluationStatus === "failed"
                      ? "重试评审"
                      : "重评同一记录"}
                  </Button>
                  <Button
                    quiet
                    disabled={busy}
                    onClick={() => setRejudge(true)}
                  >
                    调整评审配置
                  </Button>
                </div>
                <p className="footnote">
                  只重评已保存的记录，不重跑对话；保留原结果与人的判定。
                </p>
              </details>
            )}
        </aside>
      </div>
      <section className="panel human-footer">
        {running ? (
          <div className="section-heading" style={{ margin: 0 }}>
            <div>
              <h3>{stateLabel(run)}</h3>
              <p className="footnote" style={{ marginTop: 3 }}>
                可继续浏览或发起下一局，后台运行会保留。
              </p>
            </div>
            <Button onClick={onBack}>返回列表</Button>
          </div>
        ) : run.mode === "replay" ? (
          <>
            <h3>
              回归结果 · {run.reviewedAt ? "已查看" : "待查看"}
              {run.reviewedBy && (
                <small className="muted"> by {run.reviewedBy.name}</small>
              )}
            </h3>
            <input
              className="field decision-reason"
              aria-label="回归人工备注"
              placeholder="记录观察到的变化或还需核对的问题"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="decision-row">
              <span className="muted">
                本次记录与原局对照，不重复纳入回归。
              </span>
              <Button
                disabled={busy || run.dialogueStatus === "failed"}
                onClick={() => void safely(() => onReviewed(reason))}
              >
                {run.reviewedAt ? "保存备注" : "标记已查看"}
              </Button>
            </div>
          </>
        ) : eligible ? (
          <>
            <h3>
              人的判定{" "}
              {run.evaluationStatus === "failed" && (
                <Badge tone="orange">机器评审未完成</Badge>
              )}
            </h3>
            <input
              className="field decision-reason"
              aria-label="判定理由"
              placeholder="用一句话记录理由；证据不足时说明缺什么"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {evidence.length > 0 && (
              <div className="evidence-selected">
                {evidence.map((id) => (
                  <button
                    className="inline-link"
                    key={id}
                    onClick={() => cite(id)}
                  >
                    {id} ×
                  </button>
                ))}
              </div>
            )}
            <div className="decision-row">
              <span className="muted">
                可从对话中引用证据。机器意见只作参考。
              </span>
              {(
                [
                  ["unclear", "无法判定"],
                  ["rejected", "驳回"],
                  ["accepted", "纳入回归"],
                ] as const
              ).map(([status, label]) => (
                <Button
                  key={status}
                  disabled={busy}
                  onClick={() =>
                    void safely(() =>
                      onDecide(status, reason, evidence, attempt?.id),
                    )
                  }
                >
                  {label}
                </Button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="section-heading" style={{ margin: 0 }}>
              <div>
                <h3>
                  {isFailed(run)
                    ? "本局未完成"
                    : `人的判定 · ${stateLabel(run)}`}
                </h3>
                <p className="small muted" style={{ marginTop: 5 }}>
                  {run.decisions?.at(-1)?.reason || "判定理由未记录"}
                </p>
              </div>
              <Button onClick={onBack}>返回列表</Button>
            </div>
            {run.decisions?.at(-1) && (
              <div className="small muted" style={{ marginTop: 7 }}>
                <span>
                  {run.decisions.at(-1)?.decidedBy?.name ?? "未记录（历史）"} ·{" "}
                  {fmtDate(run.decisions.at(-1)?.decidedAt, true)}
                </span>
                {run.decisions.at(-1)?.evaluationAttemptId && (
                  <Button
                    quiet
                    onClick={() => {
                      setAttemptId(
                        run.decisions?.at(-1)?.evaluationAttemptId ?? "",
                      );
                      setJudgeConfig(true);
                    }}
                  >
                    所据评审配置 ↗
                  </Button>
                )}
                <div className="evidence-selected">
                  {run.decisions.at(-1)?.evidenceTurnIds.map((id) => (
                    <button
                      className="inline-link"
                      key={id}
                      onClick={() => locate(id)}
                    >
                      引用 {id} ↗
                    </button>
                  ))}
                </div>
              </div>
            )}
            {run.decisions && run.decisions.length > 1 && (
              <details className="compact-details">
                <summary>人工判定历史</summary>
                {run.decisions.map((d, i) => (
                  <p key={i}>
                    {fmtDate(d.decidedAt)} · {d.decidedBy?.name ?? "未记录"} ·{" "}
                    {d.status} · {d.reason} · 依据评审{" "}
                    {d.evaluationAttemptId ?? "未记录"}
                  </p>
                ))}
              </details>
            )}
          </>
        )}
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
      </section>
      <Modal
        open={!!snapshotRun}
        onClose={() => setSnapshotRun(null)}
        wide
        title={`${snapshotRun?.id ?? ""} · 运行快照`}
        subtitle="查看本局保存的内容，不自动切换为最新配置。"
      >
        <div className="tabs" style={{ marginBottom: 15 }}>
          {["人群", "剧本", "被测"].map((t) => (
            <button
              className={`tab ${snapshotTab === t ? "active" : ""}`}
              key={t}
              onClick={() => setSnapshotTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        {snapshotRun && (
          <SnapshotView run={snapshotRun} tab={snapshotTab} catalog={catalog} />
        )}
      </Modal>
      <Modal
        open={judgeConfig}
        onClose={() => setJudgeConfig(false)}
        wide
        title="本次评审配置"
        subtitle={attempt ? `第 ${attempt.number} 次评审` : "历史规则评分"}
      >
        {attempt ? (
          <>
            <KeyValues
              items={[
                ["模型", attempt.config?.model],
                ["Rubric", attempt.config?.rubricVersion],
                ["评分尺度", attempt.config?.scale],
                ["提示词版本", attempt.config?.promptVersion],
                ["提示词指纹", attempt.config?.promptHash],
                ["输入证据指纹", attempt.config?.inputHash],
                ["Temperature", attempt.config?.temperature],
                ["地址", attempt.config?.endpoint],
                ["开始", attempt.startedAt],
                ["结束", attempt.completedAt],
                ["耗时", duration(attempt.durationMs)],
                ["本次等待上限", duration(attempt.timeoutMs)],
                ["请求 ID", attempt.requestId],
                ["实际返回模型", attempt.returnedModel],
              ]}
            />
            <details className="compact-details">
              <summary>完整评审提示词</summary>
              <pre className="json-view">
                {attempt.config?.prompt ?? "未记录"}
              </pre>
            </details>
          </>
        ) : (
          <KeyValues
            items={[
              ["评审方式", "关键词规则"],
              ["LLM 模型", "未调用"],
              ["规则版本", "未记录"],
              ["开始 / 结束时间", "未记录"],
            ]}
          />
        )}
      </Modal>
      <Modal
        open={rejudge}
        onClose={() => setRejudge(false)}
        title="重新评审这份记录"
        subtitle="新配置形成新的评审尝试，不覆盖原结果。"
      >
        {rejudge && (
          <JudgeSettingsForm
            initial={initialJudge}
            suts={catalog.suts}
            onSave={async (settings) => {
              await onRetry(settings);
              setAttemptId("");
              setRejudge(false);
            }}
            label="开始重评"
          />
        )}
      </Modal>
    </div>
  );
}
