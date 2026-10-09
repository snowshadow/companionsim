import { useEffect, useState } from "react";
import type { Person, Script } from "../../shared/schema";
import { Button, Modal } from "../ui";
import { getMeta } from "../api";
export const AUTHOR_SKILL_ID = "companionsim-author";
export const AUTHOR_SKILL_NAME = "仿真编排";
export default function AuthorSkillCard({
  kind,
  person,
  script,
  onRefresh,
  action = "create",
}: {
  kind: "person" | "script" | "both";
  person?: Person | null;
  script?: Script | null;
  onRefresh?: () => Promise<void>;
  action?: "create" | "revise";
}) {
  const [open, setOpen] = useState(false),
    [intent, setIntent] = useState(""),
    [message, setMessage] = useState(""),
    [refreshing, setRefreshing] = useState(false),
    [repoRoot, setRepoRoot] = useState("");
  // 项目路径从服务端取，不在源码里写死某台机器的绝对路径。
  useEffect(() => {
    getMeta()
      .then((meta) => setRepoRoot(meta.repoRoot))
      .catch(() => setRepoRoot(""));
  }, []);
  const label =
    kind === "person" ? "人群" : kind === "script" ? "剧本" : "人群或剧本";
  const context = [
    `使用 ${AUTHOR_SKILL_ID}（${AUTHOR_SKILL_NAME}）处理以下意图。`,
    repoRoot ? `项目：${repoRoot}` : "项目：本仓库（CompanionSim / sim-eval-ui）",
    `请先读 docs/agent-spec.md、docs/flows.md 及现有人群/剧本。`,
    person
      ? `当前人群：${person.name} (${person.id}@${person.version})；${person.summary}`
      : "",
    script ? `当前剧本：${script.name} (${script.id}@${script.version})` : "",
    `任务：${action === "revise" ? "改写当前" + label + "并提交新版本" : "新增" + label}。`,
    intent.trim()
      ? `我的意图：${intent.trim()}`
      : "请先与我确认想观察的相处差异，再编排。",
    "复用已有剧本与人群；提交平台校验。通过后返回产物 id/version、预期差异与路径；不得替人纳入回归。",
  ]
    .filter(Boolean)
    .join("\n");
  async function copy() {
    try {
      await navigator.clipboard.writeText(context);
      setMessage("已复制，去 Cursor 执行编排后，回来刷新产物。");
    } catch {
      setMessage("复制未成功，请选中下方交接文本复制。");
    }
  }
  async function refresh() {
    setRefreshing(true);
    try {
      await onRefresh?.();
      setMessage("已刷新。关闭后查看最新产物与校验结果。");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <>
      <Button
        quiet
        onClick={() => {
          setOpen(true);
          setMessage("");
        }}
      >
        {action === "revise" ? "用 Agent 改写" : "用 Agent 新增"}
        {label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={action === "revise" ? `改写${label}` : `新增${label}`}
        subtitle="保留当前上下文，交给本地 agent 编排。"
      >
        <label className="field-label" htmlFor="author-intent">
          想观察什么相处差异
        </label>
        <textarea
          id="author-intent"
          className="text-area"
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          placeholder="例如：保留这份隔夜剧本，换成不愿重复解释偏好的人。"
        />
        <details className="compact-details">
          <summary>查看完整交接内容</summary>
          <pre className="json-view">{context}</pre>
        </details>
        <p className="help-box">
          编排后的产物经过平台校验再进入列表。回来刷新，查看新增版本；正在准备的探索选择会保留。
          <br />
          你的 agent 还没装这份 Skill？去「我的」页下载 Skill 包，或直接在{" "}
          <a href="/api/skills.zip">这里下载</a>。
        </p>
        {message && (
          <p role="status" className="footnote">
            {message}
          </p>
        )}
        <div className="modal-actions">
          {onRefresh && (
            <Button disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? "刷新中…" : "回来后刷新产物"}
            </Button>
          )}
          <Button primary onClick={() => void copy()}>
            复制编排需求
          </Button>
        </div>
      </Modal>
    </>
  );
}
