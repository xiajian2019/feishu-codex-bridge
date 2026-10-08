import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";

import { logDebugDiagnostic } from "./debug-log-capture.js";
import {
  parseTerminalSequence,
  type ShortcutCategory,
  type ShortcutDefinition,
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
  onShortcutUse: (id: string) => Promise<void>;
  onSubmitText: (text: string) => Promise<SubmissionResult>;
  onSubmitCommand: (command: string) => Promise<SubmissionResult>;
  onTerminalShortcut: (shortcut: TerminalShortcut) => Promise<SubmissionResult>;
  onTerminalSequence: (sequence: string) => Promise<SubmissionResult>;
};

function sortGroups(store: ShortcutStore): ShortcutStore["groups"] {
  return store.groups
    .filter((group) => group.enabled && group.surface === "palette")
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
}

function panelShortcuts(store: ShortcutStore, category: ShortcutCategory): ShortcutDefinition[] {
  const enabledGroups = new Set(store.groups.filter((group) => group.enabled && group.surface === "palette").map((group) => group.id));
  const enabled = store.shortcuts.filter((shortcut) => shortcut.enabled && enabledGroups.has(shortcut.groupId));
  if (category === "favorites") {
    return enabled
      .slice()
      .sort((left, right) => right.operationCount - left.operationCount
        || Number(right.groupId === "favorites") - Number(left.groupId === "favorites")
        || left.sortOrder - right.sortOrder
        || left.title.localeCompare(right.title))
      .slice(0, 8);
  }
  return enabled.filter((shortcut) => shortcut.groupId === category);
}

function shortcutPages(cards: ShortcutDefinition[], pageSize: number): ShortcutDefinition[][] {
  const pages: ShortcutDefinition[][] = [];
  for (let index = 0; index < cards.length; index += pageSize) pages.push(cards.slice(index, index + pageSize));
  return pages.length > 0 ? pages : [[]];
}

export function TmuxShortcutPalette({
  open,
  category,
  store,
  onOpenChange,
  onCategoryChange,
  onShortcutUse,
  onSubmitText,
  onSubmitCommand,
  onTerminalShortcut,
  onTerminalSequence,
}: TmuxShortcutPaletteProps): ReactElement {
  const navigate = useNavigate();
  const groups = useMemo(() => sortGroups(store), [store.groups]);
  const group = groups.find((item) => item.id === category);
  const cards = useMemo(() => panelShortcuts(store, category), [category, store.shortcuts]);
  const pageSize = group?.layout === "keyboard" ? 20 : 8;
  const pages = shortcutPages(cards, pageSize);
  const gridSize = pageSize;
  const pagesRef = useRef<HTMLDivElement>(null);
  const [pageIndex, setPageIndex] = useState(0);

  useEffect(() => {
    setPageIndex(0);
    pagesRef.current?.scrollTo({ left: 0, behavior: "auto" });
  }, [category, cards.length, pageSize]);

  useEffect(() => {
    const pagesElement = pagesRef.current;
    if (!pagesElement || pages.length < 2) return;
    const onScroll = (): void => {
      const width = pagesElement.clientWidth;
      if (width > 0) setPageIndex(Math.max(0, Math.min(pages.length - 1, Math.round(pagesElement.scrollLeft / width))));
    };
    pagesElement.addEventListener("scroll", onScroll, { passive: true });
    return () => pagesElement.removeEventListener("scroll", onScroll);
  }, [pages.length]);

  const goToPage = (nextIndex: number): void => {
    const target = Math.max(0, Math.min(pages.length - 1, nextIndex));
    setPageIndex(target);
    const pagesElement = pagesRef.current;
    const page = pagesElement?.children.item(target);
    if (page instanceof HTMLElement) page.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
  };

  useEffect(() => {
    if (!open) return;
    logDebugDiagnostic("tmux-shortcut", "view", {
      open,
      view: "palette",
      category,
      activeTag: document.activeElement?.tagName,
    });
    const frame = window.requestAnimationFrame(() => {
      const dialog = document.querySelector<HTMLElement>(".dashboard-shortcut-dialog");
      if (!dialog) return;
      const rect = dialog.getBoundingClientRect();
      const style = getComputedStyle(dialog);
      logDebugDiagnostic("tmux-shortcut", "dialog-mounted", {
        view: "palette",
        category,
        rect: { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width },
        maxHeight: style.maxHeight,
        overflow: style.overflow,
        position: style.position,
        activeTag: document.activeElement?.tagName,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [category, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onOpenChange, open]);

  const selectShortcut = (shortcut: ShortcutDefinition): void => {
    void onShortcutUse(shortcut.id);
    const closeAfterSuccess = shortcut.groupId === "codex" || shortcut.groupId === "tmux";
    const deliver = async (submission: Promise<SubmissionResult>): Promise<void> => {
      const result = await submission;
      if (closeAfterSuccess && result.ok) onOpenChange(false);
    };
    if (shortcut.kind === "terminal") {
      void deliver(onTerminalShortcut(shortcut.value as TerminalShortcut));
      return;
    }
    if (shortcut.kind === "sequence") {
      const sequence = parseTerminalSequence(shortcut.value);
      if (sequence) void deliver(onTerminalSequence(sequence));
      return;
    }
    void deliver(closeAfterSuccess
      ? onSubmitCommand(shortcut.value)
      : onSubmitText(shortcut.value));
  };

  if (!open) return <></>;

  return (
    <div
      className={`dashboard-shortcut-dialog${group?.layout === "keyboard" ? " is-keyboard-panel" : ""}`}
      data-shortcut-view="palette"
      data-shortcut-category={category}
      role="dialog"
      aria-label="Shortcut palette"
    >
      <div className="dashboard-shortcut-sheet">
        <nav className="dashboard-shortcut-tabs" aria-label="Shortcut categories">
          {groups.map((item) => (
            <button
              key={item.id}
              className={`dashboard-shortcut-tab${category === item.id ? " is-active" : ""}`}
              type="button"
              aria-pressed={category === item.id}
              title={item.title}
              onClick={() => onCategoryChange(item.id)}
            >{item.icon}</button>
          ))}
          <span className="dashboard-shortcut-tab-spacer" aria-hidden="true" />
          <button
            className="dashboard-shortcut-tab is-add"
            type="button"
            title="管理快捷键"
            aria-label="管理快捷键"
            onClick={() => {
              onOpenChange(false);
              navigate("/system-management/shortcuts");
            }}
          >☷</button>
          <button className="dashboard-shortcut-close" type="button" aria-label="关闭快捷键" onClick={() => onOpenChange(false)}>×</button>
        </nav>
        <div className="dashboard-shortcut-list" aria-label={group?.title ?? "快捷键"}>
            <div className="dashboard-shortcut-pages" ref={pagesRef}>
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
                      onClick={() => navigate("/system-management/shortcuts")}
                      aria-label="管理快捷键"
                    >{cards.length === 0 && index === 0 ? "☷ 管理" : ""}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {pages.length > 1 ? (
            <div className="dashboard-shortcut-pagination" aria-label="快捷键分页">
              <button type="button" aria-label="上一页快捷键" onClick={() => goToPage(pageIndex - 1)} disabled={pageIndex === 0}>‹</button>
              <span>{pageIndex + 1} / {pages.length}</span>
              <button type="button" aria-label="下一页快捷键" onClick={() => goToPage(pageIndex + 1)} disabled={pageIndex === pages.length - 1}>›</button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
