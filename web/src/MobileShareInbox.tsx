import { useEffect, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router";
import { fetchCodexHistory, fetchProjects, getJson } from "./api.js";
import { bridgeFeatureUnavailable } from "./client-capabilities.js";
import { loadCodexHistoryDraft, saveCodexHistoryDraft } from "./codex-history-draft-store.js";
import { getLocalDraftScope } from "./local-draft-scope.js";
import { appendMobileShareText, assertMobileShareContext, type MobileShare } from "./mobile-handoff.js";
import { checkMobileConnection, getMobileConnection, initializeMobileRuntime, listMobileShares, readMobileShareFiles } from "./mobile-runtime.js";
import { loadTaskCreateDraft } from "./task-create-draft-store.js";
import { loadDraftAttachment, loadDraftMetadata, saveDraftAttachment, saveDraftMetadata } from "./tmux-draft-store.js";
import type { CodexHistoryItem, ProjectRecord } from "./types.js";

type ShareTarget = { id: string; label: string; kind: "task"; project: string }
  | { id: string; label: string; kind: "tmux"; sessionId: string; createdAt: string | number }
  | { id: string; label: string; kind: "history"; homeId: string; threadId: string };

export function MobileShareInbox(): ReactElement {
  const navigate = useNavigate();
  const [shares, setShares] = useState<MobileShare[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [targetId, setTargetId] = useState("");
  const [targets, setTargets] = useState<ShareTarget[]>([]);
  const [targetContext, setTargetContext] = useState<{ scope: string; server: string } | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const share = shares.find((item) => item.id === selected);
  useEffect(() => {
    let active = true;
    void initializeMobileRuntime().then(listMobileShares).then((items) => { if (active) { setShares(items); setLoaded(true); } })
      .catch((cause: unknown) => { if (active) { setError(cause instanceof Error ? cause.message : "分享收件箱不可用。"); setLoaded(true); } });
    return () => { active = false; };
  }, [revision]);

  async function loadTargets(): Promise<void> {
    setBusy(true); setError("");
    try {
      if (!await checkMobileConnection() || !getLocalDraftScope()) throw new Error("请先连接支持设备作用域的 Bridge，再选择导入目标。本机分享内容会保留。");
      const scope = getLocalDraftScope();
      const server = getMobileConnection()?.server;
      const results = await Promise.allSettled([
        fetchProjects(),
        bridgeFeatureUnavailable("tmux") ? Promise.resolve({ sessions: [] }) : getJson<{ sessions: Array<{ id: string; name: string; windows: number; endedAt?: string | null; suspendedAt?: string | null; createdAt: string | number }> }>("/tmux-dashboard/api/sessions?includeHomes=0"),
        bridgeFeatureUnavailable("codex-history") ? Promise.resolve({ items: [] }) : fetchCodexHistory({ archived: "active", limit: 20, offset: 0 }),
      ]);
      if (!scope || !server || scope !== getLocalDraftScope() || server !== getMobileConnection()?.server) throw new Error("环境或设备已变化，请重新读取目标。");
      const next: ShareTarget[] = [];
      if (results[0].status === "fulfilled") for (const project of results[0].value as ProjectRecord[]) {
        if (project.status !== "disabled" && project.available) next.push({ kind: "task", id: "task:" + project.name, project: project.name, label: "新任务 · " + project.name });
      }
      if (results[1].status === "fulfilled") for (const session of results[1].value.sessions) {
        if (session.windows > 0 && !session.endedAt && !session.suspendedAt && session.createdAt !== undefined) next.push({ kind: "tmux", id: "tmux:" + session.id, sessionId: session.id, createdAt: session.createdAt, label: "Tmux · " + session.name });
      }
      if (results[2].status === "fulfilled") for (const item of results[2].value.items as CodexHistoryItem[]) {
        next.push({ kind: "history", id: "history:" + JSON.stringify([item.home.id, item.thread.id]), homeId: item.home.id, threadId: item.thread.id,
          label: "最近 History · " + (item.thread.name || item.thread.preview || item.thread.id) });
      }
      setTargets(next); setTargetId(""); setTargetContext({ scope, server });
      const failures = results.filter((item) => item.status === "rejected");
      if (failures.length) setError("部分目标读取失败，已保留其余可用目标；可重试。History 仅列出最近 20 条，不是全量搜索。");
      else if (!next.length) setError("当前没有可用项目或会话，可先在原页面创建后重新读取。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取目标。"); }
    finally { setBusy(false); }
  }

  async function importDraft(): Promise<void> {
    const target = targets.find((item) => item.id === targetId);
    const scope = getLocalDraftScope();
    const server = getMobileConnection()?.server;
    if (!share || !target || !scope || !server || busy) return;
    setBusy(true); setError("");
    const assertScope = (): void => {
      assertMobileShareContext(targetContext, { scope: getLocalDraftScope(), server: getMobileConnection()?.server });
      assertMobileShareContext({ scope, server }, { scope: getLocalDraftScope(), server: getMobileConnection()?.server });
    };
    const assertSession = async (): Promise<void> => {
      if (target.kind !== "tmux") return;
      const snapshot = await getJson<{ sessions: Array<{ id: string; createdAt: string | number; windows: number; endedAt?: string | null; suspendedAt?: string | null }> }>("/tmux-dashboard/api/sessions?includeHomes=0");
      assertScope();
      if (!snapshot.sessions.some((item) => item.id === target.sessionId && String(item.createdAt) === String(target.createdAt) && item.windows > 0 && !item.endedAt && !item.suspendedAt)) throw new Error("目标 Session 已结束、挂起或重建，请重新读取目标；原分享仍保留。");
    };
    try {
      assertScope();
      await assertSession();
      if (target.kind === "task") {
        const previous = loadTaskCreateDraft(target.project);
        const description = appendMobileShareText(previous?.description ?? "", text);
        if (description.length > 20_000) throw new Error("此目标任务草稿超过现有 20,000 字符限制，原分享仍保留，可选择其他目标或调整草稿。");
        assertScope();
        navigate("/", { state: { newTaskDraft: { source: "task", projectKey: target.project, description: description || "请结合分享的附件处理。" },
          mobileShareImport: { id: share.id, project: target.project, scope, server } } });
        return;
      }
      const files = await readMobileShareFiles(share); assertScope();
      if (target.kind === "tmux") {
        const previous = loadDraftMetadata(target.sessionId);
        const attachments = [...previous?.attachments ?? []];
        for (let index = 0; index < files.length; index++) {
          const id = "share-" + share.id + "-" + share.files[index]!.id;
          if (attachments.some((item) => item.id === id)) continue;
          await saveDraftAttachment(target.sessionId, id, files[index]!); assertScope();
          if (!await loadDraftAttachment(target.sessionId, id)) throw new Error("附件未能持久保存到草稿，请检查本机空间；原分享仍保留。");
          assertScope();
          attachments.push({ id, name: files[index]!.name, contentType: files[index]!.type, size: files[index]!.size, lastModified: files[index]!.lastModified });
        }
        const current = previous?.text ?? "";
        const next = text.trim() && current.includes(text.trim()) ? current : appendMobileShareText(current, text);
        await assertSession();
        saveDraftMetadata(target.sessionId, { text: next, attachments }, scope);
        if (loadDraftMetadata(target.sessionId)?.text !== next) throw new Error("文本草稿未能保存，原分享仍保留。");
        navigate("/tmux-dashboard?session=" + encodeURIComponent(target.sessionId));
      } else {
        const key = `${scope}|${JSON.stringify([target.homeId, target.threadId])}`;
        const previous = await loadCodexHistoryDraft(key); assertScope();
        const merged = [...previous.files];
        for (let index = 0; index < files.length; index++) {
          const id = "share-" + share.id + "-" + share.files[index]!.id;
          if (!merged.some((item) => item.id === id)) merged.push({ id, file: files[index]! });
        }
        if (merged.length > 10 || merged.some((item) => item.file.size > 25 * 1024 * 1024)) throw new Error("History 沿用现有 10 个附件、每个 25 MiB 的限制；可改选 Tmux，分享内容不会删除。");
        const current = previous.draft?.text ?? "";
        const next = text.trim() && current.includes(text.trim()) ? current : appendMobileShareText(current, text);
        if (next.length > 8000) throw new Error("History 草稿超过现有 8,000 字符限制，可改选 Tmux，原分享仍保留。");
        await saveCodexHistoryDraft(key, next, merged); assertScope();
        const saved = await loadCodexHistoryDraft(key); assertScope();
        if (saved.draft?.text !== next || saved.files.length !== merged.length) throw new Error("草稿未能完整持久保存，原分享仍保留，请重试。");
        navigate(`/codex-history/${encodeURIComponent(target.homeId)}/${encodeURIComponent(target.threadId)}`);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "导入失败，原分享仍保留。"); }
    finally { setBusy(false); }
  }

  return <main className="page-main mobile-share-page">
    <header className="workbench-page-header"><div><h1>分享收件箱</h1><p>内容保存在本机。选择目标后只加入草稿，不自动发送；原分享继续保留。</p></div><Link to="/">返回工作页</Link></header>
    <button type="button" disabled={busy} onClick={() => setRevision((value) => value + 1)}>刷新本机分享</button>
    <button type="button" disabled={busy} onClick={() => navigate("/", { state: { mobileOpenConnectionSettings: true } })}>连接管理</button>
    {error ? <p className="workbench-page-error" role="alert">{error}</p> : null}
    {!loaded ? <p role="status">正在读取本机分享…</p> : !shares.length ? <p>从相册、浏览器或文件管理器选择“分享 → Bridge”，内容会出现在这里。</p> : null}
    {shares.map((item) => <article className="mobile-share-card" key={item.id}>
      <strong>{item.title || "手机分享"}</strong><small> · {new Date(item.createdAt).toLocaleString()}</small>
      {item.text ? <pre>{item.text}</pre> : null}
      <ul>{item.files.map((file) => <li key={file.id}>{file.name} · {(file.size / 1024).toFixed(1)} KiB</li>)}</ul>
      {item.error ? <p role="alert">{item.error}</p> : null}
      <button type="button" disabled={busy} onClick={() => { setSelected(item.id); setText(item.text); setError(""); void loadTargets(); }}>选择导入目标</button>
      {share?.id === item.id ? <div className="mobile-share-target">
        <label>当前目标环境<span>{getMobileConnection()?.server ?? "未连接"}</span></label>
        <label>目标项目或会话<select value={targetId} onChange={(event) => setTargetId(event.target.value)} disabled={busy}><option value="">请选择</option>{targets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}</select></label>
        <label>补充说明<textarea rows={5} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} /></label>
        <button type="button" disabled={busy || !targetId} onClick={() => void importDraft()}>{busy ? "处理中…" : "加入目标草稿"}</button>
        <button type="button" disabled={busy} onClick={() => void loadTargets()}>重读目标</button>
      </div> : null}
    </article>)}
  </main>;
}
