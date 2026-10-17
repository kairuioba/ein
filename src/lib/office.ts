// 项目内协同办公的只读投影：GET /api/task-folders/:id/office。
// 所有状态由服务端从 dispatch 子任务/Handoff 推导；这里只负责取数与轮询。
import { useCallback, useEffect, useState } from "react";

import { api } from "@/state/store";

export interface OfficeWaiting {
  from: { botId?: string; name: string };
  to: { botId?: string; name: string };
  item: string;
  status: string;
  since?: number;
  minutes: number;
}

export interface OfficeMember {
  botId: string;
  name: string;
  title?: string;
  presence: "working" | "waiting" | "reviewing" | "blocked" | "idle";
  current?: string;
  waitingOn?: string;
}

export interface OfficeAnomaly {
  subtaskId: string;
  title: string;
  kind: "failed" | "needs_human" | "rework" | "stalled";
  detail: string;
}

export interface ProjectOffice {
  project: {
    id: string;
    title: string;
    status: string;
    goal?: string;
    leadName?: string;
    progress: { done: number; total: number };
    closedAt?: number;
  };
  departments: Array<{ name: string; members: OfficeMember[] }>;
  now: { waiting: OfficeWaiting[] };
  decisions: Array<{ id: string; kind: string; title: string; reason: string; risk?: string; attemptId?: string }>;
  activity: Array<{ at: number; kind: string; actor: string; summary: string }>;
  anomalies: OfficeAnomaly[];
}

/** 页面需要的轮询状态：数据 + 首屏加载 / 最近一次失败 / 刷新时间。 */
export interface ProjectOfficeLive {
  office: ProjectOffice | null;
  /** 首份快照还没到（之后的轮询失败不算 loading，数据照旧显示）。 */
  loading: boolean;
  /** 最近一次轮询失败；`office` 仍是上一份成功数据。 */
  error: string | null;
  /** 当前快照到达时间（ms），0 = 还没有快照。 */
  updatedAt: number;
  /** 立刻重新拉取（拍板成功后调用）。 */
  refresh: () => void;
}

/**
 * 轮询项目协同工作台。失败时**保留上一份数据**（不能把失败当成「一切正常」
 * 的清空），首屏加载与失败分别用 loading/error 表示，交给页面渲染。
 * 只在页面可见时轮询；`folderId` 为空时不发请求。
 */
export function useProjectOfficeLive(folderId: string | undefined, intervalMs = 5000): ProjectOfficeLive {
  const [state, setState] = useState<{
    office: ProjectOffice | null;
    loading: boolean;
    error: string | null;
    updatedAt: number;
  }>(() => ({ office: null, loading: Boolean(folderId), error: null, updatedAt: 0 }));
  // 手动刷新：触发一次立即拉取（同时重排轮询计时器）
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!folderId) {
      setState({ office: null, loading: false, error: null, updatedAt: 0 });
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const next = (await api(`/api/task-folders/${folderId}/office`)) as { office?: ProjectOffice };
        if (!alive) return;
        setState({ office: next.office ?? null, loading: false, error: null, updatedAt: Date.now() });
      } catch (cause) {
        if (!alive) return;
        // a failed poll must not wipe the last snapshot (that would flip the
        // page to a fake green "all clear") — keep what we had and say so
        setState((prev) => ({
          ...prev,
          loading: false,
          error: cause instanceof Error && cause.message ? cause.message : String(cause),
        }));
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, intervalMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [folderId, intervalMs, nonce]);

  return { ...state, refresh };
}

/** 旧调用方要的只是数据本身；语义与之前一致（首页 null，失败保留上次）。 */
export function useProjectOffice(folderId: string | undefined, intervalMs = 5000) {
  return useProjectOfficeLive(folderId, intervalMs).office;
}

/** 一句话结论的色调：muted 只用于「还没数据 / 加载失败」，绝不是正常。 */
export type OfficeConclusionTone = "muted" | "danger" | "warning" | "ok";

/**
 * 页面顶部一句话结论，优先级：等你拍板 > 异常 > 有人被卡 ≥15 分钟 > 正常。
 * 没有快照时绝不返回 ok（加载中/失败都是 muted）：老板不能看到假的绿色结论。
 */
export type OfficeConclusion =
  | { tone: "muted"; kind: "loading" }
  | { tone: "muted"; kind: "error" }
  | { tone: "danger"; kind: "decisions"; count: number }
  | { tone: "warning"; kind: "anomalies"; count: number }
  | { tone: "warning"; kind: "blocked"; minutes: number }
  | { tone: "ok"; kind: "clear" };

export function officeConclusion(
  office: ProjectOffice | null,
  state: { loading?: boolean; error?: string | null } = {},
): OfficeConclusion {
  if (!office) {
    // 没数据 ≠ 一切正常：只有真的拿到快照才允许 ok
    return state.error ? { tone: "muted", kind: "error" } : { tone: "muted", kind: "loading" };
  }
  const decisions = office.decisions?.length ?? 0;
  if (decisions > 0) return { tone: "danger", kind: "decisions", count: decisions };
  const anomalies = office.anomalies?.length ?? 0;
  if (anomalies > 0) return { tone: "warning", kind: "anomalies", count: anomalies };
  const oldest = (office.now?.waiting ?? []).reduce(
    (max, entry) => Math.max(max, Number.isFinite(entry.minutes) ? entry.minutes : 0),
    0,
  );
  if (oldest >= 15) return { tone: "warning", kind: "blocked", minutes: Math.round(oldest) };
  return { tone: "ok", kind: "clear" };
}

/** 等待时长的紧凑格式：`6m` / `2h 12m`。不足一分钟按 1m 显示（与旧面板一致）。 */
export function formatWaitMinutes(minutes: number): string {
  const total = Math.max(1, Math.round(Number.isFinite(minutes) ? minutes : 0));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours}h${rest ? ` ${rest}m` : ""}` : `${total}m`;
}
