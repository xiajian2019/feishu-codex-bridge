import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";

import {
  createShortcut,
  createShortcutGroup,
  fetchCodexSkills,
  fetchShortcutConfig,
  moveShortcutToEdge,
  updateCodexSkillPreferences,
  updateShortcut,
  updateShortcutGroup,
  type CodexSkillRecord,
} from "./api.js";
import { COMPOSER_ACTION_OPTIONS, parseTerminalSequence, type ShortcutDefinition, type ShortcutDisplayMode, type ShortcutGroup, type ShortcutKind, type ShortcutStore, type ShortcutSurface } from "./tmux-shortcuts.js";
import { readShortcutConfigCache, subscribeShortcutConfigInvalidation } from "./shortcut-config-cache.js";

type GroupDraft = {
  title: string;
  icon: string;
  description: string;
  surface: ShortcutSurface;
  layout: "grid" | "keyboard";
};

type ShortcutDraft = {
  groupId: string;
  title: string;
  detail: string;
  kind: ShortcutKind;
  value: string;
  actionKey: string;
  displayMode: ShortcutDisplayMode;
  enabled: boolean;
  dangerous: boolean;
};

const EMPTY_GROUP: GroupDraft = { title: "", icon: "⌘", description: "", surface: "palette", layout: "grid" };
const EMPTY_SHORTCUT: ShortcutDraft = { groupId: "", title: "", detail: "", kind: "send", value: "", actionKey: "", displayMode: "closed", enabled: true, dangerous: false };

import { useMobileBack } from "./use-mobile-back.js";

export function ShortcutManagement(): ReactElement {
  const [store, setStore] = useState<ShortcutStore>(() => readShortcutConfigCache() ?? { groups: [], shortcuts: [] });
  const [skillCatalog, setSkillCatalog] = useState<CodexSkillRecord[]>([]);
  const [managementView, setManagementView] = useState<"shortcuts" | "skills">("shortcuts");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [groupDraft, setGroupDraft] = useState<GroupDraft>(EMPTY_GROUP);
  const [shortcutDraft, setShortcutDraft] = useState<ShortcutDraft>(EMPTY_SHORTCUT);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(null);
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [showShortcutForm, setShowShortcutForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsLoadError, setSkillsLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useMobileBack(showGroupForm, () => { if (!busy) setShowGroupForm(false); }, 80);
  useMobileBack(showShortcutForm, () => { if (!busy) setShowShortcutForm(false); }, 80);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const load = async (force = false): Promise<void> => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setSkillsLoading(true);
    setError(null);
    try {
      const [shortcutResult, skillResult] = await Promise.allSettled([fetchShortcutConfig({ force }), fetchCodexSkills({ force })]);
      if (generation !== loadGeneration.current) return;
      if (shortcutResult.status === "fulfilled") {
        const next = shortcutResult.value;
        setStore(next);
        setSelectedGroupId((current) => current && next.groups.some((group) => group.id === current) ? current : next.groups[0]?.id ?? "");
        setShortcutDraft((current) => ({ ...current, groupId: current.groupId || next.groups[0]?.id || "" }));
      } else {
        setError(shortcutResult.reason instanceof Error ? shortcutResult.reason.message : String(shortcutResult.reason));
      }
      if (skillResult.status === "fulfilled") {
        setSkillCatalog(skillResult.value);
        setSkillsLoadError(null);
      } else {
        setSkillsLoadError(skillResult.reason instanceof Error ? skillResult.reason.message : String(skillResult.reason));
      }
    } catch (loadError) {
      if (generation !== loadGeneration.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false);
        setSkillsLoading(false);
      }
    }
  };

  useEffect(() => {
    void load();
    const unsubscribeLocal = subscribeShortcutConfigInvalidation(() => {
      setStore(readShortcutConfigCache() ?? { groups: [], shortcuts: [] });
      void load();
    }, false);
    return unsubscribeLocal;
  }, []);

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
  const orderedSkills = useMemo(
    () => skillCatalog.slice().sort((left, right) => Number(right.pinned) - Number(left.pinned)
      || left.sortOrder - right.sortOrder
      || left.skillName.localeCompare(right.skillName)),
    [skillCatalog],
  );

  const run = async (operation: () => Promise<void>, reload = true): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      if (reload) await load();
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
    const group = groups.find((item) => item.id === input.groupId);
    const isComposerShortcut = group?.surface === "composer";
    if (!input.groupId || !input.title || (!isComposerShortcut && !input.value) || (isComposerShortcut && !input.actionKey)) return setError(isComposerShortcut ? "请填写分组、名称和动作。" : "请填写分组、名称和内容。");
    if (!isComposerShortcut && input.kind === "sequence" && !parseTerminalSequence(input.value)) return setError("控制键组合格式无效。");
    const shortcutInput = {
      ...input,
      value: isComposerShortcut ? "" : input.value,
      actionKey: isComposerShortcut ? input.actionKey : undefined,
      displayMode: isComposerShortcut ? input.displayMode : undefined,
    };
    await run(async () => {
      if (editingShortcutId) await updateShortcut(editingShortcutId, shortcutInput);
      else await createShortcut(shortcutInput);
      setShortcutDraft({ ...EMPTY_SHORTCUT, groupId: input.groupId });
      setEditingShortcutId(null);
      setShowShortcutForm(false);
    });
  };

  const editGroup = (group: ShortcutGroup): void => {
    setEditingGroupId(group.id);
    setGroupDraft({ title: group.title, icon: group.icon, description: group.description, surface: group.surface, layout: group.layout });
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
      actionKey: shortcut.actionKey ?? "",
      displayMode: shortcut.displayMode,
      enabled: shortcut.enabled,
      dangerous: shortcut.dangerous,
    });
    setShowShortcutForm(true);
  };

  const openShortcutForm = (groupId: string): void => {
    setEditingShortcutId(null);
    const group = groups.find((item) => item.id === groupId);
    setShortcutDraft({ ...EMPTY_SHORTCUT, groupId, kind: group?.surface === "composer" ? "insert" : "send" });
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
    void run(async () => {
      const updated = await moveShortcutToEdge(shortcut.id, direction < 0 ? "start" : "end");
      setStore((current) => ({
        ...current,
        shortcuts: current.shortcuts.map((item) => item.id === updated.id ? updated : item),
      }));
    }, false);
  };

  const saveSkillOrder = (skills: CodexSkillRecord[]): void => {
    const ordered = skills.map((skill, sortOrder) => ({ ...skill, sortOrder }));
    void run(async () => {
      await updateCodexSkillPreferences(ordered.map(({ skillName, pinned, sortOrder }) => ({ skillName, pinned, sortOrder })));
      setSkillCatalog(ordered);
    }, false);
  };

  const moveSkill = (skill: CodexSkillRecord, direction: -1 | 1): void => {
    const index = orderedSkills.findIndex((item) => item.skillName === skill.skillName);
    const targetIndex = index + direction;
    const neighbor = orderedSkills[targetIndex];
    if (index < 0 || !neighbor || neighbor.pinned !== skill.pinned) return;
    const next = orderedSkills.slice();
    [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
    saveSkillOrder(next);
  };

  const toggleSkillPinned = (skill: CodexSkillRecord): void => {
    const remaining = orderedSkills.filter((item) => item.skillName !== skill.skillName);
    const toggled = { ...skill, pinned: !skill.pinned };
    const pinned = remaining.filter((item) => item.pinned);
    const unpinned = remaining.filter((item) => !item.pinned);
    const next = skill.pinned
      ? [...pinned, ...unpinned, toggled]
      : [toggled, ...pinned, ...unpinned];
    saveSkillOrder(next);
  };

  return (
    <main className="shortcut-management-page">
      <header className="shortcut-management-header">
        <h1>快捷键与技能管理</h1>
        <button className="primary shortcut-management-refresh" type="button" onClick={() => void load(true)} disabled={loading || busy}>刷新配置</button>
      </header>
      {error ? <div className="shortcut-management-error" role="alert">{error}</div> : null}
      <div className={`shortcut-management-layout${managementView === "skills" ? " is-skill-view" : ""}`}>
        {managementView === "shortcuts" ? (
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
        ) : null}

        <section className="shortcut-management-card shortcut-list-card">
          <nav className="shortcut-group-tabs" aria-label="管理内容">
            <button className={managementView === "shortcuts" ? "is-active" : ""} type="button" onClick={() => setManagementView("shortcuts")}>快捷键</button>
            <button className={managementView === "skills" ? "is-active" : ""} type="button" onClick={() => setManagementView("skills")}>技能排序 · {orderedSkills.length}</button>
          </nav>
          {managementView === "shortcuts" ? (
            <>
              <nav className="shortcut-group-tabs" aria-label="快捷键分组">
                {groups.map((group) => <button className={selectedGroupId === group.id ? "is-active" : ""} type="button" key={group.id} onClick={() => setSelectedGroupId(group.id)}>{group.icon} {group.title}</button>)}
              </nav>
              <div className="shortcut-list-table">
                {visibleShortcuts.map((shortcut) => {
                  const isComposerAction = groups.find((group) => group.id === shortcut.groupId)?.surface === "composer";
                  const displayPosition = shortcut.displayMode === "closed" ? "收起时显示"
                    : shortcut.displayMode === "expanded" ? "展开时显示" : "始终显示";
                  return (
                    <article className={`shortcut-config-row${shortcut.enabled ? "" : " is-disabled"}`} key={shortcut.id}>
                      <div className="shortcut-config-head"><div className="shortcut-config-main"><strong>{shortcut.title}</strong><span>{shortcut.detail || "无说明"} · {shortcut.kind}{isComposerAction ? " · " + displayPosition : ""}</span><div className="shortcut-config-value"><code>{shortcut.value}</code></div></div></div>
                      <div className="shortcut-row-actions"><span className="shortcut-use-count" title="累计操作次数">{shortcut.operationCount} 次</span><button type="button" onClick={() => moveShortcut(shortcut, -1)} disabled={busy || visibleShortcuts.indexOf(shortcut) === 0} title="移到顶部" aria-label="移到顶部">↑</button><button type="button" onClick={() => moveShortcut(shortcut, 1)} disabled={busy || visibleShortcuts.indexOf(shortcut) === visibleShortcuts.length - 1} title="移到底部" aria-label="移到底部">↓</button><button type="button" onClick={() => toggleShortcut(shortcut)} disabled={busy} aria-label={shortcut.enabled ? "停用快捷键" : "启用快捷键"}>{shortcut.enabled ? "−" : "+"}</button><button type="button" onClick={() => editShortcut(shortcut)} disabled={busy} aria-label="编辑快捷键"><EditIcon /></button></div>
                    </article>
                  );
                })}
                {visibleShortcuts.length === 0 ? <p className="shortcut-management-empty">当前分组还没有快捷键。</p> : null}
              </div>
            </>
          ) : (
            <>
              <p className="shortcut-skill-management-hint">置顶技能会排在列表前面；其余技能按下方顺序显示，技能选择器无需输入文字也能直接选用。</p>
              {skillsLoadError ? <p className="shortcut-management-empty is-error" role="alert">{skillsLoadError}</p> : null}
              {skillsLoading ? <p className="shortcut-management-empty">正在读取技能…</p> : null}
              {!skillsLoading && !skillsLoadError && orderedSkills.length === 0 ? <p className="shortcut-management-empty">尚未同步技能。打开任意 Session 的技能选择器后，这里会显示该 Session 可用的技能。</p> : null}
              <div className="shortcut-list-table">
                {orderedSkills.map((skill, index) => {
                  const sourceLabel = skill.scope === "project" ? "项目" : skill.scope === "codex_home" ? "Codex Home" : skill.scope === "user" ? "用户" : skill.scope === "plugin" ? "插件" : "系统";
                  return (
                    <article className="shortcut-config-row is-skill-row" key={skill.skillName}>
                      <div className="shortcut-config-head"><div className="shortcut-config-main"><strong>{skill.nameZh || skill.skillName}{skill.pinned ? <em className="shortcut-skill-pinned">置顶</em> : null}</strong><span>{skill.skillName} · {sourceLabel}{skill.nameEn && skill.nameEn !== skill.nameZh ? " · " + skill.nameEn : ""}</span><p>{skill.descriptionZh || skill.descriptionEn || "无说明"}</p></div></div>
                      <div className="shortcut-row-actions">
                        <button className={skill.pinned ? "is-skill-pinned" : ""} type="button" onClick={() => toggleSkillPinned(skill)} disabled={busy} title={skill.pinned ? "取消置顶" : "置顶技能"} aria-label={skill.pinned ? "取消置顶" : "置顶技能"} aria-pressed={skill.pinned}><PinIcon /></button>
                        <button type="button" onClick={() => moveSkill(skill, -1)} disabled={busy || index === 0 || orderedSkills[index - 1]?.pinned !== skill.pinned} title="上移" aria-label="上移">↑</button>
                        <button type="button" onClick={() => moveSkill(skill, 1)} disabled={busy || index === orderedSkills.length - 1 || orderedSkills[index + 1]?.pinned !== skill.pinned} title="下移" aria-label="下移">↓</button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </div>

      {showGroupForm ? (
        <div className="shortcut-management-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowGroupForm(false); }}>
          <form className="shortcut-management-modal" onSubmit={(event) => void saveGroup(event)}>
            <h2>{editingGroupId ? "编辑分组" : "新建分组"}</h2>
            <label>名称<input value={groupDraft.title} onChange={(event) => setGroupDraft({ ...groupDraft, title: event.target.value })} maxLength={64} required /></label>
            <label>图标<input value={groupDraft.icon} onChange={(event) => setGroupDraft({ ...groupDraft, icon: event.target.value })} maxLength={8} required /></label>
            <label>说明<input value={groupDraft.description} onChange={(event) => setGroupDraft({ ...groupDraft, description: event.target.value })} maxLength={160} /></label>
            <label>作用位置<select value={groupDraft.surface} onChange={(event) => setGroupDraft({ ...groupDraft, surface: event.target.value as ShortcutSurface })}><option value="palette">快捷键面板</option><option value="composer">输入框快捷栏</option></select></label>
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
            {groups.find((group) => group.id === shortcutDraft.groupId)?.surface === "composer" ? (
              <>
                <label>输入框动作<select value={shortcutDraft.actionKey} onChange={(event) => setShortcutDraft({ ...shortcutDraft, actionKey: event.target.value })} required><option value="">请选择动作</option>{COMPOSER_ACTION_OPTIONS.map((action) => <option value={action.key} key={action.key}>{action.label}</option>)}</select></label>
                <label>显示位置<select value={shortcutDraft.displayMode} onChange={(event) => setShortcutDraft({ ...shortcutDraft, displayMode: event.target.value as ShortcutDisplayMode })}><option value="closed">快捷栏收起时</option><option value="expanded">快捷栏展开时</option><option value="both">两种状态都显示</option></select></label>
              </>
            ) : (
              <>
                <label>类型<select value={shortcutDraft.kind} onChange={(event) => setShortcutDraft({ ...shortcutDraft, kind: event.target.value as ShortcutKind })}><option value="send">发送文本</option><option value="sequence">控制键组合</option><option value="terminal">终端快捷键</option><option value="insert">插入文本</option></select></label>
                <label>{shortcutDraft.kind === "sequence" ? "控制键组合" : "发送内容"}<textarea value={shortcutDraft.value} onChange={(event) => setShortcutDraft({ ...shortcutDraft, value: event.target.value })} rows={4} maxLength={8000} required /></label>
              </>
            )}
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

function PinIcon(): ReactElement {
  return <svg className="shortcut-skill-pin-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 3 6 6-3.5 1-3 3v4l-2 1-2-5-6 6 6-8-4-2 1-2h4l3-3z" /><path d="m11 13-7 7" /></svg>;
}
