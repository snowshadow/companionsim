import { useCallback, useEffect, useState } from "react";
import type {
  AdminOverviewResponse,
  QuotaUsageView,
  Role,
  UserAdminView,
} from "../../shared/schema";
import {
  createUser,
  errorMessage,
  getAdminOverview,
  kickUser,
  patchUser,
  setQuotaOverride,
} from "../api";
import { Badge, Button, Empty, PageHeader, fmtDate } from "../ui";

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function usedOf(usage?: QuotaUsageView): string {
  if (!usage) return "—";
  return `${tokens(usage.used)} / ${tokens(usage.limit)}`;
}

/**
 * 管理页：谁能进来、谁是管理员、今天各人烧了多少、平台最近发生了什么。
 * 只有 admin 能打开（服务端也会拦）。
 */
export default function Admin() {
  const [data, setData] = useState<AdminOverviewResponse | undefined>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");

  const load = useCallback(async () => {
    try {
      setData(await getAdminOverview());
      setError("");
    } catch (err) {
      setError(errorMessage(err, "读取管理信息失败"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await fn();
      setNotice(message);
      await load();
    } catch (err) {
      setError(errorMessage(err, "操作失败"));
    } finally {
      setBusy(false);
    }
  }

  async function createAccount() {
    setBusy(true);
    setError("");
    try {
      await createUser({
        username: username.trim(),
        password,
        name: displayName.trim(),
        role,
      });
      setNotice(`已创建账号 ${username.trim()}`);
      setUsername("");
      setDisplayName("");
      setPassword("");
      setRole("member");
      await load();
    } catch (err) {
      setError(errorMessage(err, "创建账号失败"));
    } finally {
      setBusy(false);
    }
  }

  async function promote(user: UserAdminView, next: Role) {
    await run(
      () => patchUser(user.id, { role: next }),
      `${user.name} 的角色已改为 ${next}`,
    );
  }

  async function toggleStatus(user: UserAdminView) {
    const next = user.status === "active" ? "disabled" : "active";
    if (
      next === "disabled" &&
      !window.confirm(`停用 ${user.name}？其会话会立刻失效。`)
    )
      return;
    await run(
      () => patchUser(user.id, { status: next }),
      next === "disabled" ? `${user.name} 已停用` : `${user.name} 已恢复`,
    );
  }

  async function raiseQuota(user: UserAdminView | undefined) {
    if (!user) return;
    const input = window.prompt(
      `给 ${user.name} 设置今日 token 上限（留空恢复默认）：`,
      String(user.todayUsage?.limit ?? ""),
    );
    if (input === null) return;
    const value = input.trim() === "" ? null : Number(input.replace(/[^0-9]/g, ""));
    await run(
      () => setQuotaOverride(user.id, value),
      value === null ? `${user.name} 已恢复默认额度` : `${user.name} 今日上限改为 ${value}`,
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="管理"
        subtitle="用户与角色、Key 概览、今日额度、最近操作留痕。"
        action={
          <Button quiet onClick={() => void load()} disabled={busy}>
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

      {data && (
        <>
          <section className="card">
            <h2>平台状态</h2>
            <ul className="plain-list">
              {data.configuration && <li>
                配置来源：{data.configuration.source === "nacos" ? "Nacos" : "本地文件"}{" "}
                <Badge tone={data.configuration.state === "ready" ? "green" : "orange"}>
                  {{ ready: "已生效", pending_restart: "启动配置变更，待重启", degraded: "更新异常，沿用上次有效配置", unavailable: "尚未就绪" }[data.configuration.state]}
                </Badge>
                {data.configuration.revision && <small> · 版本 {data.configuration.revision.slice(0, 8)}</small>}
              </li>}
              <li>
                数据库：
                {data.database.ok ? (
                  <Badge tone="green">已连接 {data.database.version}</Badge>
                ) : (
                  <Badge tone="red">{data.database.error ?? "连不上"}</Badge>
                )}
              </li>
              <li>
                首个管理员：
                <code>{data.superadmin.username}</code>{" "}
                {data.superadmin.passwordConfigured ? (
                  <Badge tone="green">已设密码</Badge>
                ) : (
                  <Badge tone="red">未设密码</Badge>
                )}
              </li>
            </ul>
          </section>

          <section className="card">
            <h2>创建账号</h2>
            <form
              className="account-form"
              onSubmit={(event) => {
                event.preventDefault();
                void createAccount();
              }}
            >
              <label className="field-label" htmlFor="new-username">
                用户名
              </label>
              <input
                className="field"
                id="new-username"
                value={username}
                autoComplete="off"
                onChange={(event) => setUsername(event.target.value)}
              />
              <label className="field-label" htmlFor="new-name">
                显示名
              </label>
              <input
                className="field"
                id="new-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
              <label className="field-label" htmlFor="new-password">
                密码
              </label>
              <input
                className="field"
                id="new-password"
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(event) => setPassword(event.target.value)}
              />
              <label className="field-label" htmlFor="new-role">
                角色
              </label>
              <select
                className="field"
                id="new-role"
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
              <p className="muted small">
                用户名 3–32 位，只能包含字母、数字、点、下划线与连字符。密码至少 8 位。没有自助注册。
              </p>
              <Button primary type="submit" disabled={busy}>
                {busy ? "创建中…" : "创建账号"}
              </Button>
            </form>
          </section>

          <section className="card">
            <h2>用户（{data.users.length}）</h2>
            {data.users.length === 0 ? (
              <Empty>
                还没有账号。用上面的表单创建，或在配置里写好首个管理员的密码哈希后重启。
              </Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>姓名</th>
                      <th>角色</th>
                      <th>今日额度</th>
                      <th>最近登录</th>
                      <th>状态</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.users.map((user) => (
                      <tr key={user.id}>
                        <td>
                          {user.name}
                          <small>{user.username || user.email || user.id}</small>
                        </td>
                        <td>
                          <select
                            className="field compact"
                            aria-label={`${user.name} 的角色`}
                            value={user.role}
                            disabled={busy}
                            onChange={(e) =>
                              void promote(user, e.target.value as Role)
                            }
                          >
                            <option value="member">member</option>
                            <option value="admin">admin</option>
                          </select>
                        </td>
                        <td>
                          {usedOf(user.todayUsage)}
                          <small>
                            {user.todayUsage?.runs ?? 0} 局
                            <button
                              className="inline-link"
                              onClick={() => void raiseQuota(user)}
                            >
                              提额
                            </button>
                          </small>
                        </td>
                        <td>{fmtDate(user.lastLoginAt)}</td>
                        <td>
                          {user.status === "active" ? (
                            <Badge tone="green">在用</Badge>
                          ) : (
                            <Badge tone="red">已停用</Badge>
                          )}
                        </td>
                        <td>
                          <Button quiet onClick={() => void toggleStatus(user)}>
                            {user.status === "active" ? "停用" : "恢复"}
                          </Button>
                          <Button
                            quiet
                            onClick={() =>
                              void run(
                                () => kickUser(user.id),
                                `${user.name} 的会话已注销`,
                              )
                            }
                          >
                            踢会话
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <h2>全部 Key（{data.keys.length}）</h2>
            {data.keys.length === 0 ? (
              <Empty>还没有 Key。</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>名字</th>
                      <th>归属</th>
                      <th>权限</th>
                      <th>最近使用</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.keys.map((key) => (
                      <tr key={key.id}>
                        <td>
                          {key.name}
                          <small>
                            <code>{key.prefix}…</code>
                          </small>
                        </td>
                        <td>{key.ownerName}</td>
                        <td>{key.scopes.join(" / ")}</td>
                        <td>
                          {key.lastUsedAt ? fmtDate(key.lastUsedAt) : "未使用"}
                          {key.lastUsedIp && <small>{key.lastUsedIp}</small>}
                        </td>
                        <td>
                          {key.revokedAt ? (
                            <Badge tone="red">已吊销</Badge>
                          ) : (
                            <Badge tone="green">有效</Badge>
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
            <h2>最近操作（{data.audit.length}）</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>谁</th>
                    <th>做了什么</th>
                    <th>对象</th>
                    <th>来源 IP</th>
                  </tr>
                </thead>
                <tbody>
                  {data.audit.map((item) => (
                    <tr key={item.id}>
                      <td>{fmtDate(item.at, true)}</td>
                      <td>
                        {item.actor.name}
                        {item.actor.keyName && <small>key: {item.actor.keyName}</small>}
                      </td>
                      <td>{item.action}</td>
                      <td>
                        <code>{item.target}</code>
                      </td>
                      <td>{item.ip ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
