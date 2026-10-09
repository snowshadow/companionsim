import { useState } from "react";
import { errorMessage, login } from "../api";
import { Button } from "../ui";

/** 账号密码登录。账号由管理员创建，没有自助注册。 */
export default function Login({
  onDone,
}: {
  onDone: () => Promise<void> | void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await login(username, password);
      await onDone();
    } catch (err) {
      setError(errorMessage(err, "登录失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="brand login-brand">
          <img
            className="brand-logo"
            src="/brand/logo-a2.png"
            width="40"
            height="40"
            alt=""
          />
          <div>
            <small>虚拟陪伴与角色扮演模拟器</small>
            CompanionSim
          </div>
        </div>
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field-label" htmlFor="login-user">
            用户名
          </label>
          <input
            className="field"
            id="login-user"
            value={username}
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
          />
          <label className="field-label" htmlFor="login-pass">
            密码
          </label>
          <input
            className="field"
            id="login-pass"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <Button primary type="submit" disabled={busy || !username.trim() || !password}>
            {busy ? "登录中…" : "登录"}
          </Button>
        </form>
      </div>
    </div>
  );
}
