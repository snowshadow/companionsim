import { useEffect, useState } from "react";
import type { CatalogResponse, QuotaEstimateResponse } from "../../shared/schema";
import { estimateQuota } from "../api";
import { Button, Issues, Modal } from "../ui";

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
import AuthorSkillCard from "./AuthorSkillCard";
import { PersonDetail } from "./People";
import { ScriptDetail } from "./Scripts";
export type LaunchDraft = {
  personKey: string;
  scriptKey: string;
  sutId: string;
};
export default function Launch({
  open,
  onClose,
  catalog,
  draft,
  onDraft,
  onStart,
  onRefresh,
  onSut,
}: {
  open: boolean;
  onClose: () => void;
  catalog: CatalogResponse;
  draft: LaunchDraft;
  onDraft: (draft: LaunchDraft) => void;
  onStart: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onSut: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [estimate, setEstimate] = useState<QuotaEstimateResponse | undefined>();
  const person = catalog.people.find(
      (p) => `${p.id}@${p.version}` === draft.personKey,
    ),
    script = catalog.scripts.find(
      (s) => `${s.id}@${s.version}` === draft.scriptKey,
    ),
    sut = catalog.suts.find((s) => s.id === draft.sutId);
  const personKey = draft.personKey;
  const scriptKey = draft.scriptKey;
  // 开跑前先报预估与今日余额：配额是「提前知道要烧多少」，不是跑完才发现。
  useEffect(() => {
    if (!open || !person || !script) {
      setEstimate(undefined);
      return;
    }
    let disposed = false;
    void estimateQuota({
      personId: person.id,
      personVersion: person.version,
      scriptId: script.id,
      scriptVersion: script.version,
    })
      .then((next) => {
        if (!disposed) setEstimate(next);
      })
      .catch(() => {
        // 预估失败不挡开跑，服务端仍会在真正开跑时再拦一次。
        if (!disposed) setEstimate(undefined);
      });
    return () => {
      disposed = true;
    };
  }, [open, personKey, scriptKey]);

  async function start() {
    setBusy(true);
    setError("");
    try {
      await onStart();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "启动失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="新建探索"
      subtitle="用同一份剧本，观察不同人会怎样相处。"
      open={open}
      onClose={onClose}
    >
      <label className="field-label" htmlFor="launch-sut">
        被测
      </label>
      <select
        className="field"
        id="launch-sut"
        value={draft.sutId}
        onChange={(e) => onDraft({ ...draft, sutId: e.target.value })}
      >
        <option value="">选择被测</option>
        {catalog.suts.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <button className="inline-link" onClick={onSut}>
        接入配置 / Agent Meta ↗
      </button>
      <label className="field-label" htmlFor="launch-script">
        事件剧本
      </label>
      <select
        className="field"
        id="launch-script"
        value={draft.scriptKey}
        onChange={(e) => onDraft({ ...draft, scriptKey: e.target.value })}
      >
        <option value="">选择剧本</option>
        {catalog.scripts.map((s) => (
          <option key={`${s.id}@${s.version}`} value={`${s.id}@${s.version}`}>
            {s.name} · {s.version}
          </option>
        ))}
      </select>
      {script && (
        <details className="compact-details">
          <summary>就地查看事件</summary>
          <div>
            <ScriptDetail script={script} />
          </div>
        </details>
      )}
      <label className="field-label" htmlFor="launch-person">
        人群
      </label>
      <select
        className="field"
        id="launch-person"
        value={draft.personKey}
        onChange={(e) => onDraft({ ...draft, personKey: e.target.value })}
      >
        <option value="">选择人群</option>
        {catalog.people.map((p) => (
          <option key={`${p.id}@${p.version}`} value={`${p.id}@${p.version}`}>
            {p.name} · {p.version} · {p.summary}
          </option>
        ))}
      </select>
      {person && (
        <details className="compact-details">
          <summary>就地查看相处差异</summary>
          <div>
            <PersonDetail person={person} />
          </div>
        </details>
      )}
      <div className="author-actions">
        <AuthorSkillCard
          kind="both"
          person={person}
          script={script}
          onRefresh={onRefresh}
        />
        <Button quiet onClick={() => void onRefresh()}>
          刷新产物
        </Button>
      </div>
      <Issues items={catalog.issues} />
      {sut && (
        <div className="help-box">
          {sut.transport === "fixture"
            ? "内置样例用于验证评测流程。"
            : "本次对话接入：" + sut.name + "。"}{" "}
          未接能力：
          {[
            !sut.caps.memory ? "记忆记录" : "",
            !sut.caps.inbox ? "主动收件箱" : "",
          ]
            .filter(Boolean)
            .join("、") || "无"}
          。<br />
          探索用户目前按规则模板生成；对话完成后自动评审，运行启动时保存本次配置。
        </div>
      )}
      {catalog.judge && !catalog.judge.configured && (
        <p className="error-banner">
          评审器尚未配置。请在 LLM-as-judge 页配置评审连接。
        </p>
      )}
      {estimate && (
        <div className="help-box quota-hint">
          这一局大约花掉 {tokens(estimate.estimatedTokens)} token；今天还剩{" "}
          {tokens(estimate.usage.remaining)}。跑完按实际用量记账。
          {!estimate.allowed && (
            <>
              <br />
              <strong>
                今天不够了（预估 {tokens(estimate.estimatedTokens)}，已用{" "}
                {tokens(estimate.usage.used)}，上限 {tokens(estimate.usage.limit)}）。
                换个小剧本、明天再跑，或者找管理员提额。
              </strong>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <span className="muted">后台运行，可继续发起下一局</span>
        <Button
          primary
          disabled={!person || !script || !sut || busy || estimate?.allowed === false}
          onClick={() => void start()}
        >
          {busy
            ? "正在启动…"
            : estimate?.allowed === false
              ? "已超今日额度"
              : "开始探索"}
        </Button>
      </div>
    </Modal>
  );
}
