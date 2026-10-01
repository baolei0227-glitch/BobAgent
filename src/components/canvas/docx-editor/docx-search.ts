/**
 * docx 编辑器内查找 / 替换（S1 · Word chrome 增强）
 *
 * 纯编辑器层能力，不进入文档模型、不影响 docx 字节保真：
 *   - ProseMirror 插件扫描文本节点计算匹配区间，用 inline 装饰高亮；
 *   - 当前命中（active）用更高对比色，并提供滚动定位（依赖编辑器 scrollIntoView）；
 *   - 命令：setSearchTerm / findNext / findPrev / replaceCurrent / replaceAll / clearSearch。
 *
 * 匹配限定在单个文本节点内（与 Word 在 run 内匹配一致），跨 mark 拆分的词不合并匹配，
 * 这是首版可接受的取舍。
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

export interface SearchMatch {
  from: number
  to: number
}

export interface SearchState {
  term: string
  matchCase: boolean
  wholeWord: boolean
  matches: SearchMatch[]
  active: number
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    docxSearch: {
      setSearchTerm: (term: string, opts?: { matchCase?: boolean; wholeWord?: boolean }) => ReturnType
      findNext: () => ReturnType
      findPrev: () => ReturnType
      replaceCurrent: (replaceTerm: string) => ReturnType
      replaceAll: (replaceTerm: string) => ReturnType
      clearSearch: () => ReturnType
    }
  }
}

export const searchKey = new PluginKey<SearchState>('docxSearch')

/** 导航类事务（仅改选中/高亮，不改内容）标记此 meta，避免被记脏 */
export const DOCX_SEARCH_NAV_META = 'docxSearchNoDirty'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function computeMatches(doc: PMNode, term: string, matchCase: boolean, wholeWord: boolean): SearchMatch[] {
  const matches: SearchMatch[] = []
  if (!term) return matches
  const flags = matchCase ? 'g' : 'gi'
  let regex: RegExp
  try {
    regex = new RegExp(wholeWord ? `\\b${escapeRegExp(term)}\\b` : escapeRegExp(term), flags)
  } catch {
    return matches
  }
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const text = node.text
    const re = new RegExp(regex.source, flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      const from = pos + m.index
      const to = from + m[0].length
      matches.push({ from, to })
    }
  })
  return matches
}

export const DocxSearch = Extension.create({
  name: 'docxSearch',
  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchKey,
        state: {
          init: (): SearchState => ({
            term: '',
            matchCase: false,
            wholeWord: false,
            matches: [],
            active: -1,
          }),
          apply(tr, prev) {
            const meta = tr.getMeta(searchKey) as
              | { type: 'set'; term: string; matchCase: boolean; wholeWord: boolean }
              | { type: 'active'; active: number }
              | { type: 'replaced' }
              | undefined
            if (meta) {
              if (meta.type === 'set') {
                const matches = computeMatches(tr.doc, meta.term, meta.matchCase, meta.wholeWord)
                return {
                  term: meta.term,
                  matchCase: meta.matchCase,
                  wholeWord: meta.wholeWord,
                  matches,
                  active: -1,
                }
              }
              if (meta.type === 'active') {
                return { ...prev, active: meta.active }
              }
              if (meta.type === 'replaced') {
                const matches = computeMatches(tr.doc, prev.term, prev.matchCase, prev.wholeWord)
                let active = prev.active
                if (active >= matches.length) active = matches.length - 1
                return { ...prev, matches, active }
              }
            }
            if (tr.docChanged) {
              const matches = computeMatches(tr.doc, prev.term, prev.matchCase, prev.wholeWord)
              let active = prev.active
              if (active >= matches.length) active = matches.length - 1
              return { ...prev, matches, active }
            }
            return prev
          },
        },
        props: {
          decorations(state) {
            const s = searchKey.getState(state)
            if (!s || s.matches.length === 0) return DecorationSet.empty
            const decos = s.matches.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class: i === s.active ? 'docx-search-hit docx-search-active' : 'docx-search-hit',
              }),
            )
            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },
  addCommands() {
    return {
      setSearchTerm:
        (term: string, opts?: { matchCase?: boolean; wholeWord?: boolean }) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(searchKey, {
              type: 'set',
              term,
              matchCase: opts?.matchCase ?? false,
              wholeWord: opts?.wholeWord ?? false,
            })
            tr.setMeta(DOCX_SEARCH_NAV_META, true)
          }
          return true
        },
      findNext:
        () =>
        ({ state, dispatch, tr }) => {
          const s = searchKey.getState(state)
          if (!s || s.matches.length === 0) return false
          const next = s.active < 0 ? 0 : (s.active + 1) % s.matches.length
          const m = s.matches[next]
          if (dispatch) {
            tr.setSelection(TextSelection.create(tr.doc, m.from, m.to))
            tr.setMeta(searchKey, { type: 'active', active: next })
            tr.setMeta(DOCX_SEARCH_NAV_META, true)
            dispatch(tr)
          }
          return true
        },
      findPrev:
        () =>
        ({ state, dispatch, tr }) => {
          const s = searchKey.getState(state)
          if (!s || s.matches.length === 0) return false
          const prevIdx = s.active <= 0 ? s.matches.length - 1 : s.active - 1
          const m = s.matches[prevIdx]
          if (dispatch) {
            tr.setSelection(TextSelection.create(tr.doc, m.from, m.to))
            tr.setMeta(searchKey, { type: 'active', active: prevIdx })
            tr.setMeta(DOCX_SEARCH_NAV_META, true)
            dispatch(tr)
          }
          return true
        },
      replaceCurrent:
        (replaceTerm: string) =>
        ({ state, dispatch, tr }) => {
          const s = searchKey.getState(state)
          if (!s || s.active < 0 || s.active >= s.matches.length) return false
          const m = s.matches[s.active]
          if (dispatch) {
            tr.insertText(replaceTerm, m.from, m.to)
            dispatch(tr)
          }
          return true
        },
      replaceAll:
        (replaceTerm: string) =>
        ({ state, dispatch, tr }) => {
          const s = searchKey.getState(state)
          if (!s || s.matches.length === 0) return false
          for (let i = s.matches.length - 1; i >= 0; i--) {
            const m = s.matches[i]
            tr.insertText(replaceTerm, m.from, m.to)
          }
          if (dispatch) dispatch(tr)
          return true
        },
      clearSearch:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(searchKey, { type: 'set', term: '', matchCase: false, wholeWord: false })
            tr.setMeta(DOCX_SEARCH_NAV_META, true)
          }
          return true
        },
    }
  },
})
