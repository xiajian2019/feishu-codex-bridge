import { useCallback, useEffect, useState, type ReactElement } from "react";

type DemoState = "checking" | "ready" | "unavailable";

type LocalDemo = {
  id: string;
  title: string;
  category: string;
  description: string;
  steps: readonly string[];
  openPath: string;
  healthPath: string;
};

const LOCAL_DEMOS: LocalDemo[] = [
  {
    id: "food-photo",
    title: "食物拍照识别",
    category: "视觉识别 · FAST PATH",
    description: "YOLOE/Core ML 在本机分割一桌菜，按区域裁剪并输出可视化结果。",
    steps: ["上传图片", "识别分区", "检索确认"],
    openPath: "/api/local-demos/food-photo/?scene=multidish",
    healthPath: "/api/local-demos/food-photo/api/multidish/health",
  },
];

const STATUS_LABELS: Record<DemoState, string> = {
  checking: "检查中",
  ready: "运行中",
  unavailable: "未启动",
};

export function DemoCatalog(): ReactElement {
  const [states, setStates] = useState<Record<string, DemoState>>(() =>
    Object.fromEntries(LOCAL_DEMOS.map((demo) => [demo.id, "checking"])),
  );

  const checkDemo = useCallback(async (demo: LocalDemo): Promise<void> => {
    setStates((current) => ({ ...current, [demo.id]: "checking" }));
    try {
      const response = await fetch(demo.healthPath, { cache: "no-store" });
      setStates((current) => ({ ...current, [demo.id]: response.ok ? "ready" : "unavailable" }));
    } catch {
      setStates((current) => ({ ...current, [demo.id]: "unavailable" }));
    }
  }, []);

  const checkAll = useCallback((): void => {
    void Promise.all(LOCAL_DEMOS.map((demo) => checkDemo(demo)));
  }, [checkDemo]);

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
    </header>

    <section className="demo-catalog-grid" aria-label="Demo 列表">
      {LOCAL_DEMOS.map((demo) => {
        const state = states[demo.id] ?? "checking";
        return <article className="demo-card" key={demo.id}>
          <div className="demo-card-content">
            <div className="demo-card-topline">
              <span className="demo-card-category">{demo.category}</span>
              <span className={"demo-card-status is-" + state}><i aria-hidden="true" />{STATUS_LABELS[state]}</span>
            </div>
            <div className="demo-card-title-row"><h2>{demo.title}</h2></div>
            <p className="demo-card-description">{demo.description}</p>
            <div className="demo-card-flow" aria-label="处理流程">
              {demo.steps.map((step, index) => <div className="demo-card-flow-step" key={step}>
                <span className="demo-card-step-number">{String(index + 1).padStart(2, "0")}</span>
                <strong>{step}</strong>
              </div>)}
            </div>
            <div className="demo-card-footer">
              <div className="demo-card-actions">
                <a className="primary" href={demo.openPath}>打开 Demo</a>
                <button type="button" onClick={() => void checkDemo(demo)}>检查状态</button>
              </div>
            </div>
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
