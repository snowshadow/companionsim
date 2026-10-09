import { useEffect, useState } from "react";
import type {
  ArtifactIssue,
  Person,
  PersonView,
  ScriptView,
} from "../../shared/schema";
import {
  Badge,
  Button,
  Empty,
  fmtDate,
  Issues,
  KeyValues,
  PageHeader,
} from "../ui";
import AuthorSkillCard from "./AuthorSkillCard";
export function PersonDetail({ person }: { person: Person }) {
  return (
    <>
      <div className="section-heading">
        <h2>{person.name}</h2>
        <Badge>{person.version}</Badge>
      </div>
      <p>{person.summary}</p>
      <h3>相处差异</h3>
      <p>{person.expectedDiff}</p>
      {person.behaviors.map((b) => (
        <div key={b.name}>
          <h3>{b.name}</h3>
          <p>{b.instructions.join("；")}</p>
          <p className="muted small">
            模拟用户偏离判据：{b.violations.join("；")}
          </p>
        </div>
      ))}
      <details className="compact-details">
        <summary>完整画像与适用剧本</summary>
        <KeyValues
          items={[
            ["年龄 / 性别", `${person.age}岁 / ${person.gender}`],
            ["状态", person.relationship],
            ["性格", person.personality],
            ["职业", person.occupation],
            ["兴趣", person.interests.join("、")],
            ["差异适用剧本", person.expectedDiffScripts.join("、")],
          ]}
        />
      </details>
    </>
  );
}
export default function People({
  people,
  scripts,
  issues,
  onUse,
  onRefresh,
  focusKey,
}: {
  focusKey?: string;
  people: PersonView[];
  scripts: ScriptView[];
  issues: ArtifactIssue[];
  onUse: (person: Person) => void;
  onRefresh: () => Promise<void>;
}) {
  const [key, setKey] = useState(focusKey ?? ""),
    [search, setSearch] = useState("");
  useEffect(() => {
    if (focusKey) setKey(focusKey);
  }, [focusKey]);
  const filtered = people.filter((p) =>
    `${p.name} ${p.summary} ${p.expectedDiff}`.includes(search),
  );
  const selected =
    filtered.find((p) => `${p.id}@${p.version}` === key) ?? filtered[0];
  return (
    <div className="page">
      <PageHeader
        title="人群"
        subtitle="先认出是哪类人，再看换成这类人会怎样改变相处。"
        action={
          <>
            <Button quiet onClick={() => void onRefresh()}>
              刷新产物
            </Button>
            <AuthorSkillCard kind="person" onRefresh={onRefresh} />
          </>
        }
      />
      <Issues items={issues.filter((i) => i.path.includes("people"))} />
      <div className="toolbar">
        <input
          className="search"
          type="search"
          aria-label="筛选人群"
          placeholder="筛选画像与相处差异"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="sort-caption">{filtered.length} 个人群版本</span>
      </div>
      <div className="resource-layout">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>人群 / 画像</th>
                <th>相处差异</th>
                <th>版本</th>
                <th>提交人</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr
                  key={`${p.id}@${p.version}`}
                  className={selected === p ? "row-selected" : ""}
                  onClick={() => setKey(`${p.id}@${p.version}`)}
                >
                  <td>
                    <button
                      className="link-button"
                      onClick={() => setKey(`${p.id}@${p.version}`)}
                    >
                      {p.name}
                    </button>
                    <small>{p.summary}</small>
                  </td>
                  <td>{p.behaviors.map((b) => b.name).join("；")}</td>
                  <td>
                    <Badge>{p.version}</Badge>
                  </td>
                  <td className="nowrap">
                    {p.createdBy?.name ?? <span className="muted">未记录（历史）</span>}
                    {p.createdAt && (
                      <small className="muted">{fmtDate(p.createdAt)}</small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && (
            <Empty>没有匹配的人群。用 Agent 编排新的人群，回来后刷新。</Empty>
          )}
        </div>
        {selected && filtered.length > 0 && (
          <aside className="panel resource-details">
            <PersonDetail person={selected} />
            <div className="author-actions">
              <Button primary onClick={() => onUse(selected)}>
                用这类人探索
              </Button>
              <AuthorSkillCard
                kind="person"
                action="revise"
                person={selected}
                script={scripts.find((s) =>
                  selected.expectedDiffScripts.includes(s.id),
                )}
                onRefresh={onRefresh}
              />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
