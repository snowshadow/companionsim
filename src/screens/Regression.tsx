import { useState } from "react";
import type { Run, Snapshot, SutView } from "../../shared/schema";
import { Button, Empty, PageHeader, Pager, fmtDate, usePager } from "../ui";
import { RunTable } from "./Queue";
export default function Regression({
  runs,
  snapshots,
  suts,
  sutId,
  onSut,
  onStart,
  onOpen,
}: {
  runs: Run[];
  snapshots: Snapshot[];
  suts: SutView[];
  sutId: string;
  onSut: (id: string) => void;
  onStart: (snapshotId: string) => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const [tab, setTab] = useState("冻结用例"),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const replayRuns = runs.filter((r) => r.mode === "replay");
  // 两个列表各自翻页；换 tab 时按 tab 重置，避免翻到一半跳走。
  const runPager = usePager(replayRuns, { pageSize: 20, resetKey: tab });
  const snapshotPager = usePager(snapshots, { pageSize: 20, resetKey: tab });
  async function start(id: string) {
    setBusy(id);
    setError("");
    try {
      await onStart(id);
      setTab("运行记录");
    } catch (e) {
      setError(e instanceof Error ? e.message : "启动失败");
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="page">
      <PageHeader
        title="回归"
        subtitle="沿用冻结台词重新运行，保存新的被测快照，再与来源局对照。"
      />
      <div className="toolbar">
        <div className="tabs">
          {["冻结用例", "运行记录"].map((t) => (
            <button
              key={t}
              className={`tab ${t === tab ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t}{" "}
              <small>
                {t === "冻结用例"
                  ? snapshots.length
                  : runs.filter((r) => r.mode === "replay").length}
              </small>
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {tab === "运行记录" ? (
        <>
          <RunTable
            runs={runPager.pageItems}
            onOpen={onOpen}
            empty="还没有回归运行记录。从「冻结用例」发起一次。"
          />
          {replayRuns.length > 0 && (
            <Pager
              page={runPager.page}
              pageCount={runPager.pageCount}
              pageSize={runPager.pageSize}
              total={replayRuns.length}
              onPage={runPager.setPage}
              onPageSize={runPager.setPageSize}
              unit="局"
            />
          )}
        </>
      ) : (
        <>
          <div className="regression-select">
            <label className="small muted" htmlFor="replay-target">
              本次被测
            </label>
            <select
              id="replay-target"
              className="field"
              value={sutId}
              onChange={(e) => onSut(e.target.value)}
            >
              <option value="">请选择被测</option>
              {suts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <span className="small muted">
              固定用户原句；本次对话完成后自动评审。
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>冻结用例 / 人群</th>
                  <th>人的理由</th>
                  <th>最近回归</th>
                  <th>发起人</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {snapshotPager.pageItems.map((s) => {
                  const source = runs.find((r) => r.id === s.sourceRunId),
                    latest = runs.find(
                      (r) => r.mode === "replay" && r.snapshotId === s.id,
                    );
                  return (
                    <tr key={s.id}>
                      <td>
                        <button
                          className="link-button"
                          disabled={!source}
                          onClick={() => onOpen(s.sourceRunId)}
                        >
                          {source?.scriptName ??
                            s.scriptSnapshot?.name ??
                            s.scriptId}
                        </button>
                        <small>
                          {source?.personName ??
                            s.personSnapshot?.name ??
                            s.personId}{" "}
                          · {s.personVersion} / {s.scriptVersion}
                        </small>
                        <small>
                          {s.id} · {s.lines.length} 句冻结台词
                        </small>
                      </td>
                      <td>{source?.decisions?.at(-1)?.reason || "未记录"}</td>
                      <td>
                        {latest ? (
                          <button
                            className="inline-link"
                            onClick={() => onOpen(latest.id)}
                          >
                            {fmtDate(latest.createdAt)} ↗
                          </button>
                        ) : (
                          <span className="muted">尚未运行</span>
                        )}
                      </td>
                      <td className="nowrap">
                        {latest?.createdBy?.name ?? (
                          <span className="muted">未运行</span>
                        )}
                        {latest?.createdBy?.keyName && (
                          <small>{latest.createdBy.keyName}</small>
                        )}
                      </td>
                      <td>
                        <Button
                          disabled={!sutId || !!busy}
                          onClick={() => void start(s.id)}
                        >
                          {busy === s.id ? "正在启动…" : "运行回归"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!snapshots.length && (
              <Empty>没有冻结用例。探索后，由人决定是否纳入回归。</Empty>
            )}
          </div>
          {snapshots.length > 0 && (
            <Pager
              page={snapshotPager.page}
              pageCount={snapshotPager.pageCount}
              pageSize={snapshotPager.pageSize}
              total={snapshots.length}
              onPage={snapshotPager.setPage}
              onPageSize={snapshotPager.setPageSize}
              unit="个冻结用例"
            />
          )}
        </>
      )}
      <p className="footnote">
        运行完成不等于问题已修复。回归结果与人的备注独立保留，不重复纳入回归。
      </p>
    </div>
  );
}
