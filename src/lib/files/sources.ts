/**
 * 文件来源实现（Step 2）
 *
 * - LocalSource / ProjectSource：完整实现（UnifiedViewer 当前两条路径）
 * - AttachmentSource / MaterialSource：骨架（search 走全局检索，read 委托项目来源）
 *
 * 所有来源仅做前端适配，后端路由保持不变（保守策略）。
 */
import type {
  IFileSource,
  IWritableSource,
  FileInfo,
  SearchHit,
} from './types';
import { registerSource } from './registry';

/** 将后端 read_file 响应归一化为 FileInfo */
function toFileInfo(data: {
  success: boolean;
  type?: 'text' | 'image' | 'binary';
  content?: string;
  size?: number;
  extension?: string;
  name?: string;
  full_path?: string;
}): FileInfo {
  if (!data.success) throw new Error('读取失败');
  return {
    name: data.name || '',
    type: data.type || 'binary',
    content: data.content,
    size: data.size || 0,
    extension: data.extension || '',
    full_path: data.full_path,
  };
}

/** 本地文件来源（对应右侧"电脑目录"浏览器） */
class LocalSource implements IFileSource {
  readonly kind = 'local' as const;
  readonly label = '本地文件';
  readonly capabilities = { writable: false, searchable: true, watchable: true };

  async read(path: string): Promise<FileInfo> {
    const resp = await fetch(`/api/local-files?action=read_file&path=${encodeURIComponent(path)}`);
    return toFileInfo(await resp.json());
  }

  async proxy(path: string): Promise<string> {
    return `/api/local-files?action=file_proxy&path=${encodeURIComponent(path)}`;
  }

  async search(query: string): Promise<SearchHit[]> {
    const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}&scope=local`);
    const data = await resp.json();
    return data.success ? (data.results || []) : [];
  }
}

/** Outbox 暂存区相对路径（outbox/<batch>/homework/x.md）：不属于任何项目，走 /api/outbox 读取 */
function isOutboxRel(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return p.startsWith('outbox/') && !p.includes('..');
}

/** 项目文件来源（对应左侧项目文件树；可写，保留编辑回写语义） */
class ProjectSource implements IFileSource, IWritableSource {
  readonly kind = 'project' as const;
  readonly label = '项目文件';
  readonly capabilities = { writable: true, searchable: true, watchable: false };

  private async currentProjectId(): Promise<string> {
    const resp = await fetch('/api/projects');
    const data = await resp.json();
    if (!data.success) throw new Error('无法获取当前项目');
    return data.current_id || '';
  }

  async read(path: string): Promise<FileInfo> {
    // Butler 产物暂存在 Outbox（未归口）：不在项目目录下，改走暂存区只读通道
    if (isOutboxRel(path)) {
      const resp = await fetch(`/api/outbox?action=read_file&path=${encodeURIComponent(path)}`);
      return toFileInfo(await resp.json());
    }
    const projectId = await this.currentProjectId();
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read_file', project_id: projectId, file_path: path }),
    });
    return toFileInfo(await resp.json());
  }

  async proxy(path: string): Promise<string> {
    if (isOutboxRel(path)) return `/api/outbox?action=file_proxy&path=${encodeURIComponent(path)}`;
    const projectId = await this.currentProjectId();
    return `/api/projects?action=file_proxy&project_id=${encodeURIComponent(projectId)}&file_path=${encodeURIComponent(path)}`;
  }

  async search(query: string): Promise<SearchHit[]> {
    const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}&scope=project`);
    const data = await resp.json();
    return data.success ? (data.results || []) : [];
  }

  // ---- IWritableSource ----
  async write(path: string, content: string): Promise<void> {
    const projectId = await this.currentProjectId();
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'write_file', project_id: projectId, file_path: path, content }),
    });
  }

  async rename(path: string, newName: string): Promise<{ newPath: string }> {
    const projectId = await this.currentProjectId();
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rename_file', project_id: projectId, file_path: path, new_name: newName }),
    });
    const data = await resp.json();
    return { newPath: data.path || data.new_path || path };
  }

  async remove(path: string): Promise<void> {
    const projectId = await this.currentProjectId();
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_file', project_id: projectId, file_path: path }),
    });
  }
}

/** 附件相对项目根的路径归一：新附件物理统一在 materials/ 下，历史附件仍在 attachments/
 *  （更早为 assets/，按旧规则映射回 attachments/）；无前缀的裸名按新布局归入 materials/。 */
function normalizeAttachmentRel(path: string): string {
  const p = path.replace(/\\/g, '/');
  if (p.startsWith('materials/') || p.startsWith('attachments/')) return p;
  if (p.startsWith('assets/')) return `attachments/${p.slice('assets/'.length)}`;
  return `materials/${p}`;
}

/** 附件来源（骨架：检索 + 读取委托项目来源） */
class AttachmentSource implements IFileSource {
  readonly kind = 'attachment' as const;
  readonly label = '附件';
  readonly capabilities = { writable: true, searchable: true, watchable: false };

  async read(path: string): Promise<FileInfo> {
    return new ProjectSource().read(normalizeAttachmentRel(path));
  }

  async proxy(path: string): Promise<string> {
    return new ProjectSource().proxy(normalizeAttachmentRel(path));
  }

  async search(query: string): Promise<SearchHit[]> {
    const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}&scope=project`);
    const data = await resp.json();
    return data.success ? (data.results || []).filter((r: SearchHit) => r.source === 'attachment') : [];
  }
}

/** 素材来源（骨架） */
class MaterialSource implements IFileSource {
  readonly kind = 'material' as const;
  readonly label = '素材';
  readonly capabilities = { writable: false, searchable: true, watchable: false };

  async read(path: string): Promise<FileInfo> {
    return new ProjectSource().read(`materials/${path.replace(/^materials\//, '')}`);
  }

  async proxy(path: string): Promise<string> {
    return new ProjectSource().proxy(`materials/${path.replace(/^materials\//, '')}`);
  }

  async search(query: string): Promise<SearchHit[]> {
    const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}&scope=project`);
    const data = await resp.json();
    return data.success ? (data.results || []).filter((r: SearchHit) => r.source === 'material') : [];
  }
}

/**
 * 临时（未保存）文档存储：path → FileInfo，进程内内存有效、刷新即失。
 * 用于承载"先生成、后决定存哪"的结果（如会议纪要草稿），内容只读展示。
 */
const transientFiles = new Map<string, FileInfo>();

/**
 * 登记一份临时文档并返回其 transient 路径（调用方随后自行发布 file.open）。
 * @param name          展示用文件名（决定扩展名 → 匹配渲染器，如 "会议纪要.md"）
 * @param content       文本内容
 * @param suggestedPath 建议落盘路径（存于 FileInfo.full_path，供"Save to current project"使用）
 */
export function putTransientFile(name: string, content: string, suggestedPath?: string): string {
  const path = `transient://${Date.now().toString(36)}/${encodeURIComponent(name)}`;
  const dot = name.lastIndexOf('.');
  transientFiles.set(path, {
    name,
    type: 'text',
    content,
    size: content.length,
    extension: dot >= 0 ? name.slice(dot) : '',
    full_path: suggestedPath,
  });
  return path;
}

/** 临时来源（内存）：只读展示未保存结果；搜索/监听不支持，内容无后端代理 */
class TransientSource implements IFileSource {
  readonly kind = 'transient' as const;
  readonly label = '未保存';
  readonly capabilities = { writable: false, searchable: false, watchable: false };

  async read(path: string): Promise<FileInfo> {
    const f = transientFiles.get(path);
    if (!f) throw new Error('未保存内容已失效');
    return f;
  }

  async proxy(): Promise<string> {
    // 内存内容无代理 URL；文本渲染器直接消费 read() 返回的 content
    return '';
  }
}

/** 注册全部来源（应用启动时调用一次） */
export function registerFileSources(): void {
  registerSource(new LocalSource());
  registerSource(new ProjectSource());
  registerSource(new AttachmentSource());
  registerSource(new MaterialSource());
  registerSource(new TransientSource());
}
