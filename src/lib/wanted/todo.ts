/**
 * TODO 待办共享类型与分类推断逻辑：供 /api/todo（WANTED 面板）使用。
 * 待办数据统一存储在 events 表（SSOT），本模块仅保留纯类型定义与分类推断，不再读写 todo.md。
 */

export interface TodoTask {
  title: string;
  start_time?: string | null;
  end_time?: string | null;
  all_day?: boolean;
  priority: 'high' | 'normal' | 'low';
  category_path?: string[];  // 主题层级，如 ["工作", "项目A"]
  location?: string;          // 地点
  description?: string;
  source_raw?: string;
}

/** 关键词推断层级分类（模型未返回 category_path 时的降级方案） */
export function inferCategoryPath(task: TodoTask): string[] {
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
