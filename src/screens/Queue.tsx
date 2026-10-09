import type { Run } from "../../shared/schema";
import { constrainJudgeEvidence } from "../../shared/judge-evidence";
import {
  failureHint,
  isFailed,
  isRunning,
  needsHumanReview,
  stateLabel,
} from "../../shared/run-state";
import { Badge, Button, Empty, PageHeader, Pager, fmtDate, usePager } from "../ui";
export type RunFilter = "待审" | "运行中" | "未完成" | "已处理" | "全部";
export function RunStatus({ run }: { run: Run }) {
  return (
    <Badge
      tone={
        isRunning(run)
          ? "blue"
          : isFailed(run)
            ? "red"
            : run.status === "accepted"
              ? "green"
              : run.status === "unclear"
                ? "orange"
                : "neutral"
      }
    >
      {stateLabel(run)}
    </Badge>
  );
}
export function runSignal(run: Run) {
  const latest = run.evaluations?.at(-1);
  if (isRunning(run))
    return run.stage === "judging"
      ? "对话已完成，正在自动评审"
      : `仿真对话 ${run.eventDone ?? 0}/${run.eventTotal ?? "—"} 拍`;
  if (isFailed(run)) {
    return failureHint(latest?.error ?? run.error).hint;
  }
  if (latest?.result)
    return constrainJudgeEvidence(latest.result, run).result.summary;
  const low = run.scores
    .filter((s) => s.value != null)
    .sort((a, b) => (a.value ?? 9) - (b.value ?? 9))[0];
  return low
    ? `${low.dim} ${low.value?.toFixed(1)} · 第 1 代规则评分（历史）`
    : "暂无评审结果";
}
export function RunTable({
  runs,
  onOpen,
  empty = "当前筛选下没有运行记录。",
}: {
  runs: Run[];
  onOpen: (id: string) => void;
  empty?: string;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>事件剧本 / 人群</th>
            <th>被测</th>
            <th>评审线索</th>
            <th>状态</th>
            <th>发起人</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <button className="link-button" onClick={() => onOpen(r.id)}>
                  {r.scriptName}
                </button>
                <small>
                  {r.personName} · {r.personVersion} / {r.scriptVersion}
                </small>
              </td>
              <td>{r.sutName ?? "未记录"}</td>
              <td className="signal-cell">
                <span className="signal-summary" title={runSignal(r)}>
                  {runSignal(r)}
                </span>
              </td>
              <td>
                <RunStatus run={r} />
                {isRunning(r) && r.status !== "pending" && (
                  <small>保留原人工判定</small>
                )}
              </td>
              <td className="nowrap">
                {r.createdBy?.name ?? (
                  <span className="muted" title="登录之前的记录">
                    未记录（历史）
                  </span>
                )}
                {r.createdBy?.keyName && <small>{r.createdBy.keyName}</small>}
              </td>
              <td className="nowrap muted">{fmtDate(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!runs.length && <Empty>{empty}</Empty>}
    </div>
  );
}
export default function Queue({
  items,
  onOpen,
  onLaunch,
  filter,
  onFilter,
  search,
  onSearch,
  onRefresh,
}: {
  items: Run[];
  onOpen: (id: string) => void;
  onLaunch: () => void;
  filter: RunFilter;
  onFilter: (v: RunFilter) => void;
  search: string;
  onSearch: (q: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const hunts = items.filter((r) => r.mode === "hunt");
  const match = (r: Run, f: RunFilter) =>
    f === "全部" ||
    (f === "运行中" && isRunning(r)) ||
    (f === "未完成" && isFailed(r)) ||
    (f === "待审" && needsHumanReview(r)) ||
    (f === "已处理" && r.status !== "pending");
  const filtered = hunts.filter(
    (r) =>
      match(r, filter) &&
      `${r.personName} ${r.scriptName} ${r.sutName ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  // 换筛选条件或换关键词就回第一页；运行中的局在轮询里进出列表也不会把人顶走。
  const pager = usePager(filtered, { pageSize: 20, resetKey: `${filter}|${search}` });
  return (
    <div className="page">
      <PageHeader
        title="探索"
        subtitle="换人、换事，观察相处表现。每一局都留下输入、对话与评审依据。"
        action={
          <>
            <Button quiet onClick={() => void onRefresh()}>
              刷新
            </Button>
            <Button primary onClick={onLaunch}>
              ＋ 新建探索
            </Button>
          </>
        }
      />
      <div className="toolbar">
        <div className="tabs">
          {(["待审", "运行中", "未完成", "已处理", "全部"] as RunFilter[]).map(
            (f) => (
              <button
                className={`tab ${filter === f ? "active" : ""}`}
                key={f}
                onClick={() => onFilter(f)}
              >
                {f} <small>{hunts.filter((r) => match(r, f)).length}</small>
              </button>
            ),
          )}
        </div>
        <input
          className="search"
          type="search"
          aria-label="筛选探索记录"
          placeholder="筛选人群、剧本或被测"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>
      <RunTable runs={pager.pageItems} onOpen={onOpen} />
      {filtered.length > 0 && (
        <Pager
          page={pager.page}
          pageCount={pager.pageCount}
          pageSize={pager.pageSize}
          total={filtered.length}
          onPage={pager.setPage}
          onPageSize={pager.setPageSize}
          unit="局"
        />
      )}
      <p className="footnote">
        按运行时间倒序排列，每页默认 20 条。机器意见供人核对；无法判定的记录保留，可回来补证。历史数据未记录的字段不回填。
      </p>
    </div>
  );
}
