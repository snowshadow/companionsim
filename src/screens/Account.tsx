import { useCallback, useEffect, useState } from "react";
import type { ApiKeyView, KeyScope, QuotaUsageView } from "../../shared/schema";
import { agentBriefing } from "../../shared/briefing";
import { createKey, errorMessage, getKeys, getQuota, revokeKey } from "../api";
import { Badge, Button, Empty, PageHeader, fmtDate } from "../ui";

const SCOPE_LABEL: Record<KeyScope, string> = {
  read: "看目录与记录",
  author: "提交人群 / 剧本",
  run: "发起探索 / 回归",
};

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * 我的：把「Key + 说明书」交给本地 agent。页面上人只需要做两件事——生成 Key、复制那段话。
 * 技术细节（目录、环境变量、curl）收进折叠里，agent 那边由 Skill 自己承接。
 */
export default function Account() {
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [usage, setUsage] = useState<QuotaUsageView | undefined>();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<KeyScope[]>(["read", "author", "run"]);
  const [expiresInDays, setExpiresInDays] = useState("");
  const [plain, setPlain] = useState("");
  const [briefing, setBriefing] = useState("");
  const [briefingEdited, setBriefingEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const load = useCallback(async () => {
    try {
      const [keysResult, quotaResult] = await Promise.all([getKeys(), getQuota()]);
      setKeys(keysResult.keys);
      setUsage(quotaResult.usage);
      setError("");
    } catch (err) {
      setError(errorMessage(err, "读取 Key 失败"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 没被人手改过就跟着最新状态走（生成 Key 后自动把 Key 补进去）。
  useEffect(() => {
    if (!briefingEdited) setBriefing(agentBriefing(origin, plain || undefined));
  }, [briefingEdited, origin, plain]);

  async function create() {
    if (!name.trim()) {
      setError("给你的 agent 起个名字，方便日后区分（例如「我电脑上的 Codex」）");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const created = await createKey({
        name,
        scopes,
        ...(expiresInDays.trim() ? { expiresInDays: Number(expiresInDays) } : {}),
      });
      setPlain(created.plain);
      setBriefing(agentBriefing(origin, created.plain));
      setBriefingEdited(false);
      setName("");
      setExpiresInDays("");
      await load();
    } catch (err) {
      setError(errorMessage(err, "创建 Key 失败"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: ApiKeyView) {
    if (!window.confirm(`吊销 Key「${key.name}」？用它的本地 agent 会立刻失去访问。`)) return;
    try {
      await revokeKey(key.id);
      setNotice(`已吊销「${key.name}」`);
      await load();
    } catch (err) {
      setError(errorMessage(err, "吊销失败"));
    }
  }

  async function copyBriefing() {
    try {
      await navigator.clipboard.writeText(briefing);
      setNotice("已复制。粘贴给你的本地 agent（Codex / pi / Claude Code），它会自己做完剩下的。");
    } catch {
      setNotice("复制失败，请手动选中下面这段文字复制。");
    }
  }

  const active = keys.filter((key) => !key.revokedAt);

  return (
    <div className="page">
      <PageHeader
        title="我的"
        subtitle="把钥匙和说明书交给你的本地 agent（Codex / pi / Claude Code），剩下的它自己会办。"
        action={
          <Button quiet onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice inline" role="status">
          {notice}
        </div>
      )}

      <section className="card">
        <h2>① 把这段交给你的本地 agent</h2>
        <p className="muted">
          整段复制，粘贴进你的本地 agent。它会自己去下载操作说明书、存好 Key、调通接口，
          然后回来告诉你它能做什么。你不需要懂里面的细节。
          {!plain && (
            <>
              {" "}
              <strong>
                现在还差一把 Key：先在下面「② 生成一把 Key」，这段会自动补上。
              </strong>
            </>
          )}
        </p>
        <textarea
          className="text-area briefing"
          aria-label="交给本地 agent 的交接语"
          rows={16}
          value={briefing}
          onChange={(e) => {
            setBriefing(e.target.value);
            setBriefingEdited(true);
          }}
        />
        <div className="header-actions">
          <Button primary onClick={() => void copyBriefing()}>
            复制这段，交给 agent
          </Button>
          <a className="button" href="/api/skills.zip">
            下载说明书（zip）
          </a>
        </div>
        <details className="compact-details">
          <summary>技术细节（人看的；agent 不需要，上面那段已经够了）</summary>
          <ul className="plain-list">
            <li>
              说明书就是两份 Skill：<code>companionsim-ops</code>（接被测、跑局、看证据）、
              <code>companionsim-author</code>（写人群与剧本）。zip 里含中文安装说明。
            </li>
            <li>
              常见宿主目录：Claude Code <code>~/.claude/skills/</code>、Codex{" "}
              <code>~/.codex/skills/</code>、pi <code>~/.pi/agent/skills/</code>、Cursor{" "}
              <code>~/.cursor/skills/</code>。
            </li>
            <li>
              agent 的手工配置方式：环境变量 <code>SIM_EVAL_KEY=simk_…</code>，
              请求头 <code>Authorization: Bearer $SIM_EVAL_KEY</code>；自检{" "}
              <code>GET /api/auth/me</code>。
            </li>
            <li>
              仓库里的源码在 <code>.cursor/skills/companionsim-ops</code> 与{" "}
              <code>.cursor/skills/companionsim-author</code>。更新时重新下载 zip，覆盖旧目录。
            </li>
          </ul>
        </details>
      </section>

      <section className="card">
        <h2>② 生成一把 Key</h2>
        {plain && (
          <div className="key-plain">
            <strong>这串只显示这一次。</strong> 上面那段交接语里已经包含它；复制给 agent
            之后就可以收起。关掉就再也看不到明文了，只能吊销重建。
            <code className="key-plain-value">{plain}</code>
            <div className="header-actions">
              <Button
                onClick={() =>
                  void navigator.clipboard
                    .writeText(plain)
                    .then(() => setNotice("Key 已复制"))
                    .catch(() => setNotice("复制失败，请手动选中复制"))
                }
              >
                只复制 Key
              </Button>
              <Button quiet onClick={() => setPlain("")}>
                已保存，收起
              </Button>
            </div>
          </div>
        )}
        <label className="field-label" htmlFor="key-name">
          给这把 Key 起个名字（区分是哪个 agent / 哪台机器）
        </label>
        <input
          className="field"
          id="key-name"
          placeholder="例如：我电脑上的 Codex"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <details className="compact-details">
          <summary>权限与有效期（默认够用，一般不用改）</summary>
          <fieldset className="scope-fieldset">
            <legend className="field-label">这个 agent 能做</legend>
            {(Object.keys(SCOPE_LABEL) as KeyScope[]).map((scope) => (
              <label key={scope} className="check-line">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(e) =>
                    setScopes((current) =>
                      e.target.checked
                        ? [...current, scope]
                        : current.filter((item) => item !== scope),
                    )
                  }
                />
                {SCOPE_LABEL[scope]}
              </label>
            ))}
          </fieldset>
          <label className="field-label" htmlFor="key-expires">
            有效期（天，留空表示不过期）
          </label>
          <input
            className="field"
            id="key-expires"
            inputMode="numeric"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <p className="muted small">
            无论给哪些权限，agent 都不能代替你判定（纳入回归 / 驳回 / 无法判定），
            也不能改被测、评审、仿真 agent 的配置——这两条服务端会直接拒。
          </p>
        </details>
        <div className="header-actions">
          <Button primary onClick={() => void create()} disabled={busy}>
            {busy ? "生成中…" : "生成 Key"}
          </Button>
        </div>
      </section>

      <section className="card">
        <h2>我的 Key（{active.length} 个有效）</h2>
        {keys.length === 0 ? (
          <Empty>还没有 Key。生成一把，就能让你的本地 agent 开始干活。</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名字</th>
                  <th>能做什么</th>
                  <th>最近使用</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>
                      {key.name}
                      <small>
                        <code>{key.prefix}…</code> · {fmtDate(key.createdAt)} by{" "}
                        {key.createdByName}
                      </small>
                    </td>
                    <td>
                      {key.scopes.map((scope) => (
                        <Badge key={scope}>{SCOPE_LABEL[scope]}</Badge>
                      ))}
                    </td>
                    <td>
                      {key.lastUsedAt ? fmtDate(key.lastUsedAt) : "还没用过"}
                      {key.lastUsedIp && <small>{key.lastUsedIp}</small>}
                    </td>
                    <td>
                      {key.revokedAt ? (
                        <Badge tone="red">已吊销</Badge>
                      ) : (
                        <Badge tone="green">有效</Badge>
                      )}
                    </td>
                    <td>
                      {!key.revokedAt && (
                        <Button quiet onClick={() => void revoke(key)}>
                          吊销
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>我今天的额度</h2>
        {usage ? (
          <>
            <p className="quota-headline">
              还能跑 <strong>{tokens(usage.remaining)}</strong> token
            </p>
            <div className="quota-bar" role="img" aria-label="今日额度使用情况">
              <span
                style={{
                  width: `${Math.min(
                    100,
                    usage.limit > 0 ? (usage.used / usage.limit) * 100 : 0,
                  )}%`,
                }}
              />
            </div>
            <p className="muted small">
              今天已经跑了 {usage.runs} 局，用了 {tokens(usage.used)} / 上限{" "}
              {tokens(usage.limit)}；每天按人重置。
            </p>
            <details className="compact-details">
              <summary>数字怎么来的</summary>
              <p className="muted small">
                开跑前按剧本拍数与回看轮数预估，超上限就先拒绝并告诉你三个数；
                跑完之后按模型实际报的用量回写校准。{usage.day} 预估{" "}
                {tokens(usage.estimated)}、实测 {tokens(usage.actual)}（取较大者计费）。
              </p>
            </details>
          </>
        ) : (
          <p className="muted">读取中…</p>
        )}
      </section>
    </div>
  );
}
