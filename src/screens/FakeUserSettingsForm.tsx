import { useState } from "react";
import type { SutView, UserGeneratorSettings } from "../../shared/schema";
import { Button } from "../ui";

const DEFAULTS: UserGeneratorSettings = {
  connectionSutId: "",
  model: "",
  temperature: 0.9,
  promptVersion: "fake-user-v3",
  maxAttempts: 5,
  backoffBaseMs: 1000,
  attemptTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
  priorTurnsLimit: 40,
};

export default function FakeUserSettingsForm({
  initial,
  suts,
  onSave,
}: {
  initial?: UserGeneratorSettings;
  suts: SutView[];
  onSave: (settings: UserGeneratorSettings) => Promise<void>;
}) {
  const [settings, setSettings] = useState<UserGeneratorSettings>(
      initial ?? DEFAULTS,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const change = (key: keyof UserGeneratorSettings, value: string | number) =>
    setSettings((s) => ({ ...s, [key]: value }));
  async function save() {
    setBusy(true);
    setError("");
    try {
      await onSave(settings);
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
        <div>
          <label className="field-label" htmlFor="fake-connection">
            生成连接
          </label>
          <select
            id="fake-connection"
            className="field"
            required
            value={settings.connectionSutId}
            onChange={(e) => change("connectionSutId", e.target.value)}
          >
            <option value="">选择 OpenAI 兼容连接</option>
            {suts
              .filter(
                (s) =>
                  s.transport === "sse" &&
                  (s.body === undefined || s.body === "openai-chat"),
              )
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="fake-model">
            生成模型
          </label>
          <input
            required
            id="fake-model"
            className="field"
            value={settings.model}
            onChange={(e) => change("model", e.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="fake-temperature">
            Temperature
          </label>
          <input
            id="fake-temperature"
            className="field"
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={settings.temperature}
            onChange={(e) => change("temperature", Number(e.target.value))}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="fake-prompt">
            提示词版本
          </label>
          <input
            readOnly
            id="fake-prompt"
            className="field"
            value={settings.promptVersion}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="fake-attempts">
            最多尝试次数
          </label>
          <input
            id="fake-attempts"
            className="field"
            type="number"
            min="1"
            max="10"
            value={settings.maxAttempts}
            onChange={(e) => change("maxAttempts", Number(e.target.value))}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="fake-backoff">
            退避基数（毫秒）
          </label>
          <input
            id="fake-backoff"
            className="field"
            type="number"
            min="0"
            step="100"
            value={settings.backoffBaseMs}
            onChange={(e) => change("backoffBaseMs", Number(e.target.value))}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="fake-attempt-timeout">
            单次超时（毫秒）
          </label>
          <input
            id="fake-attempt-timeout"
            className="field"
            type="number"
            min="1000"
            step="1000"
            value={settings.attemptTimeoutMs}
            onChange={(e) => change("attemptTimeoutMs", Number(e.target.value))}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="fake-total">
            单句总预算（毫秒）
          </label>
          <input
            id="fake-total"
            className="field"
            type="number"
            min="1000"
            step="1000"
            value={settings.totalTimeoutMs}
            onChange={(e) => change("totalTimeoutMs", Number(e.target.value))}
          />
        </div>
      </div>
      <p className="footnote">
        探索中每一拍 speak 的台词由该模型扮演人群说出，语气与约束来自剧本。失败按指数退避重试；
        尝试用完仍失败，本局停下并记原因，不用模板顶替。动作表由剧本控制，模型改不了。
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button type="submit" primary disabled={busy}>
          {busy ? "正在保存…" : "保存仿真 agent 配置"}
        </Button>
      </div>
    </form>
  );
}
