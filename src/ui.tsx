import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
export function Button({
  children,
  onClick,
  disabled = false,
  primary = false,
  quiet = false,
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
  quiet?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={`button ${primary ? "primary" : ""} ${quiet ? "quiet" : ""} ${className}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "blue" | "orange" | "red" | "green";
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="muted page-subtitle">{subtitle}</div>}
      </div>
      {action && <div className="header-actions">{action}</div>}
    </header>
  );
}
export function Modal({
  title,
  subtitle,
  open,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current?.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <header className="modal-header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <div className="muted page-subtitle">{subtitle}</div>}
        </div>
        <button
          className="icon-button"
          aria-label="关闭对话框"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function KeyValues({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="key-values">
      {items.map(([k, v], i) => (
        <div key={k + i}>
          <dt>{k}</dt>
          <dd>{v === undefined || v === null || v === "" ? "未记录" : v}</dd>
        </div>
      ))}
    </dl>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Issues({
  items,
}: {
  items: { path: string; errors: string[] }[];
}) {
  return items.length ? (
    <details className="issue-box" open>
      <summary>{items.length} 个产物未通过校验</summary>
      {items.map((i) => (
        <div key={i.path}>
          <strong>{i.path}</strong>
          {i.errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      ))}
    </details>
  ) : null;
}
export function fmtDate(value?: string, full = false) {
  if (!value) return "未记录";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    ...(full ? { year: "numeric" as const } : {}),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(full ? { second: "2-digit" as const } : {}),
    hour12: false,
  }).format(d);
}
export function duration(value?: number | null) {
  return value == null
    ? "未记录"
    : value < 1000
      ? `${Math.round(value)} ms`
      : `${(value / 1000).toFixed(2)} s`;
}
export function JsonView({ value }: { value: unknown }) {
  return (
    <pre className="json-view">
      {value == null ? "未记录" : JSON.stringify(value, null, 2)}
    </pre>
  );
}

/**
 * 列表分页。页大小可选，切筛选条件时回到第一页；
 * 数据变少（筛掉、翻到空页）时自动夹回有效范围，不会停在空白页。
 */
export function usePager<T>(
  items: T[],
  options: { pageSize?: number; resetKey?: string } = {},
) {
  const [pageSize, setPageSize] = useState(options.pageSize ?? 20);
  const [page, setPage] = useState(1);
  const resetKey = options.resetKey ?? "";
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  useEffect(() => {
    setPage(1);
  }, [resetKey, pageSize]);
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);
  const pageItems = useMemo(
    () => items.slice((page - 1) * pageSize, page * pageSize),
    [items, page, pageSize],
  );
  return { pageItems, page, pageCount, pageSize, setPage, setPageSize };
}

export function Pager({
  page,
  pageCount,
  pageSize,
  total,
  onPage,
  onPageSize,
  unit = "条",
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  unit?: string;
}) {
  return (
    <div className="pager">
      <span className="muted small">
        共 {total} {unit} · 第 {page} / {pageCount} 页
      </span>
      <label className="pager-size">
        <span className="muted small">每页</span>
        <select
          className="field compact"
          aria-label="每页条数"
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
        >
          {[10, 20, 50, 100].map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <div className="pager-nav">
        <Button quiet disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ← 上一页
        </Button>
        <Button quiet disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
          下一页 →
        </Button>
      </div>
    </div>
  );
}
