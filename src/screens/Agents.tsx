import { useState } from "react";
import type {
  CreateSutRequest,
  JudgeConfigView,
  JudgeSettings,
  SutStyle,
  SutView,
  UserGeneratorConfigView,
  UserGeneratorSettings,
} from "../../shared/schema";
import { Badge, Button, Empty, KeyValues, Modal, PageHeader } from "../ui";
import JudgeSettingsForm from "./JudgeSettingsForm";
import FakeUserSettingsForm from "./FakeUserSettingsForm";
export function SutMeta({
  sut,
  historical = false,
}: {
  sut: SutView;
  historical?: boolean;
}) {
  return (
    <>
      <KeyValues
        items={[
          ["角色与用途", sut.description ?? sut.note],
          ["环境", sut.environment],
          ["Agent / Avatar ID", sut.avatarId],
          ["Runtime user ID", sut.runtimeUserId],
          ["请求模型", sut.model],
          [
            "已接通能力",
            [
              ["对话", sut.caps.chat],
              ["收件箱", sut.caps.inbox],
              ["记忆", sut.caps.memory],
            ]
              .map(
                ([name, enabled]) =>
                  `${name}：${enabled ? "已接通" : "未接入"}`,
              )
              .join("；"),
          ],
          [
            "登记 Agent 版本",
            <>
              {sut.agentVersion || "未提供"}
              <div className="meta-source">人工登记，未验证</div>
            </>,
          ],
          ["Prompt 版本", sut.promptVersion],
          ["工具能力", sut.tools],
          ["会话", sut.session],
          ["初始记忆", sut.initialMemory],
          ["Meta 地址", sut.metaUrl || "未配置（可选）"],
          [
            "凭据",
            sut.credentialRef ??
              (sut.credentialConfigured ? "已配置" : "未配置"),
          ],
        ]}
      />
      <details className="compact-details">
        <summary>
          {historical ? "当时调用的 System Prompt" : "当前调用的 System Prompt"}
        </summary>
        <pre className="json-view">{sut.systemPrompt || "未提供"}</pre>
      </details>
      <p className="footnote">
        {historical
          ? "以上为本局启动时保存的配置。声明的 Agent 版本来源为人工登记，未验证。"
          : "本页显示当前登记信息。服务返回的版本证据在每局快照及逐轮记录中查看。"}
      </p>
    </>
  );
}
export function SutEditor({
  sut,
  onSave,
  onClose,
}: {
  sut?: SutView;
  onSave: (input: CreateSutRequest) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<CreateSutRequest>({
      name: sut?.name ?? "",
      url: sut?.url ?? "",
      style:
        (sut?.transport === "soulpals" || sut?.transport === "soulpals-service")
          ? sut.transport
          : sut?.body ?? "openai-chat",
      api: sut?.api ?? "openai",
      model: sut?.model ?? "",
      parse: sut?.parse,
      environment: sut?.environment ?? "",
      avatarId: sut?.avatarId ?? "",
      runtimeUserId: sut?.runtimeUserId ?? "",
      description: sut?.description ?? sut?.note ?? "",
      agentVersion: sut?.agentVersion ?? "",
      metaUrl: sut?.metaUrl ?? "",
      systemPrompt: sut?.systemPrompt ?? "",
      promptVersion: sut?.promptVersion ?? "",
      temperature: sut?.temperature,
      topP: sut?.topP,
      session: sut?.session ?? "",
      initialMemory: sut?.initialMemory ?? "",
      tools: sut?.tools ?? "",
    }),
    [credential, setCredential] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const change = (key: keyof CreateSutRequest, value: unknown) =>
    setForm((f) => ({ ...f, [key]: value }));
  const field = (
    key: keyof CreateSutRequest,
    label: string,
    type = "text",
    wide = false,
  ) => (
    <div className={wide ? "span-two" : ""}>
      <label className="field-label" htmlFor={`sut-${key}`}>
        {label}
      </label>
      <input
        id={`sut-${key}`}
        className="field"
        type={type}
        step={type === "number" ? "0.1" : undefined}
        value={String(form[key] ?? "")}
        required={key === "name" || key === "url"}
        onChange={(e) =>
          change(
            key,
            type === "number"
              ? e.target.value === ""
                ? null
                : Number(e.target.value)
              : e.target.value,
          )
        }
      />
    </div>
  );
  async function save() {
    setBusy(true);
    setError("");
    try {
      await onSave({ ...form, url: form.style === "soulpals-service" ? "" : form.url,
        apiKey: form.style === "soulpals-service" ? undefined : credential || undefined });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="two-fields">
        {field("name", "名称")}
        {field("environment", "环境")}
        {field("description", "角色与用途", "text", true)}
        {form.style !== "soulpals-service" && field("url", "对话地址", "url", true)}
        <div>
          <label className="field-label" htmlFor="sut-style">
            对话协议
          </label>
          <select
            className="field"
            id="sut-style"
            value={form.style}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                style: e.target.value as SutStyle,
                ...((e.target.value === "soulpals" || e.target.value === "soulpals-service")
                  ? { parse: undefined }
                  : {
                      parse:
                        e.target.value === "openai-chat"
                          ? "openai-chat"
                          : "text",
                    }),
              }))
            }
          >
            <option value="openai-chat">SSE · Chat Completions</option>
            <option value="message">SSE · message / text</option>
            <option value="soulpals">Cookie + 轮询</option>
            <option value="soulpals-service">服务 API Key + 轮询</option>
          </select>
        </div>
        {form.style !== "soulpals" && form.style !== "soulpals-service" && (
          <div>
            <label className="field-label" htmlFor="sut-api">
              模型接口
            </label>
            <select
              className="field"
              id="sut-api"
              value={form.api ?? "openai"}
              onChange={(e) =>
                change("api", e.target.value === "anthropic" ? "anthropic" : "openai")
              }
            >
              <option value="openai">OpenAI Chat Completions</option>
              <option value="anthropic">Anthropic Messages</option>
            </select>
          </div>
        )}
        {field("model", "请求模型")}
        {(form.style !== "soulpals" && form.style !== "soulpals-service") && (
          <div>
            <label className="field-label" htmlFor="sut-parse">
              响应格式
            </label>
            <select
              id="sut-parse"
              className="field"
              value={
                form.parse ??
                (form.style === "openai-chat" ? "openai-chat" : "text")
              }
              onChange={(e) => change("parse", e.target.value)}
            >
              <option value="openai-chat">OpenAI delta</option>
              <option value="text">text</option>
              <option value="raw">raw</option>
            </select>
          </div>
        )}
        {(form.style === "soulpals" || form.style === "soulpals-service") && (
          <>
            {field("avatarId", "Avatar ID")}
            {field("runtimeUserId", "Runtime user ID（可选）")}
          </>
        )}
        {form.style === "soulpals-service" ? <p className="span-two">自动使用平台公共 Chatbot 连接和密钥，无需为角色重复配置。</p> : <div>
          <label className="field-label" htmlFor="sut-credential">
            API Key（只填密钥，无需 Bearer 前缀）
          </label>
          <input
            type="password"
            autoComplete="new-password"
            id="sut-credential"
            className="field"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder={
              sut?.credentialConfigured
                ? "留空保留现有凭据"
                : "粘贴 API Key，例如 sk-… 或 spk_…"
            }
          />
        </div>}
        {field("metaUrl", "Meta 地址（可选）", "url")}
        {field("agentVersion", "Agent 版本（人工声明）")}
        {field("promptVersion", "Prompt 版本")}
        <div className="span-two">
          <label className="field-label" htmlFor="sut-prompt">
            本次调用传入的 System Prompt
          </label>
          <textarea
            id="sut-prompt"
            className="text-area"
            value={form.systemPrompt}
            onChange={(e) => change("systemPrompt", e.target.value)}
          />
        </div>
        {field("temperature", "Temperature（可选）", "number")}
        {field("topP", "Top P（可选）", "number")}
        {field("session", "会话说明")}
        {field("initialMemory", "初始记忆说明")}
        {field("tools", "工具与能力说明", "text", true)}
      </div>
      <p className="footnote">
        配置用于后续运行。人工填写的版本不代表服务端证明；Meta
        地址可留空。凭据仅保存在服务端，快照不复制密钥值。
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button onClick={onClose}>取消</Button>
        <Button type="submit" primary disabled={busy}>
          {busy ? "保存中…" : "保存配置"}
        </Button>
      </div>
    </form>
  );
}
export default function Agents({
  section,
  suts,
  judge,
  userGenerator,
  onSave,
  onJudgeSave,
  onUserGeneratorSave,
  onReturn,
}: {
  section: "sut" | "judge" | "simulator";
  suts: SutView[];
  judge?: JudgeConfigView;
  userGenerator?: UserGeneratorConfigView;
  onSave: (input: CreateSutRequest, id?: string) => Promise<void>;
  onJudgeSave: (settings: JudgeSettings) => Promise<void>;
  onUserGeneratorSave: (settings: UserGeneratorSettings) => Promise<void>;
  onReturn?: () => void;
}) {
  const [editing, setEditing] = useState<SutView | null | undefined>(undefined),
    [meta, setMeta] = useState<SutView | null>(null),
    [judgeOpen, setJudgeOpen] = useState(false),
    [fakeUserOpen, setFakeUserOpen] = useState(false);
  const connectionName = (id: string | undefined) =>
    suts.find((s) => s.id === id)?.name ?? id ?? "未选择";
  return (
    <div className="page">
      {section === "sut" && (
      <>
      <PageHeader
        title="被测"
        subtitle="要对话的 Agent。每次运行会冻结当时的调用配置。"
        action={
          <>
            {onReturn && <Button onClick={onReturn}>继续新建探索 ↗</Button>}
            <Button primary onClick={() => setEditing(null)}>
              ＋ 接入 Agent
            </Button>
          </>
        }
      />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>接入 / 环境</th>
              <th>模型与版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {suts.map((s) => (
              <tr key={s.id}>
                <td>
                  <button className="link-button" onClick={() => setMeta(s)}>
                    {s.name}
                  </button>
                  <small>{s.description ?? s.note}</small>
                </td>
                <td>
                  <Badge>
                    {s.transport === "fixture"
                      ? "内置样例"
                      : s.transport.toUpperCase()}
                  </Badge>
                  <small>{s.environment ?? "未登记"}</small>
                </td>
                <td>
                  {s.model ?? "未记录"}
                  <small>Agent {s.agentVersion ?? "版本未提供"}</small>
                </td>
                <td className="nowrap">
                  <Button quiet onClick={() => setMeta(s)}>
                    查看 Meta
                  </Button>
                  {s.transport !== "fixture" && (
                    <Button onClick={() => setEditing(s)}>配置</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!suts.length && <Empty>还没有登记被测。</Empty>}
      </div>
      </>
      )}
      {section === "judge" && (
        <>
          <PageHeader
            title="LLM-as-judge"
            subtitle="对话结束后由另一个模型读证据。它不代替人做纳入回归或驳回。"
            action={<Button primary onClick={() => setJudgeOpen(true)}>配置评审</Button>}
          />
          <section className="panel">
            {judge?.configured && judge.settings ? (
              <KeyValues
                items={[
                  ["模型", judge.settings.model],
                  ["连接", connectionName(judge.settings.connectionSutId)],
                  ["温度", String(judge.settings.temperature)],
                  ["量表版本", judge.settings.rubricVersion],
                ]}
              />
            ) : (
              <Empty>{judge?.error ?? "还没有配置评审。探索可以跑完对话，但不会自动打分。"}</Empty>
            )}
            <p className="footnote">
              评审和仿真用户应使用不同的模型。连接从已登记的 HTTP 接口里选，密钥留在那条连接上。
            </p>
          </section>
        </>
      )}
      {section === "simulator" && (
        <>
          <PageHeader
            title="仿真"
            subtitle="探索时扮演人群、按剧本说出这一拍。回归使用冻结原句，不再调用它。"
            action={<Button primary onClick={() => setFakeUserOpen(true)}>配置仿真</Button>}
          />
          <section className="panel">
            {userGenerator?.configured && userGenerator.settings ? (
              <KeyValues
                items={[
                  ["模型", userGenerator.settings.model],
                  ["连接", connectionName(userGenerator.settings.connectionSutId)],
                  ["温度", String(userGenerator.settings.temperature)],
                  ["提示词版本", userGenerator.settings.promptVersion],
                  ["单句最多尝试", String(userGenerator.settings.maxAttempts)],
                ]}
              />
            ) : (
              <Empty>{userGenerator?.error ?? "还没有配置仿真用户。探索会拒绝开跑。"}</Empty>
            )}
            <p className="footnote">
              剧本决定说话、沉默或离开。仿真模型只生成台词，不能改动作。
            </p>
          </section>
        </>
      )}
      <Modal
        open={editing !== undefined}
        onClose={() => setEditing(undefined)}
        wide
        title={editing ? `编辑接入 · ${editing.name}` : "接入 Agent"}
        subtitle="当前配置只影响后续运行。"
      >
        {editing !== undefined && (
          <SutEditor
            key={editing?.id ?? "new"}
            sut={editing ?? undefined}
            onSave={(input) => onSave(input, editing?.id)}
            onClose={() => setEditing(undefined)}
          />
        )}
      </Modal>
      <Modal
        open={!!meta}
        onClose={() => setMeta(null)}
        title={`${meta?.name ?? ""} · Agent Meta`}
      >
        {meta && <SutMeta sut={meta} />}
      </Modal>
      <Modal
        open={fakeUserOpen}
        onClose={() => setFakeUserOpen(false)}
        title="仿真 agent 配置"
        subtitle="当前配置用于之后的新探索；旧运行保留当时的生成器配置与提示词。"
      >
        {fakeUserOpen && (
          <FakeUserSettingsForm
            suts={suts}
            initial={userGenerator?.settings}
            onSave={async (s) => {
              await onUserGeneratorSave(s);
              setFakeUserOpen(false);
            }}
          />
        )}
      </Modal>
      <Modal
        open={judgeOpen}
        onClose={() => setJudgeOpen(false)}
        title="自动评审配置"
        subtitle="当前配置用于之后的新运行；旧运行保留当时的评审配置。"
      >
        {judgeOpen && (
          <JudgeSettingsForm
            suts={suts}
            initial={judge?.settings}
            onSave={async (s) => {
              await onJudgeSave(s);
              setJudgeOpen(false);
            }}
          />
        )}
      </Modal>
    </div>
  );
}
