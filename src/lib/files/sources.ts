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
    const projectId = await this.currentProjectId();
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read_file', project_id: projectId, file_path: path }),
    });
    return toFileInfo(await resp.json());
  }

  async proxy(path: string): Promise<string> {
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

/** 注册全部来源（应用启动时调用一次） */
export function registerFileSources(): void {
  registerSource(new LocalSource());
  registerSource(new ProjectSource());
  registerSource(new AttachmentSource());
  registerSource(new MaterialSource());
}
