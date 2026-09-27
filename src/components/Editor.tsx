"use client";
import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, lineNumbers, keymap, Decoration, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import type { EditRequest, EditResponse } from "@/lib/protocol";

export interface EditorHandle {
  highlightRange: (lineStart?: number, lineEnd?: number, snippet?: string, clear?: boolean) => void;
  applyEdit: (request: EditRequest, currentRevision: number) => EditResponse;
}

export const setHighlightEffect = StateEffect.define<{
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
  clear?: boolean;
}>();

const highlightDecoration = Decoration.line({
  attributes: { class: "cm-highlight-speaking" },
});

const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(highlights, tr) {
    highlights = highlights.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setHighlightEffect)) {
        if (effect.value.clear) {
          return Decoration.none;
        }

        const doc = tr.state.doc;
        let startLine = effect.value.lineStart || 1;
        let endLine = effect.value.lineEnd || startLine;

        // Dynamic snippet resolution: search snippet in doc to resolve line numbers
        if (effect.value.snippet && effect.value.snippet.trim().length > 0) {
          const text = doc.toString();
          const target = effect.value.snippet.trim();
          const idx = text.indexOf(target);
          if (idx !== -1) {
            startLine = doc.lineAt(idx).number;
            const endIdx = idx + target.length;
            endLine = doc.lineAt(Math.min(endIdx, doc.length)).number;
          }
        }

        startLine = Math.max(1, Math.min(startLine, doc.lines));
        endLine = Math.max(startLine, Math.min(endLine, doc.lines));

        const builder = [];
        for (let i = startLine; i <= endLine; i++) {
          const line = doc.line(i);
          builder.push(highlightDecoration.range(line.from));
        }
        return Decoration.set(builder, true);
      }
    }
    return highlights;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const Editor = forwardRef<EditorHandle, { initialCode: string; onChange: (code: string) => void }>(
  function Editor({ initialCode, onChange }, ref) {
    const host = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const callback = useRef(onChange);
    callback.current = onChange;

    useEffect(() => {
      if (!host.current) return;
      const view = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: initialCode,
          extensions: [
            lineNumbers(),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
            javascript({ typescript: true }),
            EditorView.lineWrapping,
            highlightField,
            EditorView.contentAttributes.of({ "aria-label": "TypeScript code editor" }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) callback.current(update.state.doc.toString());
            }),
            EditorView.theme({
              "&": { height: "100%", fontSize: "14px" },
              ".cm-scroller": { overflow: "auto", fontFamily: "var(--mono)" },
              ".cm-content": { padding: "20px 0" },
              ".cm-gutters": { background: "#f7f7f3", border: "none", color: "#92958e" },
              ".cm-line": { padding: "0 14px" },
              ".cm-highlight-speaking": {
                background: "rgba(234, 179, 8, 0.22)",
                borderLeft: "3px solid #eab308",
                transition: "background 0.2s ease",
              },
              "&.cm-focused": { outline: "none" },
            }),
          ],
        }),
      });
      viewRef.current = view;
      return () => view.destroy();
    }, [initialCode]);

    useImperativeHandle(ref, () => ({
      highlightRange(lineStart, lineEnd, snippet, clear) {
        if (!viewRef.current) return;
        viewRef.current.dispatch({
          effects: setHighlightEffect.of({ lineStart, lineEnd, snippet, clear }),
        });
      },
      applyEdit(request, currentRevision) {
        if (!viewRef.current) {
          return {
            success: false,
            revision: currentRevision,
            code: "",
            error: "Editor instance not ready.",
          };
        }

        const doc = viewRef.current.state.doc;
        const currentCode = doc.toString();
        const target = request.targetSnippet.trim();
        let from = -1;
        let to = -1;

        if (target.length > 0) {
          from = currentCode.indexOf(target);
          if (from === -1) {
            // Fuzzy line match fallback: search normalized lines
            const normalizedTarget = target.replace(/\r\n/g, "\n").trim();
            const normalizedDoc = currentCode.replace(/\r\n/g, "\n");
            from = normalizedDoc.indexOf(normalizedTarget);
          }
        }

        if (request.editType === "insert" && from === -1) {
          // Default to end of function or end of document for insert
          from = doc.length;
          to = doc.length;
        } else if (from !== -1) {
          to = from + (target.length || 0);
        }

        if (from === -1 && request.editType !== "insert") {
          return {
            success: false,
            revision: currentRevision,
            code: currentCode,
            error: `Target code snippet "${request.targetSnippet.slice(0, 30)}..." not found in current document revision ${currentRevision}.`,
          };
        }

        const newContent = request.editType === "delete" ? "" : request.newCode;

        viewRef.current.dispatch({
          changes: { from, to, insert: newContent },
        });

        const updatedCode = viewRef.current.state.doc.toString();
        const nextRevision = currentRevision + 1;

        return {
          success: true,
          revision: nextRevision,
          code: updatedCode,
        };
      },
    }));

    return <div className="editor" ref={host} />;
  }
);

export default Editor;
