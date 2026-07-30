---
title: install_skill 技能安装功能方案
created_at: 2026-07-30
status: draft
---

# install_skill 技能安装功能方案

## 现状

技能系统已具备加载、匹配、启用/禁用能力，但**安装只能通过文件系统手动操作**：

- 拖拽文件夹到 `~/BobAgent/skills/`
- AI 使用 `write_file` 写入 `SKILL.md`

没有专门的安装 API 或 UI 入口。

---

## 目标

新增 `install_skill` 能力，支持三种安装来源：

| 来源 | 示例 |
|------|------|
| GitHub URL | `https://github.com/user/my-skill` |
| 本地路径 | `/Users/xxx/Desktop/my-skill/` |
| Skill Hub URL | `https://clawhub.ai/skills/pdf-toolkit` |

---

## 技能包规范

一个合法的技能包必须包含：

```
my-skill/
├── SKILL.md          # 必须，含 frontmatter 元数据
└── references/       # 可选，引用文档
```

`SKILL.md` frontmatter 必填字段：

```yaml
---
name: my-skill            # 技能唯一标识
description: "..."        # 描述（用于关键词匹配）
default-enabled: false    # 安装后是否默认启用
---
```

---

## API 设计

### POST /api/skills/install

```json
// Request
{
  "source": "github",       // "github" | "local" | "url"
  "url": "https://github.com/user/my-skill",
  "autoEnable": true        // 安装后是否自动启用
}

// Response (200)
{
  "success": true,
  "skill": {
    "name": "my-skill",
    "description": "...",
    "source": "user",
    "enabled": true,
    "installedPath": "~/BobAgent/skills/my-skill"
  }
}

// Response (400)
{
  "success": false,
  "error": "SKILL.md not found or invalid format",
  "detail": "Missing required field: name"
}

// Response (409)
{
  "success": false,
  "error": "Skill 'my-skill' already installed",
  "detail": "Use force: true to overwrite"
}
```

### DELETE /api/skills/install?name=my-skill

卸载用户安装的技能（内置技能不可卸载）：

```json
{
  "success": true,
  "removedPath": "~/BobAgent/skills/my-skill"
}
```

---

## 安装流程

```
POST /api/skills/install
        │
        ▼
┌─ 1. 校验来源 ─────────────────────┐
│  github: clone repo 到临时目录      │
│  local:  验证路径存在               │
│  url:    下载 zip 解压到临时目录    │
└────────────────────────────────────┘
        │
        ▼
┌─ 2. 校验技能包 ───────────────────┐
│  检查 SKILL.md 存在                │
│  解析 frontmatter                  │
│  验证必填字段: name, description   │
│  检查 name 不冲突（内置/已安装）   │
└────────────────────────────────────┘
        │
        ▼
┌─ 3. 安装到用户目录 ───────────────┐
│  复制到 ~/BobAgent/skills/<name>/  │
│  写入 install.json 记录来源/时间   │
└────────────────────────────────────┘
        │
        ▼
┌─ 4. 注册 & 返回 ──────────────────┐
│  getAllSkills() 自动发现新技能      │
│  若 autoEnable，启用该技能          │
│  返回技能元数据                     │
└────────────────────────────────────┘
```

### 核心实现（install 函数）

```typescript
// lib/skills/installer-server.ts

interface InstallOptions {
  source: 'github' | 'local' | 'url';
  url?: string;
  localPath?: string;
  autoEnable?: boolean;
  force?: boolean;
}

interface InstallResult {
  success: boolean;
  skill?: SkillMeta;
  error?: string;
}

async function installSkill(opts: InstallOptions): Promise<InstallResult> {
  // 1. 获取技能包内容
  const tmpDir = await fetchSkillToTemp(opts);

  // 2. 校验
  const skillMd = path.join(tmpDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    return { success: false, error: 'SKILL.md not found' };
  }
  const meta = parseSkillFrontmatter(skillMd);
  if (!meta.name || !meta.description) {
    return { success: false, error: 'Missing required frontmatter fields' };
  }

  // 3. 冲突检测
  const targetDir = path.join(USER_SKILLS_DIR, meta.name);
  if (fs.existsSync(targetDir) && !opts.force) {
    return { success: false, error: `Skill '${meta.name}' already exists`, conflict: true };
  }

  // 4. 安装
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(tmpDir, targetDir, { recursive: true });

  // 5. 注册
  if (opts.autoEnable) {
    enableSkillForAgent(AGENT_ID, meta.name);
  }

  return { success: true, skill: meta };
}
```

### GitHub 下载方式选择

不使用 `git clone`（依赖系统安装 git），而是用 GitHub API 下载 zip：

```typescript
// 从 GitHub URL 提取 owner/repo
// https://github.com/baolei0227-glitch/my-skill → baolei0227-glitch/my-skill
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

// 下载 repo 的 main 分支 zip
// GET https://api.github.com/repos/{owner}/{repo}/zipball/main
async function downloadGitHubRepo(owner: string, repo: string): Promise<string> {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/zipball/main`,
    { headers: { Accept: 'application/vnd.github+json' } }
  );
  const buffer = await resp.arrayBuffer();
  // 解压到临时目录，找到 SKILL.md 所在的根目录
  return extractZipToTemp(buffer);
}
```

---

## UI 设计

### SkillManagerModal 新增安装入口

```
┌─ Skill Manager ────────────────────────────┐
│  [Installed]  [Discover]                    │
│                                              │
│  ┌─ Install Skill ────────────────────────┐ │
│  │  ┌────────────────────────────────────┐ │ │
│  │  │ https://github.com/user/my-skill   │ │ │
│  │  └────────────────────────────────────┘ │ │
│  │  [Install from GitHub]  [Install Local] │ │
│  └────────────────────────────────────────┘ │
│                                              │
│  ── Installed Skills ─────────────────────── │
│  ┌ character-creator  [builtin]  [✓] [×] ─┐ │
│  ┌ my-skill           [user]    [✓]  🗑   ┐ │
│  └─────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

### 安装进度

```
┌─ Installing my-skill ──────────────────────┐
│  ⏳ Downloading from GitHub...              │
│  ✓ Validating SKILL.md                     │
│  ✓ Copying to ~/BobAgent/skills/my-skill   │
│  ✓ Enabled                                 │
│                                              │
│  [Close]                                    │
└──────────────────────────────────────────────┘
```

---

## 文件清单

```
src/
├── lib/skills/
│   └── installer-server.ts          [新增] installSkill / uninstallSkill
├── app/api/skills/
│   ├── route.ts                     [修改] POST 增加 action: 'install' | 'uninstall'
│   └── install/
│       └── route.ts                 [新增] POST /api/skills/install 独立路由
└── components/canvas/
    └── SkillManagerModal.tsx         [修改] 增加安装入口和卸载按钮
```

---

## 实施步骤

| 步骤 | 内容 | 预计 |
|------|------|------|
| **1. 安装器** | `installer-server.ts`：下载、校验、复制、注册 | 1天 |
| **2. API** | `/api/skills/install` + `uninstall` 路由 | 0.5天 |
| **3. UI** | SkillManagerModal 增加安装输入框、进度提示、卸载按钮 | 1天 |
| **4. 测试** | 手动测试 GitHub 安装 / 本地安装 / 冲突覆盖 | 0.5天 |

---

## 安全考量

1. **路径穿越防护**：解压 zip 时过滤 `../` 路径
2. **大小限制**：技能包限制 10MB（SKILL.md 通常 < 50KB）
3. **名称校验**：技能名只允许 `[a-z0-9-_]`，防止路径注入
4. **来源白名单**：可配置允许的 GitHub org（可选，初期不限制）
5. **内置技能保护**：用户安装的技能不能和内置技能同名（防止覆盖系统技能）
6. **清理临时文件**：安装完成/失败后删除临时目录

---

## 与 Workflow Template 的关系

两个功能互补，可以分开发布：

- **install_skill**：扩展 AI 的能力范围（新技能）
- **Workflow Template**：编排已有技能的执行流程（流水线）

建议先做 `install_skill`（1.5天），再做 Workflow Template（7天），因为模板可能会引用用户安装的技能。
