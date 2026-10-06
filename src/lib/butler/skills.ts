/**
 * lib/butler/skills.ts —— 技能账本存储写原语（server-only，Phase 3 §3.4）
 *
 * 落点：`<APP_ROOT>/butler/.skills/<id>.md`（刻意与 Rules 同构，降低认知与实现成本）。
 *   - 点前缀 = 非角色内容（与 `.rules/` 同惯例），与「角色目录」天然分离。
 *   - **一条技能 = 一个文件**：技能本体低频、可编辑、需用户审固；与高频只追加的从属日志是两种形态。
 *   - 存储是**全局**的——Skills 不吃 `scope`（作用域由适用条件 `when` 与调用侧锚点决定）。
 *
 * 并发控制照抄 rules.ts：单写原语内部串行（`_skillsLock`）+ `version` 乐观锁，**不引入额外锁协议**。
 *
 * 依赖刻意收敛：只依赖 ./storage（其自身零内部依赖）、./skills-shared 与 gray-matter，
 * 不 import chat / core，避免环（eslint import/no-cycle）。
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import matter from 'gray-matter';
import { butlerRoot, ensureDir, dateStamp } from './storage';
import { atomicWriteFile, createLock } from './fs-atomic';
import {
  normalizeGrants,
  type CreateSkillInput,
  type SkillGrants,
  type SkillLifecycle,
  type SkillRecord,
  type SkillRevision,
  type SkillStep,
  type SkillWhen,
} from './skills-shared';
import type { ObjectType } from './rules-shared';

export type {
  SkillRecord,
  SkillStep,
  SkillWhen,
  SkillGrants,
  SkillRevision,
  SkillOrigin,
  SkillLifecycle,
  SkillRuntime,
  CreateSkillInput,
} from './skills-shared';
export type { ObjectType } from './rules-shared';

/** 技能集目录名（点前缀 = 非角色内容） */
const SKILLS_DIR_NAME = '.skills';

/** 技能 id 白名单：`sk-<8位日期>-<hex>`；用于防目录穿越并校验存量格式 */
const SKILL_ID_RE = /^sk-\d{8}-[0-9a-f]{4,}$/;

/** 技能集根目录：<APP_ROOT>/butler/.skills */
export function skillsRoot(): string {
  return join(butlerRoot(), SKILLS_DIR_NAME);
}

/** 技能本体文件路径：<skillsRoot>/<id>.md */
export function skillFilePath(id: string): string {
  return join(skillsRoot(), `${id}.md`);
}

/** 生成技能 id：`sk-<YYYYMMDD>-<4hex>`（前缀示「哪天定的」，随机尾保证永不变） */
export function generateSkillId(d: Date = new Date()): string {
  return `sk-${dateStamp(d).replace(/-/g, '')}-${randomBytes(2).toString('hex')}`;
}

/** 本地时间戳 YYYY-MM-DD HH:mm（与 rules.ts 的 created_at 口径一致） */
function nowStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ==================== 序列化 / 反序列化 ====================

/** frontmatter 每个复杂值统一 JSON 编码（JSON 是 YAML 子集，gray-matter 可原样解析回来） */
export function serializeSkill(skill: SkillRecord): string {
  const fm: Record<string, unknown> = {
    id: skill.id,
    name: skill.name,
    runtime: skill.runtime,
    origin: skill.origin,
    lifecycle: skill.lifecycle,
    version: skill.version,
    created_at: skill.createdAt,
    updated_at: skill.updatedAt,
    when_keywords: skill.when.keywords,
    steps: skill.steps,
    grants: skill.grants,
    revisions: skill.revisions,
  };
  if (skill.when.scenes && skill.when.scenes.length > 0) fm.when_scenes = skill.when.scenes;
  if (skill.when.objectTypes && skill.when.objectTypes.length > 0) fm.when_object_types = skill.when.objectTypes;
  if (skill.when.preconditions && skill.when.preconditions.length > 0) fm.when_preconditions = skill.when.preconditions;
  if (skill.effects && skill.effects.length > 0) fm.effects = skill.effects;

  const head = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');

  return `---\n${head}\n---\n\n## Description\n\n${skill.description}\n`;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

const OBJECT_TYPES: ObjectType[] = ['todo', 'schedule', 'note', 'meeting', 'project'];

function toObjectTypes(v: unknown): ObjectType[] {
  if (!Array.isArray(v)) return [];
  const out: ObjectType[] = [];
  for (const x of v) {
    if (typeof x === 'string' && (OBJECT_TYPES as string[]).includes(x) && !out.includes(x as ObjectType)) {
      out.push(x as ObjectType);
    }
  }
  return out;
}

/** 解析 steps：只接受 `{ primitive: string, params?: Record<string,string>, text?: string }` */
function parseSteps(v: unknown): SkillStep[] {
  if (!Array.isArray(v)) return [];
  const steps: SkillStep[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as { primitive?: unknown; params?: unknown; text?: unknown };
    if (typeof o.primitive !== 'string' || !o.primitive.trim()) continue;
    const step: SkillStep = { primitive: o.primitive.trim() };
    if (o.params && typeof o.params === 'object' && !Array.isArray(o.params)) {
      const params: Record<string, string> = {};
      for (const [k, val] of Object.entries(o.params as Record<string, unknown>)) {
        if (typeof val === 'string') params[k] = val;
      }
      if (Object.keys(params).length > 0) step.params = params;
    }
    if (typeof o.text === 'string' && o.text.trim()) step.text = o.text.trim();
    steps.push(step);
  }
  return steps;
}

/** 解析 revisions：只接受合法 kind（param / flow） */
function parseRevisions(v: unknown): SkillRevision[] {
  if (!Array.isArray(v)) return [];
  const out: SkillRevision[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as { at?: unknown; kind?: unknown; note?: unknown; fromVersion?: unknown };
    const kind = o.kind === 'flow' ? 'flow' : o.kind === 'param' ? 'param' : null;
    if (!kind) continue;
    out.push({
      at: asString(o.at),
      kind,
      note: asString(o.note),
      fromVersion: asNumber(o.fromVersion, 1),
    });
  }
  return out;
}

/** 提取 `## Description` 段落（到下一个 `## ` 为止） */
function parseDescription(body: string): string {
  const m = /^##\s+Description\s*\n+([\s\S]*?)(?=\n##\s|\s*$)/m.exec(body);
  return m ? m[1].trim() : '';
}

/** 解析一条技能文件（坏文件 / 缺关键字段 → null，不让脏数据阻断列表） */
export function parseSkill(raw: string): SkillRecord | null {
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(raw);
    data = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
  } catch {
    return null;
  }

  const id = asString(data.id);
  const name = asString(data.name);
  if (!id || !name) return null;

  const when: SkillWhen = { keywords: toStringArray(data.when_keywords) };
  const scenes = toStringArray(data.when_scenes);
  if (scenes.length > 0) when.scenes = scenes;
  const objectTypes = toObjectTypes(data.when_object_types);
  if (objectTypes.length > 0) when.objectTypes = objectTypes;
  const preconditions = toStringArray(data.when_preconditions);
  if (preconditions.length > 0) when.preconditions = preconditions;

  const runtimeRaw = asString(data.runtime);
  const lifecycleRaw = asString(data.lifecycle);
  const originRaw = asString(data.origin);
  const effects = toStringArray(data.effects);

  return {
    id,
    name,
    description: parseDescription(body),
    when,
    runtime: runtimeRaw === 'script' ? 'script' : 'compose',
    steps: parseSteps(data.steps),
    grants: normalizeGrants(data.grants as SkillGrants | undefined),
    ...(effects.length > 0 ? { effects } : {}),
    origin: originRaw === 'user' ? 'user' : 'ai',
    lifecycle: (['active', 'quarantine', 'retired'] as string[]).includes(lifecycleRaw)
      ? (lifecycleRaw as SkillLifecycle)
      : 'active',
    version: asNumber(data.version, 1),
    createdAt: asString(data.created_at),
    updatedAt: asString(data.updated_at),
    revisions: parseRevisions(data.revisions),
  };
}

// ==================== 读写原语 ====================

/** skills 读-改-写串行化（多请求并发改同一技能时避免互相覆盖）。
 *  锁与原子写原语统一取自 `./fs-atomic`（2026-10-02 评审：此前 5 份副本各自演化）。 */
const withLock = createLock();

/** 原子写一个技能文件（先写 tmp 再 rename，避免并发读-改-写写出半截文件） */
async function writeSkillFile(skill: SkillRecord): Promise<void> {
  await ensureDir(skillsRoot());
  await atomicWriteFile(skillFilePath(skill.id), serializeSkill(skill));
}

/** 读一条技能；不存在 / id 非法 / 解析失败 → null */
export async function readSkill(id: string): Promise<SkillRecord | null> {
  if (!SKILL_ID_RE.test(id)) return null;
  try {
    const raw = await fs.readFile(skillFilePath(id), 'utf-8');
    return parseSkill(raw);
  } catch {
    return null;
  }
}

/** 列出全部技能（目录不存在 → []；按 created_at 倒序，同刻按 id 升序保证稳定） */
export async function listSkills(): Promise<SkillRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(skillsRoot());
  } catch {
    return [];
  }
  const skills: SkillRecord[] = [];
  for (const n of names) {
    const id = n.endsWith('.md') ? n.slice(0, -3) : '';
    if (!id || !SKILL_ID_RE.test(id)) continue;
    const s = await readSkill(id);
    if (s) skills.push(s);
  }
  skills.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : b.createdAt.localeCompare(a.createdAt)));
  return skills;
}

/** 校验并原子写一条技能（id 必须合法，供固化链路与治理面复用） */
export async function writeSkill(skill: SkillRecord): Promise<void> {
  if (!SKILL_ID_RE.test(skill.id)) throw new Error(`invalid skill id: ${skill.id}`);
  await withLock(() => writeSkillFile(skill));
}

/** 归一化入参步骤：只保留合法的 primitive（+ 可选 text / params），去掉空项与非法项 */
function normalizeSteps(steps?: SkillStep[]): SkillStep[] {
  if (!Array.isArray(steps)) return [];
  const out: SkillStep[] = [];
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    const primitive = typeof s.primitive === 'string' ? s.primitive.trim() : '';
    if (!primitive) continue;
    const step: SkillStep = { primitive };
    if (typeof s.text === 'string' && s.text.trim()) step.text = s.text.trim();
    if (s.params && typeof s.params === 'object') {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.params)) if (typeof v === 'string') params[k] = v;
      if (Object.keys(params).length > 0) step.params = params;
    }
    out.push(step);
  }
  return out;
}

/** 归一化适用条件（修订写口用）：未传的字段沿用原值；objectTypes 走白名单。 */
function normalizeWhen(input: Partial<SkillWhen> | undefined, base: SkillWhen): SkillWhen {
  if (!input) return base;
  const when: SkillWhen = {
    keywords:
      input.keywords !== undefined
        ? (Array.isArray(input.keywords) ? input.keywords : []).map((k) => String(k).trim()).filter(Boolean)
        : base.keywords,
  };
  const scenes = input.scenes !== undefined ? toStringArray(input.scenes) : (base.scenes ?? []);
  if (scenes.length > 0) when.scenes = scenes;
  const objectTypes = input.objectTypes !== undefined ? toObjectTypes(input.objectTypes) : (base.objectTypes ?? []);
  if (objectTypes.length > 0) when.objectTypes = objectTypes;
  const preconditions = input.preconditions !== undefined ? toStringArray(input.preconditions) : (base.preconditions ?? []);
  if (preconditions.length > 0) when.preconditions = preconditions;
  return when;
}

/**
 * 新建一条技能（id / version / 时间戳 / lifecycle 自动生成）。
 * 固化口径：`status` 不适用——技能用 `lifecycle`；新建一律 `active`（可匹配）。
 */
export async function createSkill(input: CreateSkillInput): Promise<SkillRecord> {
  const name = (input.name || '').trim();
  const description = (input.description || '').trim();
  if (!name) throw new Error('skill name is required');
  if (!description) throw new Error('skill description is required');

  const stamp = nowStamp();
  const effects = Array.isArray(input.effects)
    ? input.effects.filter((e): e is string => typeof e === 'string' && e.trim().length > 0).map((e) => e.trim())
    : [];
  const skill: SkillRecord = {
    id: generateSkillId(),
    name,
    description,
    when: {
      keywords: (input.when?.keywords ?? []).map((k) => String(k).trim()).filter(Boolean),
      ...(input.when?.scenes && input.when.scenes.length > 0 ? { scenes: input.when.scenes } : {}),
      ...(input.when?.objectTypes && input.when.objectTypes.length > 0 ? { objectTypes: input.when.objectTypes } : {}),
      ...(input.when?.preconditions && input.when.preconditions.length > 0 ? { preconditions: input.when.preconditions } : {}),
    },
    runtime: input.runtime === 'script' ? 'script' : 'compose',
    steps: normalizeSteps(input.steps),
    grants: normalizeGrants(input.grants),
    ...(effects.length > 0 ? { effects } : {}),
    origin: input.origin === 'user' ? 'user' : 'ai',
    lifecycle: 'active',
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
    revisions: [],
  };

  await withLock(() => writeSkillFile(skill));
  return skill;
}

/** 可修订字段（内容写口；id / created_at / origin / lifecycle 不在其中）。 */
export interface ReviseSkillPatch {
  name?: string;
  description?: string;
  when?: Partial<SkillWhen>;
  steps?: SkillStep[];
  grants?: SkillGrants;
  effects?: string[];
}

/**
 * 内容修订写口（与规则的修订语义对齐）：
 *   - 改内容 → `version++`（乐观锁与 `rules.updateRule` 同口径，与 lifecycle 切换不同）；
 *   - 追加一条 `revision`（`kind='param'` 改参数 / `'flow'` 改流程），新的在前；
 *   - `lifecycle` 不在此改（走 `setSkillLifecycle`）。
 * 写口不放宽执行边界：`runtime='compose'` 的步骤仍受 skill-sandbox 静态拦截。
 */
export async function reviseSkill(
  id: string,
  patch: ReviseSkillPatch,
  kind: 'param' | 'flow',
  note: string,
  expectedVersion?: number,
): Promise<{ ok: true; skill: SkillRecord } | { ok: false; conflict?: true; error: string }> {
  if (!SKILL_ID_RE.test(id)) return { ok: false, error: `invalid skill id: ${id}` };
  return withLock(async () => {
    const current = await readSkill(id);
    if (!current) return { ok: false, error: `skill not found: ${id}` };
    if (typeof expectedVersion === 'number' && expectedVersion !== current.version) {
      return { ok: false, conflict: true, error: `version conflict: expected ${expectedVersion}, on disk ${current.version}` };
    }

    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    if (!name) return { ok: false, error: 'skill name cannot be empty' };
    const description = patch.description !== undefined ? patch.description.trim() : current.description;
    if (!description) return { ok: false, error: 'skill description cannot be empty' };

    const steps = patch.steps !== undefined ? normalizeSteps(patch.steps) : current.steps;
    const effects = patch.effects !== undefined
      ? patch.effects.filter((e): e is string => typeof e === 'string' && e.trim().length > 0).map((e) => e.trim())
      : (current.effects ?? []);

    const stamp = nowStamp();
    const next: SkillRecord = {
      ...current,
      name,
      description,
      when: normalizeWhen(patch.when, current.when),
      steps,
      grants: patch.grants !== undefined ? normalizeGrants(patch.grants) : current.grants,
      ...(effects.length > 0 ? { effects } : {}),
      version: current.version + 1,
      updatedAt: stamp,
      revisions: [{ at: stamp, kind, note: (note || '').trim(), fromVersion: current.version }, ...current.revisions],
    };
    if (effects.length === 0) delete next.effects;

    await writeSkillFile(next);
    return { ok: true, skill: next };
  });
}

/**
 * 设置技能生命周期（治理面写口：停用 `retired` / 解封 `active`）。
 * `expectedVersion` 为乐观锁（与 `rules.updateRule` 同口径）：与盘上 version 不符 → `{ok:false, conflict:true}`。
 * 生命周期切换**不 bump** `version`（version 只在「改流程」修正时 +1，见 §3.8），故只更新 `updatedAt`。
 */
export async function setSkillLifecycle(
  id: string,
  lifecycle: SkillLifecycle,
  expectedVersion?: number,
): Promise<{ ok: true; skill: SkillRecord } | { ok: false; conflict?: true; error: string }> {
  if (!SKILL_ID_RE.test(id)) return { ok: false, error: `invalid skill id: ${id}` };
  return withLock(async () => {
    const current = await readSkill(id);
    if (!current) return { ok: false, error: `skill not found: ${id}` };
    if (typeof expectedVersion === 'number' && expectedVersion !== current.version) {
      return { ok: false, conflict: true, error: `version conflict: expected ${expectedVersion}, on disk ${current.version}` };
    }
    const next: SkillRecord = { ...current, lifecycle, updatedAt: nowStamp() };
    await writeSkillFile(next);
    return { ok: true, skill: next };
  });
}

/** 删除一条技能（仅删本体） */
export async function deleteSkill(id: string): Promise<boolean> {
  if (!SKILL_ID_RE.test(id)) return false;
  try {
    await fs.unlink(skillFilePath(id));
    return true;
  } catch {
    return false;
  }
}