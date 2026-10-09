import { useCallback, useEffect, useRef, useState } from "react";
import {
  FilmScript,
  Gear,
  Path,
  Play,
  Robot,
  Scales,
  Tray,
  UserCircle,
  UserSound,
  UsersThree,
} from "@phosphor-icons/react";
import {
  createSut,
  decideRun,
  errorMessage,
  getCatalog,
  getMe,
  getRuns,
  logout,
  retryJudge,
  reviewReplay,
  saveFakeUserConfig,
  saveJudgeConfig,
  startHunt,
  startReplay,
  UnauthorizedError,
  updateSut,
} from "./api";
import type {
  CatalogResponse,
  CreateSutRequest,
  JudgeSettings,
  MeResponse,
  Person,
  QueueStatus,
  Run,
  ScriptView,
  UserGeneratorSettings,
} from "../shared/schema";
import { isReviewable, isRunning, needsHumanReview } from "../shared/run-state";
import Agents from "./screens/Agents";
import Launch, { type LaunchDraft } from "./screens/Launch";
import People from "./screens/People";
import Queue, { type RunFilter } from "./screens/Queue";
import Review from "./screens/Review";
import Scripts from "./screens/Scripts";
import Regression from "./screens/Regression";
import HowTo from "./screens/HowTo";
import Login from "./screens/Login";
import Account from "./screens/Account";
import Admin from "./screens/Admin";
import { Button } from "./ui";
export type Page =
  | "explore"
  | "howto"
  | "regression"
  | "people"
  | "scripts"
  | "agents"
  | "judge"
  | "simulator"
  | "account"
  | "admin";
const empty: CatalogResponse = {
  people: [],
  scripts: [],
  snapshots: [],
  suts: [],
  issues: [],
};
function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export default function App() {
  const [me, setMe] = useState<MeResponse | undefined>(undefined),
    [page, setPage] = useState<Page>("explore"),
    [catalog, setCatalog] = useState<CatalogResponse>(empty),
    [runs, setRuns] = useState<Run[]>([]),
    [activeId, setActiveId] = useState<string | null>(null),
    [draft, setDraft] = useState<LaunchDraft>({
      personKey: "",
      scriptKey: "",
      sutId: "",
    }),
    [launch, setLaunch] = useState(false),
    [returnToLaunch, setReturnToLaunch] = useState(false),
    [filter, setFilter] = useState<RunFilter>("待审"),
    [search, setSearch] = useState(""),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const flash = useCallback((s: string) => {
    setToast(s);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 5000);
  }, []);
  const active = runs.find((r) => r.id === activeId);
  const hasLive = runs.some(isRunning);
  // 与探索页「待审」筛选同口径：跑完但还没最终判定的局（含「无法判定」）。
  const huntPendingCount = runs.filter(
    (r) => r.mode === "hunt" && needsHumanReview(r),
  ).length;
  const remember = useCallback(
    (run: Run) =>
      setRuns((current) =>
        [run, ...current.filter((r) => r.id !== run.id)].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
      ),
    [],
  );
  const refresh = useCallback(
    async (showChange = false) => {
      const [nextCatalog, nextRuns] = await Promise.all([
        getCatalog(),
        getRuns(),
      ]);
      const previous = catalogRef.current;
      const newPerson = nextCatalog.people.find(
        (p) =>
          !previous.people.some(
            (x) => x.id === p.id && x.version === p.version,
          ),
      );
      const newScript = nextCatalog.scripts.find(
        (s) =>
          !previous.scripts.some(
            (x) => x.id === s.id && x.version === s.version,
          ),
      );
      setCatalog(nextCatalog);
      setRuns(nextRuns);
      setError("");
      setDraft((d) => ({
        personKey:
          d.personKey ||
          (nextCatalog.people[0] &&
            `${nextCatalog.people[0].id}@${nextCatalog.people[0].version}`) ||
          "",
        scriptKey:
          d.scriptKey ||
          (nextCatalog.scripts[0] &&
            `${nextCatalog.scripts[0].id}@${nextCatalog.scripts[0].version}`) ||
          "",
        sutId: d.sutId || nextCatalog.suts[0]?.id || "",
      }));
      if (showChange)
        flash(
          newPerson || newScript
            ? `已找到${[newPerson?.name, newScript?.name].filter(Boolean).join("、")}，可在素材列表中选用；原选择已保留。`
            : nextCatalog.issues.length
              ? `已刷新；${nextCatalog.issues.length} 个产物需修正。`
              : "产物与运行记录已刷新。",
        );
    },
    [flash],
  );
  const loadMe = useCallback(async () => {
    const next = await getMe();
    setMe(next);
    return next;
  }, []);
  useEffect(() => {
    let disposed = false;
    void loadMe()
      .catch((e) => {
        if (!disposed) setError(errorMessage(e, "读取登录状态失败"));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      clearTimeout(toastTimer.current);
    };
  }, [loadMe]);
  // 登录之后才拉产物与运行记录；未登录时不发这些请求（免得一排 401）。
  useEffect(() => {
    if (me?.authenticated !== true) return;
    let disposed = false;
    void refresh().catch((e) => {
      if (disposed) return;
      setError(
        e instanceof UnauthorizedError ? "" : errorMessage(e, "载入失败"),
      );
      if (e instanceof UnauthorizedError) void loadMe();
    });
    return () => {
      disposed = true;
    };
  }, [me?.authenticated, loadMe, refresh]);
  useEffect(() => {
    if (!hasLive || me?.authenticated !== true) return;
    const timer = setInterval(
      () =>
        void getRuns()
          .then(setRuns)
          .catch((e) => setError(errorMessage(e, "运行状态刷新失败"))),
      1200,
    );
    return () => clearInterval(timer);
  }, [hasLive, me?.authenticated]);
  useEffect(() => {
    if (me?.authenticated !== true) return;
    const focus = () =>
      void refresh(false).catch((e) => setError(errorMessage(e, "刷新失败")));
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [refresh, me?.authenticated]);
  function navigate(p: Page) {
    setPage(p);
    setActiveId(null);
  }
  function openRun(id: string) {
    setActiveId(id);
    const r = runs.find((x) => x.id === id);
    if (r) setPage(r.mode === "replay" ? "regression" : "explore");
  }
  function usePerson(p: Person) {
    setDraft((d) => ({ ...d, personKey: `${p.id}@${p.version}` }));
    setLaunch(true);
  }
  function useScript(s: ScriptView) {
    setDraft((d) => ({ ...d, scriptKey: `${s.id}@${s.version}` }));
    setLaunch(true);
  }
  function resumeLaunch() {
    navigate("explore");
    setReturnToLaunch(false);
    setLaunch(true);
  }
  /** 统一处理 401：会话过期就回登录页，别把它当普通报错弹给人。 */
  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await loadMe();
        throw new Error("登录已过期，请重新登录");
      }
      throw err;
    }
  }

  async function signOut() {
    await logout().catch(() => undefined);
    await loadMe();
    setRuns([]);
    setCatalog(empty);
  }

  async function launchHunt() {
    const p = catalog.people.find(
        (p) => `${p.id}@${p.version}` === draft.personKey,
      ),
      s = catalog.scripts.find(
        (s) => `${s.id}@${s.version}` === draft.scriptKey,
      );
    if (!p || !s || !draft.sutId) throw new Error("请选择人群、剧本和被测");
    const run = await guard(() => startHunt({
      personId: p.id,
      personVersion: p.version,
      scriptId: s.id,
      scriptVersion: s.version,
      sutId: draft.sutId,
    }));
    remember(run);
    navigate("explore");
    setFilter("运行中");
    flash(`${run.personName} × ${run.scriptName} 已在后台运行。`);
  }
  async function launchReplay(snapshotId: string) {
    const run = await guard(() => startReplay(snapshotId, draft.sutId));
    remember(run);
    flash("回归已开始，使用冻结原句；可继续启动其他用例。");
  }
  async function saveSut(input: CreateSutRequest, id?: string) {
    const sut = await guard(() =>
      id ? updateSut(id, input) : createSut(input),
    );
    await refresh();
    setDraft((d) => ({ ...d, sutId: sut.id }));
    flash(`${sut.name} 已保存，后续运行使用新配置。`);
    if (returnToLaunch) resumeLaunch();
  }
  async function saveJudge(settings: JudgeSettings) {
    const judge = await guard(() => saveJudgeConfig(settings));
    setCatalog((c) => ({ ...c, judge }));
    flash("自动评审配置已保存。");
  }
  async function saveUserGenerator(settings: UserGeneratorSettings) {
    const userGenerator = await guard(() => saveFakeUserConfig(settings));
    setCatalog((c) => ({ ...c, userGenerator }));
    flash("仿真 agent 配置已保存。");
  }
  async function decide(
    status: Exclude<QueueStatus, "pending">,
    reason: string,
    evidence: string[],
    attempt?: string,
  ) {
    if (!active) return;
    setBusy(true);
    try {
      const updated = await guard(() =>
        decideRun(active.id, status, reason, evidence, attempt),
      );
      remember(updated);
      const next = runs.find(
        (r) => r.id !== active.id && isReviewable(r) && r.status === "pending",
      );
      setActiveId(next?.id ?? null);
      setPage("explore");
      setFilter("待审");
      const nextCatalog = await getCatalog();
      setCatalog(nextCatalog);
      flash(
        `${status === "accepted" ? "已纳入回归并冻结台词" : status === "rejected" ? "已驳回，记录保留" : "已标为无法判定，可回来补证"}${next ? "；已打开下一局。" : "。"}`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function retry(settings?: JudgeSettings) {
    if (!active) return;
    setBusy(true);
    try {
      remember(await guard(() => retryJudge(active.id, settings)));
      flash("正在评审同一份记录，对话与原判定保留。");
    } finally {
      setBusy(false);
    }
  }
  async function reviewed(note: string) {
    if (!active) return;
    setBusy(true);
    try {
      remember(await guard(() => reviewReplay(active.id, note)));
      flash("已保存回归备注并标为已查看。");
    } finally {
      setBusy(false);
    }
  }
  const nav = [
    { id: "explore", label: "探索", Icon: Play },
    { id: "howto", label: "怎么用", Icon: Path },
    { id: "regression", label: "回归", Icon: Tray },
    { id: "people", label: "人群", Icon: UsersThree },
    { id: "scripts", label: "剧本", Icon: FilmScript },
    { id: "agents", label: "被测", Icon: Robot },
    { id: "judge", label: "LLM-as-judge", Icon: Scales },
    { id: "simulator", label: "仿真", Icon: UserSound },
    ...(me?.can.admin
      ? [{ id: "admin" as const, label: "管理", Icon: Gear }]
      : []),
    { id: "account", label: "我的", Icon: UserCircle },
  ] as const;
  const sourceId = active?.snapshotId
    ? catalog.snapshots.find((s) => s.id === active.snapshotId)?.sourceRunId
    : undefined;
  if (!me) {
    return (
      <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }} aria-busy={!error}>
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <Button onClick={() => {
              setError("");
              void loadMe().catch((e) => setError(errorMessage(e, "读取登录状态失败")));
            }}>重试</Button>
          </div>
        ) : <div role="status">正在检查登录状态…</div>}
      </main>
    );
  }
  if (me && !me.authenticated) {
    return (
      <Login
        onDone={async () => {
          setLoading(true);
          await loadMe();
          setLoading(false);
        }}
      />
    );
  }
  return (
    <>
      <div className="app-shell">
        <nav className="sidebar" aria-label="主导航">
          <div className="brand">
            <img className="brand-logo" src="/brand/logo-a2.png" width="40" height="40" alt="" />
            <div><small>虚拟陪伴与角色扮演模拟器</small>CompanionSim</div>
          </div>
          {nav.map(({ id, label, Icon }) => (
            <div key={id}>
              {id === "people" && <div className="nav-label">编排素材</div>}
              {id === "agents" && <div className="nav-label">连接</div>}
              <button
                className={`nav-button ${page === id ? "active" : ""}`}
                style={{ width: "100%" }}
                onClick={() => navigate(id)}
              >
                <Icon size={17} />
                {label}
                {id === "explore" && huntPendingCount > 0 && (
                  <span className="nav-count">{huntPendingCount}</span>
                )}
              </button>
            </div>
          ))}
          <div className="nav-footer">
            {me?.authenticated && (
              <div className="who">
                <div className="who-line">
                  {me.user?.avatarUrl ? (
                    <img className="who-avatar" src={me.user.avatarUrl} alt="" />
                  ) : (
                    <UserCircle size={18} />
                  )}
                  <span className="who-name">
                    {me.user?.name ?? me.superadminUsername}
                  </span>
                  {me.role === "admin" && <span className="badge blue">admin</span>}
                </div>
                {me.quota && (
                  <div className="who-quota" title="今日仿真 token 用量">
                    今日 {tokens(me.quota.used)} / {tokens(me.quota.limit)}
                  </div>
                )}
                <button className="inline-link" onClick={() => void signOut()}>
                  退出登录
                </button>
              </div>
            )}
            <div className="nav-motto">
              人提出意图、判断结果
              <br />
              Agent 编排，平台执行
            </div>
          </div>
        </nav>
        <main className="main-content">
          {error && (
            <div className="error-banner" role="alert" style={{ margin: 12 }}>
              {error}{" "}
              <Button
                quiet
                onClick={() =>
                  void refresh().catch((e) =>
                    setError(errorMessage(e, "刷新失败")),
                  )
                }
              >
                重新加载
              </Button>
            </div>
          )}
          {loading ? (
            <div className="global-loading">正在读取产物与运行记录…</div>
          ) : active ? (
            <Review
              key={active.id}
              run={active}
              sourceRun={runs.find((r) => r.id === sourceId)}
              catalog={catalog}
              onBack={() => setActiveId(null)}
              onOpen={openRun}
              onDecide={decide}
              onRetry={retry}
              onReviewed={reviewed}
              busy={busy}
            />
          ) : page === "explore" ? (
            <Queue
              items={runs}
              onOpen={openRun}
              onLaunch={() => setLaunch(true)}
              filter={filter}
              onFilter={setFilter}
              search={search}
              onSearch={setSearch}
              onRefresh={() => refresh(true)}
            />
          ) : page === "regression" ? (
            <Regression
              runs={runs}
              snapshots={catalog.snapshots}
              suts={catalog.suts}
              sutId={draft.sutId}
              onSut={(sutId) => setDraft((d) => ({ ...d, sutId }))}
              onStart={launchReplay}
              onOpen={openRun}
            />
          ) : page === "people" ? (
            <People
              focusKey={draft.personKey}
              people={catalog.people}
              scripts={catalog.scripts}
              issues={catalog.issues}
              onUse={usePerson}
              onRefresh={() => refresh(true)}
            />
          ) : page === "scripts" ? (
            <Scripts
              focusKey={draft.scriptKey}
              scripts={catalog.scripts}
              issues={catalog.issues}
              onUse={useScript}
              onRefresh={() => refresh(true)}
            />
          ) : page === "account" ? (
            <Account />
          ) : page === "admin" ? (
            <Admin />
          ) : page === "agents" || page === "judge" || page === "simulator" ? (
            <Agents
              section={page === "judge" ? "judge" : page === "simulator" ? "simulator" : "sut"}
              suts={catalog.suts}
              judge={catalog.judge}
              userGenerator={catalog.userGenerator}
              onSave={saveSut}
              onJudgeSave={saveJudge}
              onUserGeneratorSave={saveUserGenerator}
              onReturn={returnToLaunch ? resumeLaunch : undefined}
            />
          ) : (
            <HowTo onGoto={navigate} />
          )}
        </main>
      </div>
      <Launch
        open={launch}
        onClose={() => setLaunch(false)}
        catalog={catalog}
        draft={draft}
        onDraft={setDraft}
        onStart={launchHunt}
        onRefresh={() => refresh(true)}
        onSut={() => {
          setLaunch(false);
          setReturnToLaunch(true);
          navigate("agents");
        }}
      />
      {toast && (
        <div className="notice" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
