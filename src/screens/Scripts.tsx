import { useEffect, useState } from "react";
import { ACTION_LABEL, FAMILY_LABEL } from "../../shared/actions";
import type { ArtifactIssue, Script, ScriptView } from "../../shared/schema";
import { Badge, Button, Empty, fmtDate, Issues, PageHeader } from "../ui";
import AuthorSkillCard from "./AuthorSkillCard";
export function ScriptDetail({ script }: { script: Script }) {
  return (
    <>
      <div className="section-heading">
        <h2>{script.name}</h2>
        <Badge>{script.version}</Badge>
      </div>
      <Badge>{FAMILY_LABEL[script.family]}</Badge>
      <ol className="event-list">
        {script.events.map((e) => (
          <li key={e.id}>
            <time>{e.clock}</time>
            <div>
              <strong>{ACTION_LABEL[e.kind]}</strong>
              {e.intent && <p>{e.intent}</p>}
              {e.tone && <p>语气：{e.tone}</p>}
              {e.constraints?.length ? <p>{e.constraints.join("；")}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
export default function Scripts({
  scripts,
  issues,
  onUse,
  onRefresh,
  focusKey,
}: {
  focusKey?: string;
  scripts: ScriptView[];
  issues: ArtifactIssue[];
  onUse: (script: ScriptView) => void;
  onRefresh: () => Promise<void>;
}) {
  const [key, setKey] = useState(focusKey ?? ""),
    [search, setSearch] = useState("");
  const filtered = scripts.filter((s) =>
    `${s.name} ${FAMILY_LABEL[s.family]}`.includes(search),
  );
  // 选中项从**筛选后**的列表里取：搜不到东西时右侧不能再摆着上一个剧本
  const selected =
    filtered.find((s) => `${s.id}@${s.version}` === key) ?? filtered[0];
  useEffect(() => {
    if (focusKey) setKey(focusKey);
  }, [focusKey]);
  return (
    <div className="page">
      <PageHeader
        title="剧本"
        subtitle="按时间与事件浏览，选人即可复用。"
        action={
          <>
            <Button quiet onClick={() => void onRefresh()}>
              刷新产物
            </Button>
            <AuthorSkillCard kind="script" onRefresh={onRefresh} />
          </>
        }
      />
      <Issues items={issues.filter((i) => i.path.includes("scripts"))} />
      <div className="toolbar">
        <input
          className="search"
          type="search"
          aria-label="筛选剧本"
          placeholder="筛选剧本或观察目标"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="sort-caption">{filtered.length} 个剧本版本</span>
      </div>
      <div className="resource-layout">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>剧本</th>
                <th>观察目标 / 时间</th>
                <th>版本</th>
                <th>提交人</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr
                  key={`${s.id}@${s.version}`}
                  className={selected === s ? "row-selected" : ""}
                  onClick={() => setKey(`${s.id}@${s.version}`)}
                >
                  <td>
                    <button
                      className="link-button"
                      onClick={() => setKey(`${s.id}@${s.version}`)}
                    >
                      {s.name}
                    </button>
                    <small>{s.events.length} 个事件</small>
                  </td>
                  <td>
                    {FAMILY_LABEL[s.family]}
                    <small>{s.span}</small>
                  </td>
                  <td>
                    <Badge>{s.version}</Badge>
                  </td>
                  <td className="nowrap">
                    {s.createdBy?.name ?? <span className="muted">未记录（历史）</span>}
                    {s.createdAt && (
                      <small className="muted">{fmtDate(s.createdAt)}</small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && <Empty>没有匹配的剧本。</Empty>}
        </div>
        {selected && filtered.length > 0 && (
          <aside className="panel resource-details">
            <ScriptDetail script={selected} />
            <div className="author-actions">
              <Button primary onClick={() => onUse(selected)}>
                选人探索
              </Button>
              <AuthorSkillCard
                kind="script"
                action="revise"
                script={selected}
                onRefresh={onRefresh}
              />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
