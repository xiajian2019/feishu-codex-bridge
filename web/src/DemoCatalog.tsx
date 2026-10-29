import { useCallback, useEffect, useState, type ReactElement } from "react";
import { getActionToken, getJson } from "./api.js";
import { copyMobileText, isMobileApp, openMobileDemo } from "./mobile-runtime.js";

type DemoState = "checking" | "starting" | "ready" | "unavailable";

type LocalDemo = {
  id: string;
  title: string;
  category: string;
  description: string;
  steps: readonly string[];
  /** Pinned demos are shown before the regular sort order. */
  pinned?: boolean;
  sortOrder: number;
  openPath: string;
  healthPath: string;
  startPath: string;
  logsPath: string;
};

const LOCAL_DEMOS: LocalDemo[] = [
  {
    id: "food-photo",
    title: "食物拍照识别",
    category: "视觉识别 · FAST PATH",
    description: "YOLOE/Core ML 在本机分割一桌菜，按区域裁剪并输出可视化结果。",
    steps: ["上传图片", "识别分区", "检索确认"],
    pinned: true,
    sortOrder: 20,
    openPath: "/api/local-demos/food-photo/?scene=multidish",
    healthPath: "/api/local-demos/food-photo/api/multidish/health",
    startPath: "/api/local-demos/food-photo/start",
    logsPath: "/api/local-demos/food-photo/logs",
  },
  {
    id: "openai-clip",
    title: "OpenAI CLIP 食物检索",
    category: "视觉检索 · CLIP",
    description: "本地 OpenAI CLIP 编码图片，使用 SQLite-vec 检索食物文本向量并返回 Top-K 候选。",
    steps: ["上传图片", "SQLite 向量", "Top-K 候选"],
    sortOrder: 30,
    openPath: "/api/local-demos/openai-clip/",
    healthPath: "/api/local-demos/openai-clip/api/health",
    startPath: "/api/local-demos/openai-clip/start",
    logsPath: "/api/local-demos/openai-clip/logs",
  },
  {
    id: "sqlite-vec-admin",
    title: "SQLite-vec 索引管理",
    category: "数据管理 · DATASET",
    description: "通过 Datasette 浏览同一个 SQLite-vec 数据库、vec0 表和 SQL 查询；图片关联样本仍可从 CLIP Demo 查看。",
    steps: ["SQLite 表", "vec0 SQL", "关联图片"],
    sortOrder: 40,
    openPath: "/api/local-demos/sqlite-vec-admin/",
    healthPath: "/api/local-demos/sqlite-vec-admin/.json",
    startPath: "/api/local-demos/sqlite-vec-admin/start",
    logsPath: "/api/local-demos/sqlite-vec-admin/logs",
  },
  {
    id: "food-semantic-search",
    title: "食物实体与语义搜索",
    category: "文本检索 · QWEN EMBEDDING",
    description: "本地规则和 DeepSeek 可选解析，结合 Meilisearch 中文文本检索、千问 Embedding 与 SQLite-vec。",
    steps: ["输入食物描述", "Meilisearch 文本召回", "主体校验与混合检索"],
    pinned: true,
    sortOrder: 10,
    openPath: "/api/local-demos/food-semantic-search/",
    healthPath: "/api/local-demos/food-semantic-search/api/health",
    startPath: "/api/local-demos/food-semantic-search/start",
    logsPath: "/api/local-demos/food-semantic-search/logs",
  },
];

const ORDERED_LOCAL_DEMOS = [...LOCAL_DEMOS].sort((left, right) =>
  Number(right.pinned === true) - Number(left.pinned === true)
  || left.sortOrder - right.sortOrder
  || left.id.localeCompare(right.id),
);

const STATUS_LABELS: Record<DemoState, string> = {
  checking: "检查中",
  starting: "启动中",
  ready: "运行中",
  unavailable: "未启动",
};

export function DemoCatalog(): ReactElement {
  const [states, setStates] = useState<Record<string, DemoState>>(() =>
    Object.fromEntries(ORDERED_LOCAL_DEMOS.map((demo) => [demo.id, "checking"])),
  );
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [copyStates, setCopyStates] = useState<Record<string, "idle" | "copied" | "failed">>({});

  const loadLog = useCallback(async (demo: LocalDemo): Promise<{
    processRunning: boolean;
    exitCode: number | null;
    error: string | null;
    lines: string[];
    displayLines: string[];
  }> => {
    const result = await getJson<{
      root: string;
      workingDirectory: string;
      command: string[];
      processRunning: boolean;
      pid: number | null;
      exitCode: number | null;
      signal: string | null;
      error: string | null;
      lines: string[];
    }>(demo.logsPath);
    const displayLines = [
      `[root] ${result.root}`,
      `[cwd] ${result.workingDirectory}`,
      `[command] ${result.command.join(" ")}`,
      `[process] running=${result.processRunning} pid=${result.pid ?? "none"} exit=${result.exitCode ?? "none"} signal=${result.signal ?? "none"}`,
      result.error ? `[error] ${result.error}` : "",
      ...(result.lines ?? []),
    ].filter(Boolean);
    setLogs((current) => ({ ...current, [demo.id]: displayLines }));
    if (result.error) setErrors((current) => ({ ...current, [demo.id]: result.error as string }));
    return { ...result, displayLines };
  }, []);

  const copyLog = useCallback(async (demo: LocalDemo): Promise<void> => {
    try {
      const result = await loadLog(demo);
      const text = result.displayLines.join("\n") || "尚未启动，或暂时没有日志。";
      if (isMobileApp()) await copyMobileText(text);
      else try {
        await navigator.clipboard.writeText(text);
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        if (!document.execCommand("copy")) throw new Error("clipboard copy failed");
        textarea.remove();
      }
      setCopyStates((current) => ({ ...current, [demo.id]: "copied" }));
      window.setTimeout(() => setCopyStates((current) => ({ ...current, [demo.id]: "idle" })), 1800);
    } catch {
      setCopyStates((current) => ({ ...current, [demo.id]: "failed" }));
    }
  }, [loadLog]);

  const checkDemo = useCallback(async (demo: LocalDemo): Promise<void> => {
    setStates((current) => ({ ...current, [demo.id]: "checking" }));
    try {
      const response = await fetch(demo.healthPath, { cache: "no-store" });
      setStates((current) => ({ ...current, [demo.id]: response.ok ? "ready" : "unavailable" }));
    } catch {
      setStates((current) => ({ ...current, [demo.id]: "unavailable" }));
    }
    void loadLog(demo).catch(() => undefined);
  }, [loadLog]);

  const checkAll = useCallback((): void => {
    void Promise.all(ORDERED_LOCAL_DEMOS.map((demo) => checkDemo(demo)));
  }, [checkDemo]);

  const openDemoTab = useCallback((demo: LocalDemo, target?: Window | null): boolean => {
    if (isMobileApp()) {
      void openMobileDemo(demo.id, demo.openPath).catch((failure: unknown) => {
        setErrors((current) => ({ ...current, [demo.id]: failure instanceof Error ? failure.message : "无法打开系统浏览器。" }));
      });
      return true;
    }
    if (target && !target.closed) {
      target.location.replace(demo.openPath);
      return true;
    }
    const opened = window.open(demo.openPath, "_blank");
    if (!opened) {
      setErrors((current) => ({ ...current, [demo.id]: "浏览器阻止了新标签页，请允许弹窗后重试。" }));
      return false;
    }
    opened.opener = null;
    return true;
  }, []);

  const startDemo = useCallback(async (demo: LocalDemo): Promise<void> => {
    const demoTab = isMobileApp() ? null : window.open("about:blank", "_blank");
    if (demoTab) demoTab.opener = null;
    setStates((current) => ({ ...current, [demo.id]: "starting" }));
    try {
      const actionToken = await getActionToken();
      await getJson(demo.startPath, {
        method: "POST",
        headers: { "X-Bridge-Action-Token": actionToken },
        body: JSON.stringify({}),
      });
      setErrors((current) => {
        const next = { ...current };
        delete next[demo.id];
        return next;
      });
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const log = await loadLog(demo).catch(() => null);
        if (log?.error && !log.processRunning && log.exitCode !== null) {
          throw new Error(log.error);
        }
        try {
          const response = await fetch(demo.healthPath, { cache: "no-store" });
          if (response.ok) {
            setStates((current) => ({ ...current, [demo.id]: "ready" }));
            openDemoTab(demo, demoTab);
            return;
          }
        } catch {
          // The child process may still be installing dependencies or loading a model.
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      throw new Error("Demo 启动后未通过健康检查，请查看启动日志或刷新状态。");
    } catch (failure) {
      if (demoTab && !demoTab.closed) demoTab.close();
      setStates((current) => ({ ...current, [demo.id]: "unavailable" }));
      setErrors((current) => ({ ...current, [demo.id]: failure instanceof Error ? failure.message : String(failure) }));
      void loadLog(demo).catch(() => undefined);
    }
  }, [loadLog, openDemoTab]);

  useEffect(() => { checkAll(); }, [checkAll]);

  return <main className="page-main demo-catalog-page">
    <header className="demo-catalog-header">
      <div className="demo-catalog-title-row">
        <h1>Demo</h1>
        <div className="demo-catalog-header-actions">
          <span className="demo-catalog-count"><strong>{LOCAL_DEMOS.length}</strong> 个实验</span>
          <button type="button" onClick={checkAll}><span aria-hidden="true">↻</span>刷新状态</button>
        </div>
      </div>
      <p>本机视觉与模型实验，选择卡片即可开始体验。</p>
      {isMobileApp() ? <p>Demo 在系统浏览器打开，本次授权仅用于所选 Demo。</p> : null}
    </header>

    <section className="demo-catalog-grid" aria-label="Demo 列表">
      {ORDERED_LOCAL_DEMOS.map((demo) => {
        const state = states[demo.id] ?? "checking";
        const copyState = copyStates[demo.id] ?? "idle";
        const copyLabel = copyState === "copied" ? "日志已复制" : copyState === "failed" ? "复制日志失败" : "复制启动日志";
        return <article className="demo-card" key={demo.id}>
          <div className="demo-card-content">
            <div className="demo-card-topline">
              <span className="demo-card-category">{demo.category}</span>
              <span className={"demo-card-status is-" + state}><i aria-hidden="true" />{STATUS_LABELS[state]}</span>
            </div>
            <div className="demo-card-title-row">
              <h2>{demo.title}</h2>
              {demo.pinned ? <span className="demo-card-pinned">置顶</span> : null}
            </div>
            <p className="demo-card-description">{demo.description}</p>
            <div className="demo-card-flow" aria-label="处理流程">
              {demo.steps.map((step, index) => <div className="demo-card-flow-step" key={step}>
                <span className="demo-card-step-number">{String(index + 1).padStart(2, "0")}</span>
                <strong>{step}</strong>
              </div>)}
            </div>
            <div className="demo-card-footer">
              <div className="demo-card-actions">
                <button
                  className="primary"
                  type="button"
                  disabled={state === "checking" || state === "starting"}
                  onClick={() => {
                    if (state === "ready") openDemoTab(demo);
                    else void startDemo(demo);
                  }}
                >
                  {state === "ready" ? "打开 Demo" : state === "starting" ? "启动中…" : "启动并打开"}
                </button>
                <button type="button" onClick={() => void checkDemo(demo)}>检查状态</button>
              </div>
            </div>
            <details className="demo-card-log" open={state === "starting" || Boolean(errors[demo.id])}>
              <summary>启动日志{logs[demo.id]?.length ? `（${logs[demo.id].length} 行）` : ""}</summary>
              {errors[demo.id] ? <p className="demo-card-log-error">{errors[demo.id]}</p> : null}
              <div className="demo-card-log-viewer">
                <pre>{logs[demo.id]?.length ? logs[demo.id].join("\n") : "尚未启动，或暂时没有日志。"}</pre>
                <button
                  className={`demo-card-log-copy is-${copyState}`}
                  type="button"
                  onClick={() => void copyLog(demo)}
                  aria-label={copyLabel}
                  title={copyLabel}
                >
                  {copyState === "copied" ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>}
                </button>
              </div>
            </details>
          </div>
        </article>;
      })}
      <article className="demo-card demo-card-placeholder">
        <div className="demo-card-placeholder-visual">
          <span className="demo-card-placeholder-mark" aria-hidden="true">＋</span>
          <div><span>下一步</span><strong>接入新的 Demo</strong></div>
        </div>
        <div className="demo-card-placeholder-content">
          <h2>更多 Demo</h2>
          <p>后续接入的实验会展示在这里。</p>
        </div>
      </article>
    </section>
  </main>;
}
