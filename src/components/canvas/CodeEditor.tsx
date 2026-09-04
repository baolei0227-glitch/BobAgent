'use client';

import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, syntaxHighlighting, defaultHighlightStyle, indentUnit } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { sql } from '@codemirror/lang-sql';

interface CodeEditorProps {
  content: string;
  extension?: string;  // 文件扩展名，如 '.ts', '.py'
  editable?: boolean;  // 默认 true
  onChange?: (value: string) => void;
}

// 编辑器容器与字体样式覆盖：& 对应 .cm-editor
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontFamily: "var(--font-mono)",
    fontSize: '0.933333rem',
  },
  '.cm-content': {
    fontFamily: "var(--font-mono)",
    fontSize: '0.933333rem',
  },
  '.cm-gutters': {
    fontFamily: "var(--font-mono)",
    fontSize: '0.933333rem',
  },
});

/** 根据文件扩展名返回对应语言的 CodeMirror 扩展，未匹配时返回纯文本（无语言包） */
function getLanguageExtension(ext: string): Extension[] {
  const normalized = ext.toLowerCase();
  switch (normalized) {
    case '.ts':
    case '.tsx':
      // TypeScript 语言 + JSX 支持
      return [javascript({ typescript: true, jsx: true })];
    case '.js':
    case '.jsx':
      // JavaScript 语言
      return [javascript()];
    case '.py':
      return [python()];
    case '.json':
      return [json()];
    case '.html':
      return [html()];
    case '.css':
      return [css()];
    case '.md':
      return [markdown()];
    case '.sql':
      return [sql()];
    default:
      // 其他文件类型：纯文本，无语言包
      return [];
  }
}

export function CodeEditor({ content, extension = '', editable = true, onChange }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 使用 Compartment 动态切换语言包与可编辑状态
  const languageCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());
  // 标记外部 content 同步，避免触发 onChange 回环
  const isExternalUpdate = useRef(false);
  // 保存最新的 onChange 引用，避免在 updateListener 闭包中拿到旧值
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 初始化与销毁 EditorView（仅在挂载时执行一次）
  useEffect(() => {
    if (!hostRef.current) return;

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      foldGutter(),
      indentOnInput(),
      indentUnit.of('  '),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      oneDark,
      editorTheme,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      // 动态语言包
      languageCompartment.current.of(getLanguageExtension(extension)),
      // 动态可编辑状态（editable=false 时只读）
      editableCompartment.current.of(EditorState.readOnly.of(!editable)),
      // 监听文档变化，触发 onChange（跳过外部同步以避免回环）
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !isExternalUpdate.current) {
          onChangeRef.current?.(update.state.doc.toString());
        }
      }),
    ];

    const state = EditorState.create({
      doc: content,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: hostRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 仅在挂载时初始化，后续变化由独立的 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 content 变化时同步到编辑器（dispatch 前后切换标记，避免 onChange 回环）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc === content) return;

    isExternalUpdate.current = true;
    view.dispatch({
      changes: { from: 0, to: currentDoc.length, insert: content },
    });
    isExternalUpdate.current = false;
  }, [content]);

  // 文件扩展名变化时重新配置语言包
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartment.current.reconfigure(getLanguageExtension(extension)),
    });
  }, [extension]);

  // editable 变化时重新配置只读状态
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.current.reconfigure(EditorState.readOnly.of(!editable)),
    });
  }, [editable]);

  return (
    <div
      ref={hostRef}
      style={{ height: '100%', width: '100%' }}
    />
  );
}
