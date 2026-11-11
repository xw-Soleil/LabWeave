import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { frontmatterSyntax, livePreview, type LivePreviewConfig } from "./MarkdownLivePreview";

export type MarkdownEditMode = "live" | "source";

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "650" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, class: "cm-md-link" },
  { tag: tags.url, class: "cm-md-url" },
  { tag: tags.monospace, class: "cm-md-code" },
  { tag: tags.quote, class: "cm-md-quote" },
  { tag: tags.processingInstruction, class: "cm-md-mark" },
  { tag: tags.contentSeparator, class: "cm-md-mark" },
  { tag: tags.labelName, class: "cm-md-mark" },
]);

/**
 * Markdown 编辑器，照 Obsidian：
 * - live（实时预览）：光标所在的地方露出原文，其他地方显示排好版的样子；
 * - source（源码）：纯文本，只给语法上色。
 * 原文一个字都不会被编辑器改动，存盘时就是你打的字。
 */
export default function MarkdownEditor({
  value,
  onChange,
  mode,
  config,
  disabled,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  mode: MarkdownEditMode;
  config: LivePreviewConfig;
  disabled?: boolean;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const modeSlot = useRef(new Compartment());
  const editableSlot = useRef(new Compartment());
  const latest = useRef({ onChange, config });
  latest.current = { onChange, config };

  const modeExtension = (value: MarkdownEditMode) => (value === "live" ? livePreview(() => latest.current.config) : []);
  const editableExtension = (readOnly: boolean) => [
    EditorView.editable.of(!readOnly),
    EditorState.readOnly.of(readOnly),
  ];

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          markdown({ base: markdownLanguage, extensions: [frontmatterSyntax] }),
          syntaxHighlighting(highlight),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ spellcheck: "false", "aria-label": label }),
          modeSlot.current.of(modeExtension(mode)),
          editableSlot.current.of(editableExtension(!!disabled)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // 编辑器只建一次；内容、模式、只读在下面几个 effect 里跟着变
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: modeSlot.current.reconfigure(modeExtension(mode)) });
  }, [mode]);

  useEffect(() => {
    view.current?.dispatch({ effects: editableSlot.current.reconfigure(editableExtension(!!disabled)) });
  }, [disabled]);

  // 外面换了内容（重新读取、在属性表里改了）才同步进来；自己打的字不会再绕一圈
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    const head = Math.min(editor.state.selection.main.head, value.length);
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
      selection: { anchor: head },
    });
  }, [value]);

  return <div ref={host} className="markdown-editor" data-mode={mode} />;
}
