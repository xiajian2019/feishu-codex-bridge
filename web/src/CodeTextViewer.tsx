import { useEffect, useRef, type ReactElement } from "react";

import { basicSetup, EditorView } from "codemirror";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";

const highContrastSelection = EditorView.theme({
  "&": { height: "100%", color: "#d8dee9", backgroundColor: "#171e27", fontSize: "12px" },
  ".cm-scroller": { overflow: "auto", fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
  ".cm-content": { color: "#d8dee9", caretColor: "transparent", userSelect: "text", webkitUserSelect: "text" },
  ".cm-gutters": { color: "#8995a3", backgroundColor: "#171e27", border: "none" },
  ".cm-line": { padding: "0 14px" },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "#365f90 !important",
  },
  ".cm-content ::selection": { color: "#ffffff !important", backgroundColor: "#365f90 !important" },
}, { dark: true });

async function loadLanguage(fileName: string): Promise<Extension | null> {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "mjs", "cjs", "jsx"].includes(extension)) {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript({ jsx: extension === "jsx" });
  }
  if (["ts", "mts", "cts", "tsx"].includes(extension)) {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript({ typescript: true, jsx: extension === "tsx" });
  }
  switch (extension) {
    case "json": return (await import("@codemirror/lang-json")).json();
    case "md":
    case "markdown": return (await import("@codemirror/lang-markdown")).markdown();
    case "py": return (await import("@codemirror/lang-python")).python();
    case "yaml":
    case "yml": return (await import("@codemirror/lang-yaml")).yaml();
    case "html":
    case "htm": return (await import("@codemirror/lang-html")).html();
    case "css": return (await import("@codemirror/lang-css")).css();
    case "xml": return (await import("@codemirror/lang-xml")).xml();
    default: return null;
  }
}

export function CodeTextViewer({ fileName, text }: { fileName: string; text: string }): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let editor: EditorView | null = null;
    const mount = (language: Extension | null): void => {
      const parent = containerRef.current;
      if (disposed || !parent) return;
      editor = new EditorView({
        parent,
        state: EditorState.create({
          doc: text,
          extensions: [
            basicSetup,
            oneDark,
            ...(language ? [language] : []),
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({ tabindex: "0", "aria-label": `Preview ${fileName}` }),
            highContrastSelection,
          ],
        }),
      });
    };
    void loadLanguage(fileName).then(mount).catch(() => mount(null));
    return () => {
      disposed = true;
      editor?.destroy();
    };
  }, [fileName, text]);

  return <div className="tmux-code-editor" ref={containerRef} />;
}
