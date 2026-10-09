import { useState } from "react";
import type { JudgeSettings, SutView } from "../../shared/schema";
import { Button } from "../ui";
export default function JudgeSettingsForm({
  initial,
  suts,
  onSave,
  label = "保存评审配置",
}: {
  initial?: JudgeSettings;
  suts: SutView[];
  onSave: (settings: JudgeSettings) => Promise<void>;
  label?: string;
}) {
  const [settings, setSettings] = useState<JudgeSettings>(
      initial ?? {
        connectionSutId: "",
        model: "",
        temperature: 0,
        rubricVersion: "companion-v1",
      },
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const change = (key: keyof JudgeSettings, value: string | number) =>
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
          <label className="field-label" htmlFor="judge-connection">
            评审连接
          </label>
          <select
            id="judge-connection"
            className="field"
            required
            value={settings.connectionSutId}
            onChange={(e) => change("connectionSutId", e.target.value)}
          >
            <option value="">选择 SSE 连接</option>
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
          <label className="field-label" htmlFor="judge-model">
            评审模型
          </label>
          <input
            required
            id="judge-model"
            className="field"
            value={settings.model}
            onChange={(e) => change("model", e.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="judge-temperature">
            Temperature
          </label>
          <input
            id="judge-temperature"
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
          <label className="field-label" htmlFor="judge-rubric">
            Rubric 版本
          </label>
          <input
            readOnly
            id="judge-rubric"
            className="field"
            value="companion-v1"
          />
        </div>
      </div>
      <p className="footnote">
        复用连接的地址和凭据，使用独立评审提示词。每次评审保留配置、原结果与人的判定。
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button type="submit" primary disabled={busy}>
          {busy ? "正在保存…" : label}
        </Button>
      </div>
    </form>
  );
}
