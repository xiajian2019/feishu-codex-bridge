import { useEffect, useMemo, useState, type ReactElement } from "react";

import {
  makeShortcutId,
  parseTerminalSequence,
  SHORTCUT_PANEL_META,
  SHORTCUT_PANEL_ORDER,
  type ShortcutCategory,
  type ShortcutDefinition,
  type ShortcutPanelId,
  type ShortcutStore,
  type TerminalShortcut,
} from "./tmux-shortcuts.js";

export type PaletteCategory = ShortcutCategory;
type SubmissionResult = { ok: boolean; message?: string };

type TmuxShortcutPaletteProps = {
  open: boolean;
  category: PaletteCategory;
  store: ShortcutStore;
  onOpenChange: (open: boolean) => void;
  onCategoryChange: (category: PaletteCategory) => void;
  onStoreChange: (store: ShortcutStore) => void;
  onSubmitText: (text: string) => Promise<SubmissionResult>;
  onTerminalShortcut: (shortcut: TerminalShortcut) => Promise<void>;
  onTerminalSequence: (sequence: string) => Promise<void>;
};

type EditorDraft = {
  id?: string;
  title: string;
  detail: string;
  category: ShortcutCategory;
  kind: "send" | "sequence";
  value: string;
};

const EMPTY_DRAFT: EditorDraft = {
  title: "",
  detail: "",
  category: "favorites",
  kind: "send",
  value: "",
};

const PANEL_TABS: { id: PaletteCategory; icon: string; label: string }[] = [
  { id: "favorites", icon: "☆", label: "收藏" },
  { id: "tmux", icon: ">_", label: "Tmux" },
  { id: "codex", icon: "✳", label: "Codex" },
  { id: "ctrl", icon: "⌃", label: "Ctrl" },
  { id: "keyboard", icon: "⌨", label: "键盘" },
];

function panelShortcuts(store: ShortcutStore, category: ShortcutCategory): ShortcutDefinition[] {
  return store.shortcuts.filter((shortcut) => shortcut.enabled && shortcut.category === category);
}

function shortcutPages(cards: ShortcutDefinition[], pageSize: number): ShortcutDefinition[][] {
  const pages: ShortcutDefinition[][] = [];
  for (let index = 0; index < cards.length; index += pageSize) {
    pages.push(cards.slice(index, index + pageSize));
  }
  return pages.length > 0 ? pages : [[]];
}

function updateShortcut(store: ShortcutStore, id: string, update: Partial<ShortcutDefinition>): ShortcutStore {
  return {
    ...store,
    shortcuts: store.shortcuts.map((shortcut) => shortcut.id === id ? { ...shortcut, ...update } : shortcut),
  };
}

function movePanel(store: ShortcutStore, panel: ShortcutPanelId, direction: -1 | 1): ShortcutStore {
  const order = [...store.panelOrder];
  const index = order.indexOf(panel);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= order.length) return store;
  [order[index], order[target]] = [order[target], order[index]];
  return { ...store, panelOrder: order };
}

export function TmuxShortcutPalette({
  open,
  category,
  store,
  onOpenChange,
  onCategoryChange,
  onStoreChange,
  onSubmitText,
  onTerminalShortcut,
  onTerminalSequence,
}: TmuxShortcutPaletteProps): ReactElement {
  const [view, setView] = useState<"palette" | "manage" | "editor">("palette");
  const [draft, setDraft] = useState<EditorDraft>(EMPTY_DRAFT);
  const [editorError, setEditorError] = useState("");

  useEffect(() => {
    if (!open) setView("palette");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (view === "editor") setView("manage");
      else if (view === "manage") setView("palette");
      else onOpenChange(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onOpenChange, view]);

  const visibleTabs = useMemo(() => {
    const tabById = new Map(PANEL_TABS.map((tab) => [tab.id, tab]));
    return [
      ...store.panelOrder
        .filter((id) => !store.disabledPanels.includes(id))
        .map((id) => tabById.get(id))
        .filter((tab): tab is { id: PaletteCategory; icon: string; label: string } => Boolean(tab)),
    ];
  }, [store.disabledPanels, store.panelOrder]);

  const cards = panelShortcuts(store, category);
  const pageSize = category === "keyboard" ? 20 : 8;
  const pages = shortcutPages(cards, pageSize);
  const gridSize = category === "keyboard" ? 20 : 8;
  const customShortcuts = store.shortcuts.filter((shortcut) => !shortcut.builtIn);

  const selectShortcut = (shortcut: ShortcutDefinition): void => {
    if (shortcut.kind === "terminal") {
      void onTerminalShortcut(shortcut.value as TerminalShortcut);
      return;
    }
    if (shortcut.kind === "sequence") {
      const sequence = parseTerminalSequence(shortcut.value);
      if (sequence) void onTerminalSequence(sequence);
      return;
    }
    void onSubmitText(shortcut.value);
  };

  const beginCreate = (): void => {
    setDraft({ ...EMPTY_DRAFT });
    setEditorError("");
    setView("editor");
  };

  const beginEdit = (shortcut: ShortcutDefinition): void => {
    if (shortcut.builtIn) return;
    setDraft({
      id: shortcut.id,
      title: shortcut.title,
      detail: shortcut.detail,
      category: shortcut.category,
      kind: shortcut.kind === "sequence" ? "sequence" : "send",
      value: shortcut.value,
    });
    setEditorError("");
    setView("editor");
  };

  const saveDraft = (): void => {
    const title = draft.title.trim();
    const value = draft.value.trim();
    if (!title || !value) return;
    if (draft.kind === "sequence" && !parseTerminalSequence(value)) {
      setEditorError("控制键格式无效。可以写成 Ctrl+B, G、Ctrl+B+G 或 ^B,G。");
      return;
    }
    setEditorError("");
    const detail = draft.detail.trim() || "send";
    if (draft.id) {
      onStoreChange(updateShortcut(store, draft.id, {
        title,
        detail,
        category: draft.category,
        kind: draft.kind,
        value,
      }));
    } else {
      onStoreChange({
        ...store,
        shortcuts: [...store.shortcuts, {
          id: makeShortcutId(),
          title,
          detail,
          category: draft.category,
          kind: draft.kind,
          value,
          enabled: true,
          builtIn: false,
        }],
      });
    }
    setView("manage");
  };

  const removeShortcut = (shortcut: ShortcutDefinition): void => {
    if (shortcut.builtIn || !window.confirm(`删除“${shortcut.title}”？`)) return;
    onStoreChange({ ...store, shortcuts: store.shortcuts.filter((item) => item.id !== shortcut.id) });
  };

  if (!open) return <></>;

  return (
    <div className={`dashboard-shortcut-dialog${view !== "palette" ? " is-manager" : ""}${category === "keyboard" ? " is-keyboard-panel" : ""}`} role="dialog" aria-label={view === "palette" ? "Shortcut palette" : "Shortcut settings"}>
      {view === "palette" ? (
        <div className="dashboard-shortcut-sheet">
          <nav className="dashboard-shortcut-tabs" aria-label="Shortcut categories">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                className={`dashboard-shortcut-tab${category === tab.id ? " is-active" : ""}`}
                type="button"
                aria-pressed={category === tab.id}
                title={tab.label}
                onClick={() => onCategoryChange(tab.id)}
              >{tab.icon}</button>
            ))}
            <span className="dashboard-shortcut-tab-spacer" aria-hidden="true" />
            <button className="dashboard-shortcut-tab is-add" type="button" title="新建快捷输入" aria-label="新建快捷输入" onClick={beginCreate}>＋</button>
            <button className="dashboard-shortcut-tab is-settings" type="button" title="管理快捷键" aria-label="管理快捷键" onClick={() => setView("manage")}>☷</button>
            <button className="dashboard-shortcut-close" type="button" aria-label="Close shortcuts" onClick={() => onOpenChange(false)}>×</button>
          </nav>
          <div className="dashboard-shortcut-list" aria-label={tabLabel(category)}>
            <div className="dashboard-shortcut-pages">
              {pages.map((page, pageIndex) => (
                <div className="dashboard-shortcut-page" key={category + "-page-" + pageIndex}>
                  <div className="dashboard-shortcut-grid">
                    {Array.from({ length: gridSize }, (_, index) => page[index] ?? null).map((shortcut, index) => shortcut ? (
                        <button
                          key={shortcut.id}
                          type="button"
                          title={shortcut.title + " · " + shortcut.detail}
                          className={shortcut.dangerous ? "dashboard-shortcut-card is-danger" : "dashboard-shortcut-card"}
                          onClick={() => selectShortcut(shortcut)}
                        >
                          <span className="dashboard-shortcut-card-primary">{shortcut.title}</span>
                          <span className="dashboard-shortcut-card-detail">{shortcut.detail}</span>
                        </button>
                    ) : (
                        <button
                          key={"empty-" + category + "-" + pageIndex + "-" + index}
                          className="dashboard-shortcut-card is-empty"
                          type="button"
                          onClick={() => setView("manage")}
                          aria-label="添加快捷输入"
                        >{cards.length === 0 && index === 0 ? "＋ 添加" : ""}</button>
                    ))}
                  </div>
            </div>
              ))}
            </div>
          </div>
        </div>
      ) : view === "manage" ? (
        <ShortcutManager
          store={store}
          customShortcuts={customShortcuts}
          onBack={() => setView("palette")}
          onCreate={beginCreate}
          onEdit={beginEdit}
          onDelete={removeShortcut}
          onStoreChange={onStoreChange}
        />
      ) : (
        <ShortcutEditor
          draft={draft}
          error={editorError}
          onChange={setDraft}
          onBack={() => setView("manage")}
          onSave={saveDraft}
        />
      )}
    </div>
  );
}

function ShortcutManager({
  store,
  customShortcuts,
  onBack,
  onCreate,
  onEdit,
  onDelete,
  onStoreChange,
}: {
  store: ShortcutStore;
  customShortcuts: ShortcutDefinition[];
  onBack: () => void;
  onCreate: () => void;
  onEdit: (shortcut: ShortcutDefinition) => void;
  onDelete: (shortcut: ShortcutDefinition) => void;
  onStoreChange: (store: ShortcutStore) => void;
}): ReactElement {
  return (
    <div className="dashboard-shortcut-manager">
      <header className="dashboard-manager-header">
        <button type="button" className="dashboard-manager-back" onClick={onBack} aria-label="返回快捷键面板">‹</button>
        <div><strong>快捷键</strong><span>自定义输入面板</span></div>
        <button type="button" className="dashboard-manager-close" onClick={onBack} aria-label="关闭">×</button>
      </header>
      <section className="dashboard-shortcut-preview">
        <p className="dashboard-shortcut-section-label">预览</p>
        <div className="dashboard-shortcut-preview-screen">
          <span>长按 Ctrl 打开快捷栏。点击 Ctrl 关闭。</span>
          <div className="dashboard-shortcut-preview-bar">
            {store.panelOrder.filter((id) => !store.disabledPanels.includes(id)).map((id) => (
              <span key={id}>{SHORTCUT_PANEL_META[id].icon}</span>
            ))}
            <span>＋</span><span>☷</span>
          </div>
        </div>
      </section>
      <section className="dashboard-manager-section">
        <div className="dashboard-manager-section-heading"><div><p className="dashboard-shortcut-section-label">面板标签</p><span>控制快捷栏里的分类和顺序</span></div></div>
        <div className="dashboard-manager-list">
          {store.panelOrder.map((id, index) => {
            const enabled = !store.disabledPanels.includes(id);
            return (
              <div className={`dashboard-manager-row${enabled ? "" : " is-disabled"}`} key={id}>
                <button type="button" className={`dashboard-manager-toggle${enabled ? " is-enabled" : ""}`} onClick={() => onStoreChange({ ...store, disabledPanels: enabled ? [...store.disabledPanels, id] : store.disabledPanels.filter((item) => item !== id) })} aria-label={enabled ? "隐藏" : "显示"}>{enabled ? "−" : "+"}</button>
                <span className="dashboard-manager-row-icon">{SHORTCUT_PANEL_META[id].icon}</span>
                <div className="dashboard-manager-row-copy"><strong>{SHORTCUT_PANEL_META[id].label}</strong><span>{store.shortcuts.filter((shortcut) => shortcut.category === id && shortcut.enabled).length} 个快捷键</span></div>
                <div className="dashboard-manager-order">
                  <button type="button" onClick={() => onStoreChange(movePanel(store, id, -1))} disabled={index === 0} aria-label="上移">⌃</button>
                  <button type="button" onClick={() => onStoreChange(movePanel(store, id, 1))} disabled={index === store.panelOrder.length - 1} aria-label="下移">⌄</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <section className="dashboard-manager-section">
        <div className="dashboard-manager-section-heading"><div><p className="dashboard-shortcut-section-label">自定义快捷输入</p><span>点击卡片立即发送文本</span></div><button type="button" className="dashboard-manager-add" onClick={onCreate}>＋ 新建</button></div>
        <div className="dashboard-manager-custom-list">
          {customShortcuts.length === 0 ? <p className="dashboard-manager-empty">还没有自定义快捷输入。</p> : null}
          {customShortcuts.map((shortcut) => (
            <div className="dashboard-custom-row" key={shortcut.id}>
              <span className="dashboard-custom-row-icon">{shortcut.kind === "sequence" ? "⌃" : "↗"}</span>
              <div><strong>{shortcut.title}</strong><span>{shortcut.detail} · {SHORTCUT_PANEL_META[shortcut.category].label}</span><code>{shortcut.value}</code></div>
              <button type="button" className={shortcut.enabled ? "is-visible" : ""} onClick={() => onStoreChange(updateShortcut(store, shortcut.id, { enabled: !shortcut.enabled }))} aria-label={shortcut.enabled ? `隐藏 ${shortcut.title}` : `显示 ${shortcut.title}`}>{shortcut.enabled ? "−" : "+"}</button>
              <button type="button" onClick={() => onEdit(shortcut)} aria-label={`编辑 ${shortcut.title}`}>✎</button>
              <button type="button" onClick={() => onDelete(shortcut)} aria-label={`删除 ${shortcut.title}`}>×</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ShortcutEditor({
  draft,
  error,
  onChange,
  onBack,
  onSave,
}: {
  draft: EditorDraft;
  error: string;
  onChange: (draft: EditorDraft) => void;
  onBack: () => void;
  onSave: () => void;
}): ReactElement {
  return (
    <form className="dashboard-shortcut-editor" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <header className="dashboard-manager-header">
        <button type="button" className="dashboard-manager-back" onClick={onBack} aria-label="返回">‹</button>
        <div><strong>{draft.id ? "编辑快捷输入" : "新建快捷输入"}</strong><span>保存后立即出现在快捷栏</span></div>
        <button type="button" className="dashboard-manager-close" onClick={onBack} aria-label="关闭">×</button>
      </header>
      <label className="dashboard-shortcut-field">显示文字<input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} placeholder="/review" maxLength={32} autoFocus required /></label>
      <label className="dashboard-shortcut-field">说明文字<input value={draft.detail} onChange={(event) => onChange({ ...draft, detail: event.target.value })} placeholder="review changes" maxLength={48} /></label>
      <label className="dashboard-shortcut-field">{draft.kind === "sequence" ? "控制键组合" : "发送内容"}<textarea value={draft.value} onChange={(event) => onChange({ ...draft, value: event.target.value })} placeholder={draft.kind === "sequence" ? "例如 Ctrl+B, G 或 ^B,G" : "点击后直接发送的内容"} rows={4} maxLength={8000} required /></label>
      {draft.kind === "sequence" ? <p className="dashboard-shortcut-field-hint">支持 Enter、Tab、Esc、Up/Down/Left/Right、Home、End、Delete、F1-F12，以及 Ctrl+B, g 这类组合。</p> : null}
      <fieldset className="dashboard-shortcut-fieldset"><legend>快捷输入类型</legend><label><input type="radio" name="shortcut-kind" checked={draft.kind === "send"} onChange={() => onChange({ ...draft, kind: "send" })} /> 普通文本</label><label><input type="radio" name="shortcut-kind" checked={draft.kind === "sequence"} onChange={() => onChange({ ...draft, kind: "sequence" })} /> 控制键组合</label></fieldset>
      {error ? <p className="dashboard-shortcut-editor-error" role="alert">{error}</p> : null}
      <label className="dashboard-shortcut-field">放入面板<select value={draft.category} onChange={(event) => onChange({ ...draft, category: event.target.value as ShortcutCategory })}>{SHORTCUT_PANEL_ORDER.map((id) => <option value={id} key={id}>{SHORTCUT_PANEL_META[id].label}</option>)}</select></label>
      <div className="dashboard-shortcut-editor-actions"><button type="button" onClick={onBack}>取消</button><button className="is-primary" type="submit">保存快捷输入</button></div>
    </form>
  );
}

function tabLabel(category: PaletteCategory): string {
  return SHORTCUT_PANEL_META[category].label;
}
