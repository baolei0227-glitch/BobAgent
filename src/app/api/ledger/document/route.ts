import { NextRequest, NextResponse } from 'next/server';
import { existsSync } from 'fs';
import { getCurrentProject, getProjectById } from '@/lib/project/project-manager';
import {
  ledgerHome,
  readLedgerEntry,
  readLedgerIndex,
  readProjectPage,
  type LedgerEntry,
  type ProjectPage,
} from '@/lib/mcp/ledger';

/**
 * GET /api/ledger/document
 * 编译文稿（虚拟视图，**不落盘**）：把账本 `wiki/` 内容按「最新在前」拼成一份可读文稿，
 * 供资料面板顶部的「Ledger」入口只读查看：账本里归并出了什么、出处是哪份材料、还有多少条待编译。
 *
 * 返回两部分（同一目录 wiki/，前缀区分）：
 *   - entries  —— `w-…` 概览条目（归并出的知识）；
 *   - projects —— `p-…` 项目页（要产出的事，含 stage 创作阶段）。
 *
 * Query:
 *   project_id  项目 id（缺省 = 当前项目）
 *
 * 只读：不写任何文件。项目还没有账本（从未登记过材料）时直接返回 empty，
 * 不为了看一眼而凭空建出 `.ledger/`。
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    const project = projectId ? await getProjectById(projectId) : await getCurrentProject();
    const base = {
      success: true as const,
      project_id: project.id,
      project_name: project.name,
    };

    if (!existsSync(ledgerHome(project.path))) {
      return NextResponse.json({
        ...base,
        hasLedger: false,
        empty: true,
        entries: [] as LedgerEntry[],
        projects: [] as ProjectPage[],
        wikiCount: 0,
        projectCount: 0,
        rawCount: 0,
        pending: 0,
        compiledAt: null as string | null,
      });
    }

    const { wiki, projects: projectItems, pending, total } = readLedgerIndex(project.path);
    // 索引只给元信息，正文按 id 逐条取（条目数在几十条量级，无需另做缓存）
    const entries: LedgerEntry[] = [];
    for (const item of wiki) {
      const entry = readLedgerEntry(project.path, item.id);
      if (entry) entries.push(entry);
    }
    // 项目页（p-…）：不走 readLedgerEntry，改走 readProjectPage 以取回 stage
    const projects: ProjectPage[] = [];
    for (const item of projectItems) {
      const page = readProjectPage(project.path, item.id);
      if (page) projects.push(page);
    }
    // 「编译时间」取最新一条条目的 updated（ISO 字符串按字典序比较即时间序）
    const compiledAt = entries.reduce<string | null>(
      (acc, e) => (e.updated && (!acc || e.updated > acc) ? e.updated : acc),
      null,
    );

    return NextResponse.json({
      ...base,
      hasLedger: true,
      empty: entries.length === 0,
      entries,
      projects,
      wikiCount: total.wiki,
      projectCount: projects.length,
      rawCount: total.raw,
      pending: pending.length,
      compiledAt,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'NO_PROJECT') {
      return NextResponse.json({ error: 'NO_PROJECT' }, { status: 404 });
    }
    console.error('[ledger/document] 读取编译文稿失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '读取编译文稿失败' },
      { status: 500 },
    );
  }
}
