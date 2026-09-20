/**
 * Agent 工具系统 — notebook 场景（bob-notes 个人 wiki / Kar 知识库节点）
 * 从 tools/index.ts 抽出：14 个 notebook 场景工具的定义与 executor（读/写/编译/维护回路）。
 * 依赖方向单向：仅 import shared.ts 的公共助手（truncate），
 * 仅以 import type 依赖 index.ts 的类型（编译期擦除），不产生运行时循环依赖。
 */

import { truncate } from './shared';
import type { Tool } from './index';

/** read_notebook 工具 — 读取 Karpathy 式个人 wiki（索引优先 + 关键词，无向量检索）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_query（插件数据层）。 */
async function toolReadNotebook(args: Record<string, unknown>): Promise<string> {
  const mode = (args.mode as string) || 'index'; // index | full
  const query = (args.query as string) || ''; // 关键词（标题 + 标签 + 正文）
  const tag = (args.tag as string) || ''; // 标签精确匹配；逗号分隔多项 = AND

  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const queryArgs: Record<string, unknown> = {};
    if (query.trim()) queryArgs.q = query.trim();
    if (tag.trim()) queryArgs.tag = tag.trim();
    // 有词/标签检索时后端按 full 返回（命中候选才读正文，IO 可控），
    // 使 index 模式命中条目也能带摘要片段；纯浏览（无词）才用 index（零正文 IO）
    queryArgs.mode = mode === 'full' || query.trim() || tag.trim() ? 'full' : 'index';
    const r = await callNotes('query', queryArgs);
    if (!r.ok) return `Error reading Wiki: ${r.error}`;
    const data = r.data || {};
    const entries = Array.isArray(data.entries) ? (data.entries as Array<Record<string, unknown>>) : [];
    const total = typeof data.total === 'number' ? data.total : entries.length;
    const groups = Array.isArray(data.groups) ? (data.groups as Array<{ name?: string; tags?: Array<{ tag?: string; count?: number }> }>) : [];

    if (total === 0) {
      return 'Wiki is empty. No notes have been compiled yet. Use /note or /clip in the WANTED panel to drop material — it will be compiled into the wiki.';
    }

    if (mode === 'index') {
      // 检索场景：返回命中分布（基于命中结果重新计数）
      const labelOf: Record<string, string> = { type: '类型', topics: '主题' };
      const indexText = groups.length === 0
        ? '（暂无标签）'
        : groups.map((g) => {
            const items = (g.tags || []).map((t) => `${t.tag ?? ''}（${t.count ?? 0} 条）`).join('  ');
            return `【${labelOf[g.name ?? ''] ?? g.name}】${items}`;
          }).join('\n');
      let out = `Wiki 索引（共 ${total} 条笔记，命中 ${entries.length} 条）：\n${indexText}`;
      if (query.trim() || tag.trim()) {
        out += `\n\n命中条目：\n${renderNoteLines(entries, false, true)}`;
      }
      return out.length > 5000 ? truncate(out, 5000) : out;
    }

    // full 模式：命中 ≤3 条 → 完整正文；多条 → 只给标题+摘要+id（省 token，需要全文用 read_note id）
    if (entries.length === 0) {
      return `No notes found${query ? ` matching "${query}"` : ''}${tag ? ` with tag "${tag}"` : ''}. Use read_notebook (default index mode) to browse the index.`;
    }
    const out =
      entries.length <= 3
        ? renderNoteLines(entries, true)
        : `命中 ${entries.length} 条（内容较多，仅列摘要；需要某条完整正文请用 read_note <id>）：\n${renderNoteLines(entries, false, true)}`;
    return out.length > 5000 ? truncate(out, 5000) : out;
  } catch (e) {
    return `Error reading Wiki: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** read_note 工具 — 按 id 读单条 wiki 笔记完整正文（read_notebook 命中多条只给摘要时，用它精读确认）。
 *  经宿主 callNotes('get') 转发 bob-notes-mcp notes_get（插件数据层）。 */
async function toolReadNote(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return 'Error: id required（笔记 id 必填，read_notebook 命中条目会带 id）';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('get', { id });
    if (!r.ok) return `Error reading note: ${r.error}`;
    const entry = ((r.data || {}).entry || {}) as Record<string, unknown>;
    const title = String(entry.title ?? '');
    const tagsArr = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];
    const tags = tagsArr.length > 0 ? `[${tagsArr.join(' · ')}] ` : '';
    const d = entry.date ? `（${entry.date}）` : '';
    const body = String(entry.content ?? '').trim();
    // 关联展示（🔗）：让 AI 精读时看到这篇连着谁（出链+反链），支持顺链理解/追问
    const linkedRaw = (entry.linked ?? null) as { out?: Array<{ id?: string; title: string; resolved: boolean }>; in?: Array<{ id?: string; title: string; resolved: boolean }> } | null;
    const linkedParts: string[] = [];
    if (linkedRaw) {
      const out = Array.isArray(linkedRaw.out) ? linkedRaw.out : [];
      const inRefs = Array.isArray(linkedRaw.in) ? linkedRaw.in : [];
      if (out.length > 0) linkedParts.push(`关联出链：${out.map((l) => l.title).join(' / ')}`);
      if (inRefs.length > 0) linkedParts.push(`被这些笔记关联：${inRefs.map((l) => l.title).join(' / ')}`);
    }
    const head = `- 💡 ${tags}${title}${d}`;
    const linkLine = linkedParts.length > 0 ? `\n🔗 ${linkedParts.join('；')}` : '';
    if (!body) return `${head}${linkLine}`;
    return `${head}${linkLine}\n${body}`;
  } catch (e) {
    return `Error reading note: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** read_note_history 工具 — 查看某条 wiki 笔记的历史版本列表（正文每次被覆盖前自动快照）。
 *  经宿主 callNotes('history') 转发 bob-notes-mcp notes_history。供模型判断"是否被改坏需回滚"。 */
async function toolReadNoteHistory(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return 'Error: id required（笔记 id 必填）';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('history', { id });
    if (!r.ok) return `Error reading history: ${r.error}`;
    const data = (r.data || {}) as { snapshots?: Array<{ time: number }>; title?: string };
    const snaps = Array.isArray(data.snapshots) ? data.snapshots : [];
    if (snaps.length === 0) return `笔记「${data.title || id}」暂无历史版本（从未被覆盖）。`;
    const lines = snaps.map((s, i) => {
      const t = new Date(s.time);
      const p = (n: number) => String(n).padStart(2, '0');
      return `${i + 1}. ${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())} (time=${s.time})`;
    });
    return `「${data.title || id}」历史版本（共 ${snaps.length} 个，最新的在前）：\n${lines.join('\n')}\n需要回滚时用 restore_note <id> <time>。`;
  } catch (e) {
    return `Error reading history: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** restore_note 工具 — 把笔记回滚到某历史版本（正文回滚；类型/标签/链接保留当前；回滚本身也留档可反悔）。
 *  仅当用户明确要求恢复旧版本时调用；id 用 read_note 的 w-xxx，time 用 read_note_history 返回的 time 值。 */
async function toolRestoreNote(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const time = Number(args.time);
  if (!id) return 'Error: id required（笔记 id 必填）';
  if (!Number.isFinite(time) || time <= 0) return 'Error: time required（历史版本 time，用 read_note_history 查看）';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('restore', { id, time });
    if (!r.ok) return `恢复失败: ${r.error}`;
    const data = (r.data || {}) as { reply?: string };
    return data.reply || '已恢复到该历史版本。';
  } catch (e) {
    return `恢复失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 把 notes_query 返回的条目渲染为模型可读文本（展示层，非笔记实现）
 *  digest=true 时只列标题+标签+摘要（省 token 的浏览形态，供 read_note <id> 精读前筛选） */
function renderNoteLines(
  entries: Array<Record<string, unknown>>,
  withBody: boolean,
  digest = false,
): string {
  if (entries.length === 0) return '（无匹配条目）';
  return entries
    .map((e) => {
      const id = String(e.id ?? '');
      const title = String(e.title ?? '');
      const tagsArr = Array.isArray(e.tags) ? (e.tags as string[]) : [];
      const tags = tagsArr.length > 0 ? `[${tagsArr.join(' · ')}] ` : '';
      const d = e.date ? `（${e.date}）` : '';
      const head = `- 💡 ${tags}${title}${d}`;
      if (digest) {
        const body = String(e.content ?? '').replace(/\s+/g, ' ').trim();
        const excerpt = body ? `\n  ${body.slice(0, 200)}${body.length > 200 ? '…' : ''}` : '';
        return `${head}\n  id: ${id}${excerpt}`;
      }
      const body = withBody ? String(e.content ?? '') : '';
      return body ? `${head}\n  ${body}` : head;
    })
    .join('\n\n');
}

/** update_notebook 工具 — 按 id 修改一条 wiki 笔记（只改传入字段，title/tags/content 未传则保留）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_update（插件数据层）。 */
async function toolUpdateNotebook(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return 'Error: id required（笔记 id 必填，可用 read_notebook full 模式或 /note check 查看）';
  const patch: { title?: string; content?: string; tags?: string[] } = {};
  if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim();
  if (typeof args.content === 'string' && args.content.trim()) patch.content = args.content.trim();
  if (Array.isArray(args.tags)) {
    const tags = args.tags.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 5);
    if (tags.length > 0) patch.tags = tags;
  }
  if (patch.title === undefined && patch.content === undefined && patch.tags === undefined) {
    return 'Error: title / content / tags required（至少提供新标题 title、新内容 content 或新标签 tags 之一）';
  }
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('update', { id, ...patch });
    if (!r.ok) return `修改笔记失败: ${r.error}`;
    const data = r.data || {};
    const entry = (data.entry || {}) as Record<string, unknown>;
    const title = String(entry.title ?? '');
    const tagsArr = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];
    const tagStr = tagsArr.length > 0 ? `[${tagsArr.join('/')}] ` : '';
    const date = entry.date ? String(entry.date) : '';
    const body = patch.content || String(entry.content ?? '');
    return `已修改笔记「${title}」${tagStr}（${date || '无日期'}）：\n${body}`;
  } catch (e) {
    return `修改笔记失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** delete_notebook 工具 — 按 id 删除一条 wiki 笔记（不可恢复）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_delete（插件数据层）。 */
async function toolDeleteNotebook(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return 'Error: id required（笔记 id 必填，可用 read_notebook full 模式或 /note check 查看）';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('delete', { id });
    if (!r.ok) return `删除笔记失败: ${r.error}`;
    const data = r.data || {};
    const title = String(data.title ?? '');
    const remain = typeof data.remaining === 'number' ? data.remaining : '';
    return `已删除笔记「${title}」${remain !== '' ? `（剩余 ${remain} 条）` : ''}。`;
  } catch (e) {
    return `删除笔记失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** write_notebook_answer 工具 — 答案回填：把 AI 问答/分析的产出沉淀为 wiki 笔记（Karpathy 知识复利）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_backfill（插件数据层）。 */
async function toolWriteNotebookAnswer(args: Record<string, unknown>): Promise<string> {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!title && !content) return 'Error: title / content required（回填需要标题 title 或内容 content 至少一个）';
  const tags = Array.isArray(args.tags) ? args.tags.filter((s): s is string => typeof s === 'string') : [];
  const links = Array.isArray(args.links) ? args.links.filter((s): s is string => typeof s === 'string') : [];
  // 类型白名单不在这里判断：原样透传给插件，由插件按 SCHEMA.md「页面类型」段校验/回退缺省
  const type = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : 'synthesis';
  const mergeInto = typeof args.merge_into === 'string' ? args.merge_into.trim() : '';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('backfill', { title, content, tags, links, type, ...(mergeInto ? { merge_into: mergeInto } : {}) });
    if (!r.ok) return `回填失败: ${r.error}`;
    const data = r.data || {};
    const entry = (data.entry || {}) as Record<string, unknown>;
    if (!entry || !(entry.id || entry.title)) {
      return String(data.reply || '回填完成');
    }
    const et = String(entry.title ?? '');
    const tagsArr = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];
    const body = String(entry.content ?? '');
    const actionNote = data.merged ? '（已归并更新既有笔记，未新建）' : '';
    return `${data.reply ?? '已回填'}${actionNote}\n标题：${et}\n标签：[${tagsArr.join(' · ') || '无'}]\n内容：\n${body}`;
  } catch (e) {
    return `回填失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** create_note 工具 — 用户主动记笔记（Karpathy raw-first）：内容作为素材投放 raw/ 并触发一次编译，
 *  由插件大脑决定标题/结构/标签并把同主题内容归并入既有笔记（更正/新知识自动更新原条目）。
 *  与 /note 语义等价；不再由人/对话模型直写 wiki 层。 */
async function toolCreateNote(args: Record<string, unknown>): Promise<string> {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!title && !content) return 'Error: title / content required（内容必填）';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const add = await callNotes('add_raw', { text: content, ...(title ? { title } : {}) });
    if (!add.ok) return `投放失败: ${add.error}`;
    const raw = (add.data || {}).raw as { id?: string; title?: string } | undefined;
    const ing = await callNotes('ingest', {});
    if (!ing.ok) return `素材已投放，但编译失败: ${ing.error}`;
    const d = ing.data || {};
    const entries = Array.isArray(d.entries) ? (d.entries as Array<Record<string, unknown>>) : [];
    const compiled = typeof d.compiled === 'number' ? d.compiled : 0;
    const label = raw?.title ?? title ?? content.slice(0, 20);
    if (compiled === 0) {
      return `已投放素材「${label}」，暂未生成新笔记（同主题可能已归并入既有条目，或待 ingest）。`;
    }
    const lines = entries.map((e, i) => `${i + 1}. ${String(e.title ?? '')}`).join('\n');
    return `已投放并编译「${label}」：${compiled} 条素材 → ${entries.length} 条笔记。同主题会自动归并入既有笔记——更正/新知识投喂后，大脑会把内容并入那篇原条目。\n${lines}`;
  } catch (e) {
    return `记录失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** ingest_notes 工具 — 编译 pending raw → wiki（Karpathy ingest 回路；note 节点独享）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_ingest，实际编译由插件大脑模型执行。 */
async function toolIngestNotes(args: Record<string, unknown>): Promise<string> {
  try {
    const idsRaw = args.ids;
    const ids = Array.isArray(idsRaw) ? idsRaw.map((s) => String(s)).filter(Boolean) : undefined;
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('ingest', ids && ids.length > 0 ? { ids } : {});
    if (!r.ok) return `编译失败: ${r.error}`;
    const data = r.data || {};
    const entries = Array.isArray(data.entries) ? (data.entries as Array<Record<string, unknown>>) : [];
    const compiled = typeof data.compiled === 'number' ? data.compiled : 0;
    if (compiled === 0) return String(data.reply || '没有待编译的素材');
    const lines = entries.map((e, i) => {
      const tags = Array.isArray(e.tags) && (e.tags as string[]).length ? ` [${(e.tags as string[]).join(' · ')}]` : '';
      return `${i + 1}. ${String(e.title ?? '')}${tags}`;
    });
    return `已编译 ${compiled} 条素材 → ${entries.length} 条笔记：\n${lines.join('\n')}`;
  } catch (e) {
    return `编译失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** read_raw_inbox 工具 — 列出 raw/ 素材箱清单（id/title/source/status/createdAt + 正文预览）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_raw_list（插件数据层）。
 *  用途：对话里先浏览素材 → 判断哪些待编译、哪些内容与既有 wiki 重复（可归并而非新建）。 */
async function toolReadRawInbox(args: Record<string, unknown>): Promise<string> {
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const statusArg = typeof args.status === 'string' ? args.status.trim() : '';
    const status = statusArg === 'compiled' || statusArg === 'uncompiled' ? statusArg : 'all';
    const r = await callNotes('raw_list', { status });
    if (!r.ok) return `读取素材箱失败: ${r.error}`;
    const d = (r.data || {}) as {
      total?: number; matched?: number; pending?: number;
      items?: Array<{ id?: string; title?: string; source?: string; status?: string; createdAt?: string; preview?: string }>;
    };
    const items = Array.isArray(d.items) ? d.items : [];
    if (items.length === 0) {
      const hint = status === 'all' ? '素材箱是空的。用 /clip 或 /note 投放素材后再来。' : `没有 ${status} 状态的素材。`;
      return hint;
    }
    const lines = items.map((it, i) => {
      const state = it.status === 'compiled' ? '✓已编译' : '· 待编译';
      const src = it.source ? ` 来源:${it.source}` : '';
      const time = it.createdAt ? `  ${(it.createdAt || '').slice(0, 10)}` : '';
      return `${i + 1}. [${it.id}] ${state} ${String(it.title || '').slice(0, 60)}${src}${time}\n   ${String(it.preview || '').slice(0, 90)}`;
    });
    return `Raw 素材箱（共 ${d.total ?? 0} 条，待编译 ${d.pending ?? 0}，命中 ${d.matched ?? items.length}）\n` + lines.join('\n');
  } catch (e) {
    return `读取素材箱失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** review_notes 工具 — 回看打捞：最久未回看笔记由插件大脑判断 rescue（置顶/重写）或 sink（下沉，不删除）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_review。 */
async function toolReviewNotes(): Promise<string> {
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('review', {});
    if (!r.ok) return `回看失败: ${r.error}`;
    const d = (r.data || {}) as { reply?: string; reviewed?: number; rescued?: number; sunk?: number };
    return String(d.reply || `回看完成：${d.reviewed ?? 0} 篇，rescue ${d.rescued ?? 0} / sink ${d.sunk ?? 0}`);
  } catch (e) {
    return `回看失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** lint_notes 工具 — 知识库自检：断链/孤立/重复标题（确定性）+ 跨笔记矛盾检测（插件大脑）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_lint。 */
async function toolLintNotes(): Promise<string> {
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('lint', {});
    if (!r.ok) return `自检失败: ${r.error}`;
    const d = (r.data || {}) as { reply?: string; issues?: unknown[] };
    const issues = Array.isArray(d.issues) ? (d.issues as string[]) : [];
    if (issues.length === 0) return String(d.reply || '自检通过：无断链、无孤立笔记、无重复标题、无表述矛盾。');
    return `发现 ${issues.length} 个问题：\n${issues.map((s) => `· ${s}`).join('\n')}`;
  } catch (e) {
    return `自检失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** read_note_rules 工具 — 读取知识库整理规则（SCHEMA.md，用户偏好宪章；note 节点独享）。
 *  大脑的 ingest/review 每次调用前都会读取并遵守它。 */
async function toolReadNoteRules(): Promise<string> {
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('schema_get', {});
    if (!r.ok) return `读取整理规则失败: ${r.error}`;
    const content = String((r.data || {}).content ?? '');
    if (!content) return '整理规则为空。';
    const truncated = content.length > 4000 ? `${content.slice(0, 4000)}\n…（截断）` : content;
    return `当前知识库整理规则（SCHEMA.md，大脑 ingest/review 每次调用前都会遵守）：\n${truncated}`;
  } catch (e) {
    return `读取整理规则失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** set_note_rules 工具 — 追加（默认）或覆写知识库整理规则（用户表达整理偏好时调用，note 节点独享） */
async function toolSetNoteRules(args: Record<string, unknown>): Promise<string> {
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!content) return 'Error: content required（需要规则/偏好内容）';
  const append = args.append === true || args.append === 'true';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('schema_set', { content, ...(append ? { append: true } : {}) });
    if (!r.ok) return `保存整理规则失败: ${r.error}`;
    const data = r.data || {};
    const note = String(data.note || '');
    if (append) {
      return note
        ? `⚠️ ${note}`
        : `✅ 已把这条整理偏好记入 SCHEMA.md（大脑下次 ingest/review 起遵守）：\n「${content}」`;
    }
    return `✅ 整理规则已保存。`;
  } catch (e) {
    return `保存整理规则失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * notebook 场景工具定义（bob-notes 个人 wiki）。
 * 定义顺序无关行为：registry.toApiFormat 按工具名 localeCompare 确定性排序。
 */
export const notebookToolDefs: Tool[] = [
  {
    name: 'read_notebook',
    description: 'Search/read personal notes from the Karpathy-style wiki (notes/wiki/, AI-compiled interlinked markdown with type/tags/links). query matches title+tags+content; tag filters exactly (comma = AND); no vector search. mode "index" (default) = type/topic index with counts, or per-hit id + short excerpt when searching (token-efficient); "full" = full note bodies when few hits (<=3), otherwise id + excerpts only — then call read_note <id> for a full note. Use when the user asks about their recorded notes/knowledge.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['index', 'full'],
          description: '"index" (default) = index with counts + hit excerpts; "full" = full note bodies when <=3 hits, else excerpts with ids.',
        },
        query: {
          type: 'string',
          description: 'Keyword to search (case-insensitive, matches title, tags and content). e.g. "读书" to find all notes mentioning reading.',
        },
        tag: {
          type: 'string',
          description: 'Exact tag to filter. Comma-separated multiple tags = AND, e.g. "证据链,合同".',
        },
        from: {
          type: 'string',
          description: 'Start date YYYY-MM-DD (inclusive) to filter notes by date.',
        },
        to: {
          type: 'string',
          description: 'End date YYYY-MM-DD (inclusive) to filter notes by date.',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolReadNotebook,
    maxOutput: 5000,
  },
  {
    name: 'read_note',
    description: 'Read ONE wiki note in full by id (w-xxx). Use after read_notebook returns hits as excerpts — each hit line carries "id: <id>". Prefer over read_notebook "full" mode when you need only one or two notes (token-efficient).',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Note id (w-xxx) shown in read_notebook hits.',
        },
      },
      required: ['id'],
    },
    category: '文件',
    execute: toolReadNote,
    maxOutput: 8000,
  },
  {
    name: 'read_note_history',
    description: 'List the saved version history of ONE wiki note (id w-xxx); each version has a "time". Use when the user suspects a note was corrupted by a bad compile/merge and asks "之前是什么样/能回滚吗" — then restore_note with the chosen time.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Note id (w-xxx).',
        },
      },
      required: ['id'],
    },
    category: '文件',
    execute: toolReadNoteHistory,
    maxOutput: 4000,
  },
  {
    name: 'restore_note',
    description: 'Restore a wiki note to a saved history version (id w-xxx + time from read_note_history). Rolls back the body only; type/tags/links stay current; the restore itself is also snapshotted (reversible). Call ONLY when the user explicitly asks to restore/revert a note.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Note id (w-xxx).',
        },
        time: {
          type: 'number',
          description: 'History version time (from read_note_history).',
        },
      },
      required: ['id', 'time'],
    },
    category: '文件',
    execute: toolRestoreNote,
    maxOutput: 3000,
  },
  {
    name: 'read_raw_inbox',
    description: 'List the raw/ inbox (material layer — clipped/saved but not yet compiled): each item with id (r-xxx), title, source URL, status (uncompiled/compiled) and body preview. Note-node only. Use FIRST when the user asks 素材箱里有什么 / inbox / 待编译素材 — then compare against notes via read_notebook, tell the user which raw items match existing notes (merge, not duplicate), and pass the chosen ids to ingest_notes.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['all', 'uncompiled', 'compiled'],
          description: 'Filter: all (default) / uncompiled=待编译 / compiled=已编译.',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolReadRawInbox,
    maxOutput: 5000,
    scenes: ['notebook'],
  },
  {
    name: 'update_notebook',
    description: 'Update one note in the wiki (notes/wiki/) by its id — only the provided fields (title/content/tags) change; others preserved. Use when the user asks to change a recorded note. Find the id first via read_notebook (full mode).',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Note id (e.g. "w-xxx"), shown by /note check mail or read_notebook full mode. Required.',
        },
        title: {
          type: 'string',
          description: 'New title for the note. Optional if content/tags is provided.',
        },
        content: {
          type: 'string',
          description: 'New full content of the note. Optional if title/tags is provided.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New free-form tags (max 5, 2-6 char short topic words). e.g. ["证据链", "合同"].',
        },
      },
      required: ['id'],
    },
    category: '文件',
    execute: toolUpdateNotebook,
    maxOutput: 3000,
  },
  {
    name: 'delete_notebook',
    description: 'Delete one note from the wiki (notes/wiki/) by its id. ONLY when the user explicitly asks to delete a specific note — never auto-delete. Find the id via read_notebook (full mode) or /note check mail; if unknown, ask the user. Irreversible.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Note id (e.g. "w-xxx"). Required. Find it via read_notebook full mode or the /note check mail.',
        },
      },
      required: ['id'],
    },
    category: '文件',
    execute: toolDeleteNotebook,
    maxOutput: 2000,
  },
  {
    name: 'write_notebook_answer',
    description: 'Backfill an answer/analysis into the personal wiki — the "answers compound into knowledge" loop. Call AFTER answering from read_notebook, when the user says 把答案记下来/存进笔记/沉淀一下 or the answer is worth keeping. Stored directly (no re-compile). MERGE-AWARE: exact same title (or merge_into) updates that note — new content first, old kept below a divider; brand-new topics create a note. Inline [[note title]] links in the body are merged into links automatically. type: note type key defined by SCHEMA.md "页面类型" (page types) section in the notes plugin (built-ins: concept/entity/source/note/synthesis/todo; default synthesis).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title of the note (<=20 chars). Required if content present.' },
        content: { type: 'string', description: 'The answer/analysis body (markdown). Reference other notes as [[their title]].' },
        type: { type: 'string', description: 'Note type key defined by the notes plugin SCHEMA.md page-types section (built-ins: concept/entity/source/note/synthesis/todo). Default synthesis; unknown keys are rejected by the plugin.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free topic tags (0-5, 2-6 char words). e.g. ["证据链"]' },
        links: { type: 'array', items: { type: 'string' }, description: 'Linked note titles or ids (the knowledge this answer builds on).' },
        merge_into: { type: 'string', description: 'Optional: title of an existing note to merge this answer into (updates it, does not create a duplicate). Omit to create a new note.' },
      },
      required: ['title', 'content'],
    },
    category: '文件',
    execute: toolWriteNotebookAnswer,
    maxOutput: 3000,
  },
  {
    name: 'create_note',
    description: 'Record material the user wants kept into the notes system (raw-first capture loop, equivalent to /note). Use when the user asks to record/save/keep something (帮我记一笔 / 把这段记到笔记里), shares an idea worth keeping, or corrects an earlier note. Content drops into raw/ and the notes brain compiles it — the brain decides title/type/tags/links and merges same-topic content into existing notes, so feed corrections here too. Only update_notebook/delete_notebook for structural fixes (rename/delete).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional short title/label for the material (<=30 chars). The brain decides the final wiki title.' },
        content: { type: 'string', description: 'The material body (markdown). Required. Corrections/updates of existing notes: put the new/corrected facts here.' },
      },
      required: ['content'],
    },
    category: '文件',
    execute: toolCreateNote,
    maxOutput: 4000,
    timeoutMs: 180000,
  },
  {
    name: 'ingest_notes',
    description: 'Compile pending raw material(s) into the wiki (Karpathy ingest) via the bob-notes-mcp brain model (its own separately-configured model). Pass ids (raw ids / r-xxx prefix) to compile only those; omit to compile all pending. Use when the user (in the notes node) asks to compile/整理/入库 raw material (等价 /note ingest).',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Optional raw ids (or r-xxx prefix) to compile; omit for all pending.' },
      },
    },
    category: '文件',
    execute: toolIngestNotes,
    maxOutput: 4000,
    scenes: ['notebook'],
  },
  {
    name: 'review_notes',
    description: 'Run the review & rescue pass over the wiki: picks the most stale notes; the notes brain decides rescue (promote/rewrite) or sink (demote, never delete). Use when the user asks 回看/打捞/review（等价 /note review）.',
    parameters: { type: 'object', properties: {} },
    category: '文件',
    execute: toolReviewNotes,
    maxOutput: 3000,
    scenes: ['notebook'],
  },
  {
    name: 'lint_notes',
    description: 'Health-check the wiki: broken links / orphan notes / duplicate titles (deterministic) + an LLM contradiction check across notes (brain model). Use when the user asks 自检/lint/查矛盾（等价 /note lint）.',
    parameters: { type: 'object', properties: {} },
    category: '文件',
    execute: toolLintNotes,
    maxOutput: 3000,
    scenes: ['notebook'],
  },
  {
    name: 'read_note_rules',
    description: 'Read the knowledge-base organizing rules (SCHEMA.md — the charter the notes brain loads before every ingest/review). Use before tweaking rules or when asked how notes get organized.',
    parameters: { type: 'object', properties: {} },
    category: '文件',
    execute: toolReadNoteRules,
    maxOutput: 4500,
    scenes: ['notebook'],
  },
  {
    name: 'set_note_rules',
    description: 'Record an organizing preference/rule the notes brain must follow (SCHEMA.md). Note-node only. VETO RIGHT: you may decline (do not call) a rule you judge unnecessary/vague/harmful/conflicting with knowledge-base boundaries (no deletion, no rewriting raw) — when declining, reply with the reason + a better suggestion. CALL ONLY when the user states a repeatable, concrete, executable preference with future intent ("以后这类素材都…", "帮我记一条整理规则：标签用两三个字"). DO NOT record one-off remarks about a single note, general chat habits (use remember_preference instead), or vague praise/criticism; if unsure, ask first ("要记成整理规则吗？"). Keep each rule <=120 chars. Default append:true — dedup + 24-item cap enforced server-side; when it reports "未记录", tell the user why and suggest consolidating.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Rule text (appends one preference line, or full replacement when append=false).' },
        append: { type: 'boolean', description: 'Default true = append; false = overwrite the whole SCHEMA.md.' },
      },
      required: ['content'],
    },
    category: '文件',
    execute: toolSetNoteRules,
    maxOutput: 3000,
    scenes: ['notebook'],
  },
];
