import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';

const APP_ROOT = resolveAppRoot();

interface TodoTask {
  title: string;
  start_time: string;
  end_time?: string | null;
  all_day?: boolean;
  priority: 'high' | 'normal' | 'low';
  category_path?: string[];  // 主题层级，如 ["工作", "项目A"]
  description?: string;
  source_raw?: string;
}

/** 关键词推断层级分类（模型未返回 category_path 时的降级方案） */
function inferCategoryPath(task: TodoTask): string[] {
  const text = `${task.title} ${task.description || ''} ${task.source_raw || ''}`.toLowerCase();
  if (/会议|开会|讨论|评审|汇报|周会|例会|站会/.test(text)) return ['工作', '会议'];
  if (/开发|代码|bug|修复|上线|部署|发布|测试|单元测试/.test(text)) return ['工作', '开发'];
  if (/文档|写|报告|方案|设计|画|图表|ppt|md|笔记/.test(text)) return ['工作', '文档'];
  if (/学习|阅读|看|课程|教程|视频|书/.test(text)) return ['学习'];
  if (/邮件|回复|联系|沟通|约|拜访|客户|对接/.test(text)) return ['工作', '沟通'];
  if (/运动|跑步|健身|吃饭|买菜|家务|医院|体检/.test(text)) return ['生活'];
  if (/计划|规划|安排|整理|梳理|复盘|总结/.test(text)) return ['工作', '规划'];
  return ['其他'];
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    const wantedDir = join(APP_ROOT, 'wanted');
    const todoPath = join(wantedDir, 'todo.md');

    // 确保目录存在（兼容已有项目）
    try {
      await access(wantedDir);
    } catch {
      await mkdir(wantedDir, { recursive: true });
    }

    // 确保文件存在
    try {
      await access(todoPath);
    } catch {
      await writeFile(todoPath, `# TODO 待办记录

> 记录 WANTED 面板添加的所有待办事项，按主题层级分类

`, 'utf-8');
    }

    if (action === 'read') {
      const { filter, category } = body;
      const content = await readFile(todoPath, 'utf-8');
      
      // 按分类/日期过滤
      if (filter === 'recent' || filter === 'week') {
        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 86400000);
        const lines = content.split('\n');
        const recentLines: string[] = [];
        let inRecentSection = false;
        let currentDate = '';
        let isHeader = false;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // 检测日期标题 ## YYYY-MM-DD
          const dateMatch = line.match(/^## (\d{4}-\d{2}-\d{2})/);
          if (dateMatch) {
            const d = new Date(dateMatch[1]);
            inRecentSection = d >= weekAgo;
            currentDate = dateMatch[1];
            if (inRecentSection) {
              recentLines.push(line);
              // 收集该日期下的所有任务
              let j = i + 1;
              while (j < lines.length && !lines[j].match(/^## /)) {
                recentLines.push(lines[j]);
                j++;
              }
            }
            continue;
          }
          if (inRecentSection) {
            recentLines.push(line);
          }
        }

        if (category) {
          const filtered = recentLines.filter(l => {
            if (l.startsWith('#')) return true; // 保留标题
            if (l.startsWith('>')) return true; // 保留引用
            return l.includes(`[${category}]`);
          });
          return NextResponse.json({ success: true, content: filtered.join('\n'), path: todoPath });
        }

        return NextResponse.json({ success: true, content: recentLines.join('\n'), path: todoPath });
      }

      if (category) {
        const lines = content.split('\n').filter(l => {
          if (l.startsWith('#')) return true;
          if (l.startsWith('>')) return true;
          return l.includes(`[${category}]`);
        });
        return NextResponse.json({ success: true, content: lines.join('\n'), path: todoPath });
      }

      return NextResponse.json({ success: true, content, path: todoPath });
    }

    if (action === 'append') {
      const { tasks } = body as { tasks: TodoTask[] };
      if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
        return NextResponse.json({ error: 'tasks array is required' }, { status: 400 });
      }

      let content = await readFile(todoPath, 'utf-8');
      const lines = content.split('\n');

      /** 在指定位置后插入行 */
      function insertLines(atLine: number, newLines: string[]) {
        // 在 atLine 之后的行之前插入
        lines.splice(atLine + 1, 0, ...newLines);
      }

      /** 查找或创建主题层级路径，返回插入位置的行号（插入到该标题所属区域的末尾，下一个同级/上级标题之前） */
      function ensureCategoryPath(categoryPath: string[]): number {
        let searchFromLine = 0;
        let depth = 0;

        for (const segment of categoryPath) {
          depth++;
          const prefix = '#'.repeat(depth + 1) + ' '; // ## for level1, ### for level2, #### for level3
          const heading = prefix + segment;

          // 在当前搜索范围内查找该标题
          let found = false;
          for (let i = searchFromLine; i < lines.length; i++) {
            if (lines[i].trim() === heading) {
              searchFromLine = i;
              found = true;
              break;
            }
          }

          if (!found) {
            // 需要创建该标题：找到同级标题的插入位置
            const headingLevel = depth + 1; // ## = 2, ### = 3, #### = 4

            // 找到该级别或更高级别的下一个标题
            let insertAt = lines.length - 1;
            for (let i = searchFromLine + 1; i < lines.length; i++) {
              const match = lines[i].match(/^(#{2,4})\s/);
              if (match && match[1].length <= headingLevel) {
                insertAt = i - 1;
                break;
              }
            }
            // 确保插入点之前有空行
            if (insertAt < lines.length - 1 && lines[insertAt].trim() !== '') {
              insertLines(insertAt, ['']);
              insertAt++;
            }
            insertLines(insertAt, [heading, '']);
            searchFromLine = insertAt + 2; // 跳过标题和空行
          }
        }

        // 找到该路径下最后一个任务的下一行（下一个同级/上级标题之前）
        let insertAfter = searchFromLine;
        const minLevel = categoryPath.length + 1; // 这个标题的 # 数量
        for (let i = searchFromLine + 1; i < lines.length; i++) {
          const match = lines[i].match(/^(#{2,4})\s/);
          if (match && match[1].length <= minLevel) {
            break;
          }
          insertAfter = i;
        }
        return insertAfter;
      }

      for (const t of tasks) {
        const categoryPath = (t.category_path && t.category_path.length > 0)
          ? t.category_path.slice(0, 3)
          : inferCategoryPath(t);

        const insertAt = ensureCategoryPath(categoryPath);

        const timeStr = t.all_day
          ? '全天'
          : (t.end_time
            ? `${formatTime(t.start_time)} - ${formatTime(t.end_time)}`
            : formatTime(t.start_time));

        const priorityEmoji = t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🟢' : '🟡';

        const taskLines: string[] = [];
        taskLines.push(`- [ ] ${priorityEmoji} ${t.title}`);
        taskLines.push(`  - 时间: ${timeStr}`);
        taskLines.push(`  - 优先级: ${t.priority}`);
        if (t.description) taskLines.push(`  - 描述: ${t.description}`);
        if (t.source_raw) taskLines.push(`  - 原文: ${t.source_raw.replace(/\n/g, ' ')}`);
        taskLines.push('');

        // 确保插入位置后有空行
        insertLines(insertAt, taskLines);
      }

      content = lines.join('\n');
      await writeFile(todoPath, content, 'utf-8');
      return NextResponse.json({ success: true, message: `Appended ${tasks.length} tasks`, path: todoPath });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    console.error('todo API error:', e);
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('project_id');
  const filter = searchParams.get('filter') || 'all';
  const category = searchParams.get('category') || '';

  if (!projectId) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  }

  // 复用 POST 的 read action
  const body = { action: 'read' as const, project_id: projectId, filter, category: category || undefined };
  const req = new NextRequest(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } as any);
  return POST(req);
}
