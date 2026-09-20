/**
 * components/canvas/ext-icons.tsx — Extensions Store 条目图标
 *
 * 官方条目按名称/场景/分类派生语义图标；非官方（第三方导入/自定义）统一用
 * 第三方图标（Puzzle）区分。仅输出 lucide 图标组件，无样式副作用。
 */

import {
  Scale,
  FileText,
  Palette,
  Code2,
  Sparkles,
  BookOpen,
  Globe,
  Users,
  Cpu,
  CheckSquare,
  Puzzle,
  Wand2,
  LayoutTemplate,
  GitFork,
  MonitorPlay,
  Scissors,
  Send,
  ClipboardList,
  Star,
  Receipt,
  ScanText,
  Map as MapIcon,
  type LucideIcon,
} from 'lucide-react';

/** 第三方来源通用图标 */
export const THIRD_PARTY_ICON: LucideIcon = Puzzle;

/** Skill 官方图标：先按技能名特化，再按 scenes 场景回退 */
export function officialSkillIcon(name: string, scenes: string[] = []): LucideIcon {
  const byName: Record<string, LucideIcon> = {
    'skill-creator': Wand2,
    'user-guide': BookOpen,
    'bob-ui': LayoutTemplate,
    'bob-html-artifact': LayoutTemplate,
    'slide-craft': Palette,
    'xhs-rewrite': Star,
    'meeting-minutes': ClipboardList,
    'bob-bank-statement': Receipt,
    'video-split': Scissors,
    'hand-drawn-map': MapIcon,
  };
  if (byName[name]) return byName[name];
  const scene = scenes[0];
  switch (scene) {
    case 'legal': return Scale;
    case 'office': return FileText;
    case 'docs': return FileText;
    case 'design': return Palette;
    case 'dev': return Code2;
    case 'lark': return Send;
    case 'bob-work': return Sparkles;
    default: return Sparkles;
  }
}

/** MCP 官方图标：按 category 映射 */
export function officialMcpIcon(category: string): LucideIcon {
  switch (category) {
    case 'Workflow': return Users;
    case 'Preview': return MonitorPlay;
    case 'Knowledge': return BookOpen;
    case 'Browser': return Globe;
    case 'Automation': return Cpu;
    case 'Coding': return Code2;
    case 'Productivity': return CheckSquare;
    case 'Legal': return Scale;
    case 'OCR': return ScanText;
    default: return Globe;
  }
}

/** 是否第三方来源（false 官方随包 / true 外部导入·自定义） */
export const isThirdParty = (official: boolean): boolean => !official;

/** 技能条目图标：official（内置/随包官方下载）→ 名称/scene 语义图标；第三方导入 → Puzzle */
export function skillEntryIcon(name: string, scenes: string[], official: boolean) {
  return official ? officialSkillIcon(name, scenes) : THIRD_PARTY_ICON;
}

/** MCP 条目图标：按 category 语义图标；无分类（自定义/未知来源）→ Puzzle */
export function mcpEntryIcon(category?: string) {
  return category ? officialMcpIcon(category) : THIRD_PARTY_ICON;
}

/** GitFork 兜底再导出（防未来 import 遗漏） */
export const FORK_ICON: LucideIcon = GitFork;
