import { useEffect, useMemo, useState, type FormEvent, type ReactElement } from "react";

import {
  createShortcut,
  createShortcutGroup,
  fetchShortcutConfig,
  updateShortcut,
  updateShortcutGroup,
} from "./api.js";
import { parseTerminalSequence, type ShortcutDefinition, type ShortcutGroup, type ShortcutKind, type ShortcutStore } from "./tmux-shortcuts.js";

type GroupDraft = {
  title: string;
  icon: string;
  description: string;
  layout: "grid" | "keyboard";
};

type ShortcutDraft = {
  groupId: string;
  title: string;
  detail: string;
  kind: ShortcutKind;
  value: string;
  enabled: boolean;
  dangerous: boolean;
};

const EMPTY_GROUP: GroupDraft = { title: "", icon: "⌘", description: "", layout: "grid" };
const EMPTY_SHORTCUT: ShortcutDraft = { groupId: "", title: "", detail: "", kind: "send", value: "", enabled: true, dangerous: false };

export function ShortcutManagement(): ReactElement {
  const [store, setStore] = useState<ShortcutStore>({ groups: [], shortcuts: [] });
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [groupDraft, setGroupDraft] = useState<GroupDraft>(EMPTY_GROUP);
  const [shortcutDraft, setShortcutDraft] = useState<ShortcutDraft>(EMPTY_SHORTCUT);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(null);
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [showShortcutForm, setShowShortcutForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchShortcutConfig();
      setStore(next);
      setSelectedGroupId((current) => current && next.groups.some((group) => group.id === current) ? current : next.groups[0]?.id ?? "");
      setShortcutDraft((current) => ({ ...current, groupId: current.groupId || next.groups[0]?.id || "" }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const groups = useMemo(
    () => store.groups.slice().sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)),
    [store.groups],
  );
  const visibleShortcuts = useMemo(
    () => store.shortcuts
      .filter((shortcut) => !selectedGroupId || shortcut.groupId === selectedGroupId)
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title)),
    [selectedGroupId, store.shortcuts],
  );

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await load();
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : String(operationError));
    } finally {
      setBusy(false);
    }
  };

  const saveGroup = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const input = { ...groupDraft, title: groupDraft.title.trim(), description: groupDraft.description.trim() };
    if (!input.title) return setError("分组名称不能为空。");
    await run(async () => {
      if (editingGroupId) await updateShortcutGroup(editingGroupId, input);
      else await createShortcutGroup(input);
      setGroupDraft(EMPTY_GROUP);
      setEditingGroupId(null);
      setShowGroupForm(false);
    });
  };

  const saveShortcut = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const input = { ...shortcutDraft, title: shortcutDraft.title.trim(), detail: shortcutDraft.detail.trim(), value: shortcutDraft.value.trim() };
    if (!input.groupId || !input.title || !input.value) return setError("请填写分组、名称和内容。");
    if (input.kind === "sequence" && !parseTerminalSequence(input.value)) return setError("控制键组合格式无效。");
    await run(async () => {
      if (editingShortcutId) await updateShortcut(editingShortcutId, input);
      else await createShortcut(input);
      setShortcutDraft({ ...EMPTY_SHORTCUT, groupId: input.groupId });
      setEditingShortcutId(null);
      setShowShortcutForm(false);
    });
  };

  const editGroup = (group: ShortcutGroup): void => {
    setEditingGroupId(group.id);
    setGroupDraft({ title: group.title, icon: group.icon, description: group.description, layout: group.layout });
    setShowGroupForm(true);
  };

  const editShortcut = (shortcut: ShortcutDefinition): void => {
    setEditingShortcutId(shortcut.id);
    setShortcutDraft({
      groupId: shortcut.groupId,
      title: shortcut.title,
      detail: shortcut.detail,
      kind: shortcut.kind,
      value: shortcut.value,
      enabled: shortcut.enabled,
      dangerous: shortcut.dangerous,
    });
    setShowShortcutForm(true);
  };

  const openShortcutForm = (groupId: string): void => {
    setEditingShortcutId(null);
    setShortcutDraft({ ...EMPTY_SHORTCUT, groupId });
    setShowShortcutForm(true);
  };

  const moveGroup = (group: ShortcutGroup, direction: -1 | 1): void => {
    const index = groups.findIndex((item) => item.id === group.id);
    const other = groups[index + direction];
    if (!other) return;
    void run(async () => {
      await Promise.all([
        updateShortcutGroup(group.id, { sortOrder: other.sortOrder }),
        updateShortcutGroup(other.id, { sortOrder: group.sortOrder }),
      ]);
    });
  };

  const toggleGroup = (group: ShortcutGroup): void => {
    void run(() => updateShortcutGroup(group.id, { enabled: !group.enabled }).then(() => undefined));
  };

  const toggleShortcut = (shortcut: ShortcutDefinition): void => {
    void run(() => updateShortcut(shortcut.id, { enabled: !shortcut.enabled }).then(() => undefined));
  };

  const moveShortcut = (shortcut: ShortcutDefinition, direction: -1 | 1): void => {
    const index = visibleShortcuts.findIndex((item) => item.id === shortcut.id);
    if (index < 0 || visibleShortcuts.length < 2) return;
    const targetIndex = direction < 0 ? 0 : visibleShortcuts.length - 1;
    if (index === targetIndex) return;
    const reordered = direction < 0
      ? [shortcut, ...visibleShortcuts.filter((item) => item.id !== shortcut.id)]
      : [...visibleShortcuts.filter((item) => item.id !== shortcut.id), shortcut];
    void run(async () => {
      await Promise.all(reordered.map((item, order) => updateShortcut(item.id, { sortOrder: order })));
    });
  };

  return (
    <main className="shortcut-management-page">
      <header className="shortcut-management-header">
        <h1>快捷键管理</h1>
        <button className="primary shortcut-management-refresh" type="button" onClick={() => void load()} disabled={loading || busy}>刷新配置</button>
      </header>
      {error ? <div className="shortcut-management-error" role="alert">{error}</div> : null}
      <div className="shortcut-management-layout">
        <section className="shortcut-management-card shortcut-group-card">
          <div className="shortcut-management-card-heading"><strong>分组</strong></div>
          <div className="shortcut-group-list">
            {groups.map((group, index) => (
              <article className={`shortcut-group-row${selectedGroupId === group.id ? " is-selected" : ""}${group.enabled ? "" : " is-disabled"}`} key={group.id}>
                <button className="shortcut-group-select" type="button" onClick={() => setSelectedGroupId(group.id)}>
                  <span className="shortcut-group-icon">{group.icon}</span>
                  <span><strong>{group.title}</strong></span>
                </button>
                <div className="shortcut-row-actions">
                  <button type="button" onClick={() => openShortcutForm(group.id)} disabled={busy} title={`新增${group.title}快捷键`} aria-label={`新增${group.title}快捷键`}>＋</button>
                  <button type="button" onClick={() => moveGroup(group, -1)} disabled={index === 0 || busy} aria-label="上移">↑</button>
                  <button type="button" onClick={() => moveGroup(group, 1)} disabled={index === groups.length - 1 || busy} aria-label="下移">↓</button>
                  <button type="button" onClick={() => toggleGroup(group)} disabled={busy} aria-label={group.enabled ? "停用分组" : "启用分组"}>{group.enabled ? "−" : "+"}</button>
                  <button type="button" onClick={() => editGroup(group)} disabled={busy} aria-label="编辑分组"><EditIcon /></button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="shortcut-management-card shortcut-list-card">
          <nav className="shortcut-group-tabs" aria-label="快捷键分组">
            {groups.map((group) => <button className={selectedGroupId === group.id ? "is-active" : ""} type="button" key={group.id} onClick={() => setSelectedGroupId(group.id)}>{group.icon} {group.title}</button>)}
          </nav>
          <div className="shortcut-list-table">
            {visibleShortcuts.map((shortcut) => (
              <article className={`shortcut-config-row${shortcut.enabled ? "" : " is-disabled"}`} key={shortcut.id}>
                <div className="shortcut-config-head"><div className="shortcut-config-main"><strong>{shortcut.title}</strong><span>{shortcut.detail || "无说明"} · {shortcut.kind}</span><div className="shortcut-config-value"><code>{shortcut.value}</code></div></div></div>
                <div className="shortcut-row-actions"><span className="shortcut-use-count" title="累计操作次数">{shortcut.operationCount} 次</span><button type="button" onClick={() => moveShortcut(shortcut, -1)} disabled={busy || visibleShortcuts.indexOf(shortcut) === 0} title="移到顶部" aria-label="移到顶部">↑</button><button type="button" onClick={() => moveShortcut(shortcut, 1)} disabled={busy || visibleShortcuts.indexOf(shortcut) === visibleShortcuts.length - 1} title="移到底部" aria-label="移到底部">↓</button><button type="button" onClick={() => toggleShortcut(shortcut)} disabled={busy} aria-label={shortcut.enabled ? "停用快捷键" : "启用快捷键"}>{shortcut.enabled ? "−" : "+"}</button><button type="button" onClick={() => editShortcut(shortcut)} disabled={busy} aria-label="编辑快捷键"><EditIcon /></button></div>
              </article>
            ))}
            {visibleShortcuts.length === 0 ? <p className="shortcut-management-empty">当前分组还没有快捷键。</p> : null}
          </div>
        </section>
      </div>

      {showGroupForm ? (
        <div className="shortcut-management-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowGroupForm(false); }}>
          <form className="shortcut-management-modal" onSubmit={(event) => void saveGroup(event)}>
            <h2>{editingGroupId ? "编辑分组" : "新建分组"}</h2>
            <label>名称<input value={groupDraft.title} onChange={(event) => setGroupDraft({ ...groupDraft, title: event.target.value })} maxLength={64} required /></label>
            <label>图标<input value={groupDraft.icon} onChange={(event) => setGroupDraft({ ...groupDraft, icon: event.target.value })} maxLength={8} required /></label>
            <label>说明<input value={groupDraft.description} onChange={(event) => setGroupDraft({ ...groupDraft, description: event.target.value })} maxLength={160} /></label>
            <label>布局<select value={groupDraft.layout} onChange={(event) => setGroupDraft({ ...groupDraft, layout: event.target.value as GroupDraft["layout"] })}><option value="grid">普通网格</option><option value="keyboard">键盘网格</option></select></label>
            <div className="shortcut-management-modal-actions"><button className="secondary" type="button" onClick={() => setShowGroupForm(false)}>取消</button><button className="primary" type="submit" disabled={busy}>保存</button></div>
          </form>
        </div>
      ) : null}

      {showShortcutForm ? (
        <div className="shortcut-management-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowShortcutForm(false); }}>
          <form className="shortcut-management-modal" onSubmit={(event) => void saveShortcut(event)}>
            <h2>{editingShortcutId ? "编辑快捷键" : "新建快捷键"}</h2>
            <label>所属分组<select value={shortcutDraft.groupId} onChange={(event) => setShortcutDraft({ ...shortcutDraft, groupId: event.target.value })}>{groups.map((group) => <option value={group.id} key={group.id}>{group.title}</option>)}</select></label>
            <label>显示文字<input value={shortcutDraft.title} onChange={(event) => setShortcutDraft({ ...shortcutDraft, title: event.target.value })} maxLength={64} required /></label>
            <label>说明文字<input value={shortcutDraft.detail} onChange={(event) => setShortcutDraft({ ...shortcutDraft, detail: event.target.value })} maxLength={120} /></label>
            <label>类型<select value={shortcutDraft.kind} onChange={(event) => setShortcutDraft({ ...shortcutDraft, kind: event.target.value as ShortcutKind })}><option value="send">发送文本</option><option value="sequence">控制键组合</option><option value="terminal">终端快捷键</option><option value="insert">插入文本</option></select></label>
            <label>{shortcutDraft.kind === "sequence" ? "控制键组合" : "发送内容"}<textarea value={shortcutDraft.value} onChange={(event) => setShortcutDraft({ ...shortcutDraft, value: event.target.value })} rows={4} maxLength={8000} required /></label>
            <label className="shortcut-check"><input type="checkbox" checked={shortcutDraft.enabled} onChange={(event) => setShortcutDraft({ ...shortcutDraft, enabled: event.target.checked })} /> 启用</label>
            <label className="shortcut-check"><input type="checkbox" checked={shortcutDraft.dangerous} onChange={(event) => setShortcutDraft({ ...shortcutDraft, dangerous: event.target.checked })} /> 标记为危险操作</label>
            <div className="shortcut-management-modal-actions"><button className="secondary" type="button" onClick={() => setShowShortcutForm(false)}>取消</button><button className="primary" type="submit" disabled={busy}>保存</button></div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

function EditIcon(): ReactElement {
  return <svg className="shortcut-edit-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.8-.8 3.9 3.9-.8L18.4 7.8a2.2 2.2 0 0 0 0-3.1l-.1-.1a2.2 2.2 0 0 0-3.1 0L4 16.8Zm9.8-10.1 4.3 4.3M4 20.7l3.6-3.6" /></svg>;
}
