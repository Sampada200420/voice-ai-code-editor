"use client";
import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";

export default function Editor({ initialCode, onChange }: { initialCode: string; onChange: (code: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: initialCode, extensions: [
        lineNumbers(), history(), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        javascript({ typescript: true }), EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": "TypeScript code editor" }),
        EditorView.updateListener.of(update => { if (update.docChanged) callback.current(update.state.doc.toString()); }),
        EditorView.theme({ "&": { height: "100%", fontSize: "14px" }, ".cm-scroller": { overflow: "auto", fontFamily: "var(--mono)" }, ".cm-content": { padding: "20px 0" }, ".cm-gutters": { background: "#f7f7f3", border: "none", color: "#92958e" }, ".cm-line": { padding: "0 14px" }, "&.cm-focused": { outline: "none" } }),
      ] }),
    });
    return () => view.destroy();
  }, [initialCode]);
  return <div className="editor" ref={host} />;
}
