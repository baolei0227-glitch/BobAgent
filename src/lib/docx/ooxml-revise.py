#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OOXML 修订引擎（track changes）
- apply   : 按 ops 生成 w:ins / w:del 修订标记（保留原格式，复制原 run 的 rPr）
- resolve : 接受/拒绝修订（单条 id 或全部）
- inspect : 列出全部修订清单（供前端修订面板使用）

用法：
  python3 ooxml-revise.py --mode apply   --input a.docx --output b.docx --payload '{"ops":[...],"author":"...","date":"..."}'
  python3 ooxml-revise.py --mode resolve --input a.docx --output b.docx --payload '{"decisions":[{"id":1,"accept":true}]}'
  python3 ooxml-revise.py --mode inspect --input a.docx --payload '{}'
输出：stdout JSON {"ok":true,"ins":N,"del":M,"total":T,"revisions":[...]}

op 类型：
  replace_paragraph      : locate.anchor(段内文本子串) -> 整段 del(原文)+ins(new)
  replace_text           : locate.anchor(段内文本子串) + locate.old -> 段内局部 pre+del(old)+ins(new)+post
  insert_paragraph_after : locate.anchor(段内文本子串) -> 在段后新增整段(段落级 w:ins)
  replace_table_cell     : locate.table/row/cell 索引 -> 单元格内整段替换
"""
import copy
import json
import os
import sys

from docx import Document
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


# ---------------------------------------------------------------- 修订元素工厂
class ReviseEngine:
    def __init__(self, doc, author="BobWork", date=None):
        self.doc = doc
        self.author = author
        self.date = date or "2026-01-01T00:00:00Z"
        self._rid = [0]
        self._reg = {}  # 运行时序号 id -> 修订元素（w:ins / w:del），由 revisions() 建立

    def nid(self):
        self._rid[0] += 1
        return self._rid[0]

    @staticmethod
    def rpr_of(r):
        e = r._r.find(qn("w:rPr"))
        return copy.deepcopy(e) if e is not None else None

    def make_del(self, text, rpr=None):
        el = OxmlElement("w:del")
        el.set(qn("w:id"), str(self.nid()))
        el.set(qn("w:author"), self.author)
        el.set(qn("w:date"), self.date)
        r = OxmlElement("w:r")
        if rpr is not None:
            r.append(rpr)
        t = OxmlElement("w:delText")
        t.set(qn("xml:space"), "preserve")
        t.text = text
        r.append(t)
        el.append(r)
        return el

    def make_ins(self, text, rpr=None):
        el = OxmlElement("w:ins")
        el.set(qn("w:id"), str(self.nid()))
        el.set(qn("w:author"), self.author)
        el.set(qn("w:date"), self.date)
        r = OxmlElement("w:r")
        if rpr is not None:
            r.append(rpr)
        t = OxmlElement("w:t")
        t.set(qn("xml:space"), "preserve")
        t.text = text
        r.append(t)
        el.append(r)
        return el

    @staticmethod
    def make_run(text, rpr=None):
        r = OxmlElement("w:r")
        if rpr is not None:
            r.append(rpr)
        t = OxmlElement("w:t")
        t.set(qn("xml:space"), "preserve")
        t.text = text
        r.append(t)
        return r

    @staticmethod
    def para_text(p):
        return "".join(r.text or "" for r in p.runs)

    def first_rpr(self, p):
        for r in p.runs:
            rp = self.rpr_of(r)
            if rp is not None:
                return rp
        return None

    def clear_content(self, p):
        pel = p._p
        for ch in list(pel):
            if ch.tag != qn("w:pPr"):
                pel.remove(ch)
        return pel

    def find_para(self, anchor):
        """按段内文本子串定位段落（首个匹配）；anchor 为空时返回第一个非空段落"""
        if not anchor:
            for p in self.doc.paragraphs:
                if self.para_text(p).strip():
                    return p
            return None
        for p in self.doc.paragraphs:
            if anchor in self.para_text(p):
                return p
        return None

    # ------------------------------------------------------------ 修订操作
    def op_replace_paragraph(self, op):
        p = self.find_para(op["locate"].get("anchor", ""))
        if p is None:
            raise ValueError("段落未找到: %r" % (op.get("locate", {}).get("anchor", "")))
        old_full = self.para_text(p)
        rpr = self.first_rpr(p)
        pel = self.clear_content(p)
        pel.append(self.make_del(old_full, copy.deepcopy(rpr) if rpr is not None else None))
        if op["new"]:
            pel.append(self.make_ins(op["new"], copy.deepcopy(rpr) if rpr is not None else None))
        return old_full

    def op_replace_text(self, op):
        loc = op["locate"]
        p = self.find_para(loc.get("anchor", ""))
        if p is None:
            raise ValueError("段落未找到: %r" % loc.get("anchor", ""))
        old = loc["old"]
        full = self.para_text(p)
        if old not in full:
            raise ValueError("定位文本未找到: %r in %r" % (old, full[:100]))
        idx = full.find(old)
        end = idx + len(old)
        pre, post = full[:idx], full[end:]
        rpr = self.first_rpr(p)
        pel = self.clear_content(p)
        if pre:
            pel.append(self.make_run(pre, copy.deepcopy(rpr) if rpr is not None else None))
        pel.append(self.make_del(old, copy.deepcopy(rpr) if rpr is not None else None))
        if op["new"]:
            pel.append(self.make_ins(op["new"], copy.deepcopy(rpr) if rpr is not None else None))
        if post:
            pel.append(self.make_run(post, copy.deepcopy(rpr) if rpr is not None else None))
        return old

    def op_insert_paragraph_after(self, op):
        p = self.find_para(op["locate"].get("anchor", ""))
        if p is None:
            raise ValueError("段落未找到: %r" % (op.get("locate", {}).get("anchor", "")))
        text = op["new"]
        new_p = OxmlElement("w:p")
        pPr = p._p.find(qn("w:pPr"))
        if pPr is not None:
            npPr = copy.deepcopy(pPr)
            rPr = npPr.find(qn("w:rPr"))
            if rPr is None:
                rPr = OxmlElement("w:rPr")
                npPr.append(rPr)
            m = OxmlElement("w:ins")
            m.set(qn("w:id"), str(self.nid()))
            m.set(qn("w:author"), self.author)
            m.set(qn("w:date"), self.date)
            rPr.append(m)
            new_p.append(npPr)
        ins = self.make_ins(text)
        new_p.append(ins)
        p._p.addnext(new_p)
        return text

    def op_replace_table_cell(self, op):
        loc = op["locate"]
        tbl = self.doc.tables[loc["table"]]
        cell = tbl.rows[loc["row"]].cells[loc["cell"]]
        p = cell.paragraphs[0]
        old_full = self.para_text(p)
        rpr = self.first_rpr(p)
        pel = self.clear_content(p)
        pel.append(self.make_del(old_full, copy.deepcopy(rpr) if rpr is not None else None))
        if op["new"]:
            pel.append(self.make_ins(op["new"], copy.deepcopy(rpr) if rpr is not None else None))
        return old_full

    # ------------------------------------------------ 普通模式（无修订标记，直接改原文）
    def op_replace_paragraph_plain(self, op):
        p = self.find_para(op["locate"].get("anchor", ""))
        if p is None:
            raise ValueError("段落未找到: %r" % (op.get("locate", {}).get("anchor", "")))
        rpr = self.first_rpr(p)
        pel = self.clear_content(p)
        if op["new"]:
            pel.append(self.make_run(op["new"], copy.deepcopy(rpr) if rpr is not None else None))
        return op["new"]

    def op_replace_text_plain(self, op):
        loc = op["locate"]
        p = self.find_para(loc.get("anchor", ""))
        if p is None:
            raise ValueError("段落未找到: %r" % loc.get("anchor", ""))
        old = loc["old"]
        full = self.para_text(p)
        if old not in full:
            raise ValueError("定位文本未找到: %r in %r" % (old, full[:100]))
        idx = full.find(old)
        end = idx + len(old)
        pre, post = full[:idx], full[end:]
        rpr = self.first_rpr(p)
        pel = self.clear_content(p)
        if pre:
            pel.append(self.make_run(pre, copy.deepcopy(rpr) if rpr is not None else None))
        if op["new"]:
            pel.append(self.make_run(op["new"], copy.deepcopy(rpr) if rpr is not None else None))
        if post:
            pel.append(self.make_run(post, copy.deepcopy(rpr) if rpr is not None else None))
        return old

    def op_insert_paragraph_after_plain(self, op):
        p = self.find_para(op["locate"].get("anchor", ""))
        if p is None:
            raise ValueError("段落未找到: %r" % (op.get("locate", {}).get("anchor", "")))
        new_p = OxmlElement("w:p")
        pPr = p._p.find(qn("w:pPr"))
        if pPr is not None:
            new_p.append(copy.deepcopy(pPr))
        new_p.append(self.make_run(op["new"]))
        p._p.addnext(new_p)
        return op["new"]

    def op_replace_table_cell_plain(self, op):
        loc = op["locate"]
        tbl = self.doc.tables[loc["table"]]
        cell = tbl.rows[loc["row"]].cells[loc["cell"]]
        p = cell.paragraphs[0]
        rpr = self.first_rpr(p)
        pel = self.clear_content(p)
        if op["new"]:
            pel.append(self.make_run(op["new"], copy.deepcopy(rpr) if rpr is not None else None))
        return op["new"]

    def apply_ops(self, ops):
        results = []
        for op in ops:
            t = op.get("type")
            label = op.get("label", t)
            try:
                if t == "replace_paragraph":
                    old = self.op_replace_paragraph(op)
                    results.append({"ok": True, "label": label, "old": old})
                elif t == "replace_text":
                    old = self.op_replace_text(op)
                    results.append({"ok": True, "label": label, "old": old})
                elif t == "insert_paragraph_after":
                    self.op_insert_paragraph_after(op)
                    results.append({"ok": True, "label": label, "old": ""})
                elif t == "replace_table_cell":
                    old = self.op_replace_table_cell(op)
                    results.append({"ok": True, "label": label, "old": old})
                elif t == "replace_paragraph_plain":
                    old = self.op_replace_paragraph_plain(op)
                    results.append({"ok": True, "label": label, "old": old})
                elif t == "replace_text_plain":
                    old = self.op_replace_text_plain(op)
                    results.append({"ok": True, "label": label, "old": old})
                elif t == "insert_paragraph_after_plain":
                    self.op_insert_paragraph_after_plain(op)
                    results.append({"ok": True, "label": label, "old": ""})
                elif t == "replace_table_cell_plain":
                    old = self.op_replace_table_cell_plain(op)
                    results.append({"ok": True, "label": label, "old": old})
                else:
                    results.append({"ok": False, "label": label, "old": "", "error": "未知 op 类型: %s" % t})
            except Exception as e:  # noqa: BLE001
                results.append({"ok": False, "label": label, "old": "", "error": str(e)})
        return results

    def enable_track_changes(self):
        settings = self.doc.settings.element
        if settings.find(qn("w:trackChanges")) is None:
            settings.append(OxmlElement("w:trackChanges"))

    # ------------------------------------------------------------ 接受/拒绝
    def _unwrap(self, el):
        """去掉 el 标签，保留其子节点"""
        parent = el.getparent()
        idx = parent.index(el)
        for child in list(el):
            parent.insert(idx, child)
            idx += 1
        parent.remove(el)

    def resolve_decisions(self, decisions):
        """decisions: [{id, accept}] —— id 为 revisions() 分配的运行时序号，经 _reg 精确回查元素。
        与 XML w:id 无关：WPS 等导出器会让多个修订共用同一 w:id，按 w:id 结算会误命中全部同 id 修订。"""
        by_id = {str(d["id"]): d.get("accept") for d in decisions}
        accepted = rejected = 0
        for rid, accept in by_id.items():
            el = self._reg.get(rid)
            if el is None:
                continue
            parent = el.getparent()
            if parent is None:
                continue  # 已随其他决策（如整段删除）脱离文档树
            if parent.tag == qn("w:rPr"):
                continue  # 段落/字符标记级由 resolve_paragraph_marks 处理
            if accept:
                if el.tag == qn("w:ins"):
                    self._unwrap(el)  # 接受插入：保留新文
                else:
                    parent.remove(el)  # 接受删除：删除旧文
                accepted += 1
            else:
                if el.tag == qn("w:ins"):
                    # 拒绝插入：若是整段唯一内容(新增条款)则删整段，否则删 w:ins
                    self._reject_ins(el)
                else:
                    self._reject_del(el)
                rejected += 1
        return accepted, rejected

    def _reject_ins(self, el):
        parent = el.getparent()
        # 整段新增：段落里除 pPr 外只有这一个 w:ins → 删除整段
        if parent.tag == qn("w:p"):
            non_ppr = [c for c in parent if c.tag != qn("w:pPr")]
            if len(non_ppr) == 1 and non_ppr[0] is el:
                # 同时检查该段是否为"新增段落"(pPr 段落标记无对应 w:ins 的不要误删)
                if parent.getparent() is not None:
                    parent.getparent().remove(parent)
                    return
        parent.remove(el)

    def _reject_del(self, el):
        parent = el.getparent()
        # 整段删除：段落里除 pPr 外只有这个 w:del → 还原整段
        if parent.tag == qn("w:p"):
            non_ppr = [c for c in parent if c.tag != qn("w:pPr")]
            if len(non_ppr) == 1 and non_ppr[0] is el:
                self._unwrap(el)
                return
        # 段内删除：w:delText -> w:t，去 w:del 包装（恢复文字）
        for r in el.findall(qn("w:r")):
            for t in r.findall(qn("w:delText")):
                t.tag = qn("w:t")
        self._unwrap(el)

    def resolve_paragraph_marks(self, decisions):
        """段落标记级修订（pPr/w:rPr 内的 w:ins / w:del）：接受=去掉标记；拒绝=删除该段(新增段)或保留该段(删除段)。
        同样经 _reg 按运行时 id 精确回查元素，不按 XML w:id 匹配。"""
        by_id = {str(d["id"]): d.get("accept") for d in decisions}
        accepted = rejected = 0
        for rid, accept in by_id.items():
            el = self._reg.get(rid)
            if el is None or el.tag not in (qn("w:ins"), qn("w:del")):
                continue
            parent = el.getparent()
            if parent is None or parent.tag != qn("w:rPr"):
                continue  # 正文级由 resolve_decisions 处理
            is_ins = el.tag == qn("w:ins")
            if accept:
                parent.remove(el)  # 接受：仅移除修订标记（内容保留）
                accepted += 1
            else:
                # 拒绝：新增段(ins) -> 删整段；删除段(del) -> 移除标记保留段
                if is_ins:
                    p = el.getparent().getparent().getparent()
                    if p is not None and p.tag == qn("w:p") and p.getparent() is not None:
                        p.getparent().remove(p)
                    else:
                        parent.remove(el)
                    rejected += 1
                else:
                    parent.remove(el)
                    rejected += 1
        return accepted, rejected

    # ------------------------------------------------------------ 统计/清单
    def revisions(self):
        """按文档中出现顺序（从上往下）收集修订：单次遍历，w:ins/w:del/段落标记逐一遇到即收录。
        条目 id 使用运行时序号并与 _reg 注册表绑定元素——不直接采用 XML w:id：
        WPS 等导出器会让多个修订共用同一 w:id，按 w:id 结算会把一条决策误命中到全部同 id 修订。
        注意：不能分三轮（先全部 ins、再全部 del）收集，否则列表会呈现按类型分组的假象。"""
        ins = del_ = 0
        items = []
        self._reg = {}
        body = self.doc.element.body
        rpr_tag = qn("w:rPr")
        for el in body.iter():
            tag = el.tag
            if tag not in (qn("w:ins"), qn("w:del")):
                continue
            rid = str(len(items) + 1)
            self._reg[rid] = el
            if tag == qn("w:ins"):
                ins += 1
                if el.getparent() is not None and el.getparent().tag == rpr_tag:
                    # 段落标记级修订（pPr/rPr 内 w:ins，无正文文本，取所在段落文字示意）
                    p = el.getparent().getparent().getparent()
                    text = "".join(t.text or "" for t in p.iter(qn("w:t")))[:80]
                    items.append({"id": rid, "kind": "insert-mark", "text": text,
                                  "author": el.get(qn("w:author")), "date": el.get(qn("w:date"))})
                else:
                    text = "".join(t.text or "" for t in el.iter(qn("w:t")))
                    items.append({"id": rid, "kind": "insert", "text": text,
                                  "author": el.get(qn("w:author")), "date": el.get(qn("w:date"))})
            else:
                del_ += 1
                if el.getparent() is not None and el.getparent().tag == rpr_tag:
                    p = el.getparent().getparent().getparent()
                    text = "".join(t.text or "" for t in p.iter(qn("w:t")))[:80]
                    items.append({"id": rid, "kind": "delete-mark", "text": text,
                                  "author": el.get(qn("w:author")), "date": el.get(qn("w:date"))})
                else:
                    text = "".join(t.text or "" for t in el.iter(qn("w:delText")))
                    items.append({"id": rid, "kind": "delete", "text": text,
                                  "author": el.get(qn("w:author")), "date": el.get(qn("w:date"))})
        return ins, del_, items


def main():
    args = {}
    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        if argv[i] in ("--mode", "--input", "--output", "--payload"):
            args[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1

    mode = args.get("mode", "apply")
    payload = json.loads(args.get("payload", "{}"))
    try:
        doc = Document(args["input"])
        eng = ReviseEngine(doc, author=payload.get("author", "BobWork"), date=payload.get("date"))

        if mode == "apply":
            results = eng.apply_ops(payload.get("ops", []))
            eng.enable_track_changes()
            doc.save(args["output"])
            ins, del_, items = eng.revisions()
            print(json.dumps({"ok": True, "ins": ins, "del": del_, "total": ins + del_, "results": results,
                              "revisions": items}, ensure_ascii=False))
        elif mode == "resolve":
            decisions = payload.get("decisions", [])
            eng.revisions()  # 先按文档序建立 运行时id→元素 注册表（与前端清单/inspect 完全同源）
            acc, rej = eng.resolve_decisions(decisions)
            acc_m, rej_m = eng.resolve_paragraph_marks(decisions)
            doc.save(args["output"])
            ins, del_, items = eng.revisions()
            print(json.dumps({"ok": True, "accepted": acc + acc_m, "rejected": rej + rej_m,
                              "ins": ins, "del": del_, "total": ins + del_, "revisions": items}, ensure_ascii=False))
        elif mode == "inspect":
            ins, del_, items = eng.revisions()
            print(json.dumps({"ok": True, "ins": ins, "del": del_, "total": ins + del_, "revisions": items},
                             ensure_ascii=False))
        else:
            print(json.dumps({"ok": False, "error": "未知 mode: %s" % mode}))
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e))}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
