/**
 * 「解析类任务的缓存根」——即 parse 层 `getCache` / `setCache` 的第二个入参（`projectPath`）。
 *
 * 为什么单独一个文件：缓存的落点是 `<projectPath>/.cache/parse/`（`parse/cache.ts:82-84`），
 * 而**调用点分散在两条互不相干的链路**里：
 *   - 有当前项目时用项目根（画布音频编辑器、聊天工具）；
 *   - 语音输入（`/api/transcribe`）可能压根没有激活项目 ⇒ 回落到**应用根**下的 sandbox。
 *
 * 两份实现各写一遍的后果很隐蔽：同一份音频的转写会落到两个不同的缓存目录 ⇒
 * 缓存命中率凭空腰斩，而症状只是"有时候快、有时候慢"，看不出根因。
 *
 * ⚠️ 这只是**缓存目录**，不参与任何路径安全判断 —— 越界校验由各路由自己的
 * `resolveAudio` / `resolvePath` 负责（音频侧见 `api/audio/clip/route.ts` 的 `resolveAudio`）。
 */
import { join } from 'node:path';
import { getCurrentProject } from '@/lib/project/project-manager';
import { resolveAppRoot, SANDBOX_DIRNAME } from '@/lib/app-root';

/**
 * 当前项目根；没有激活项目时回落 `<APP_ROOT>/.sandbox`。
 *
 * 🔴 **兜底必须走 `resolveAppRoot()`，不能写死 `~/BobWork`**（这里曾是后者的实现）。
 * 写死 home 的后果实测（2026-10-11，长音频窗口化端到端探针）：
 * 用 `BOBWORK_HOME=/tmp/…` 起隔离 dev 时 `getCurrentProject()` 抛错 ⇒ 兜底落到**用户的真实数据根**
 * `~/BobWork/.sandbox/.cache/parse/…` ⇒ 隔离环境把缓存写进了真实根，
 * 且被文件沙盒拒绝（`EPERM: operation not permitted, open '/Users/…/BobWork/.sandbox/…'`）。
 * 症状极具误导性：**转写把 20 个分片都跑完了**（STT 调用数可证），最后一步存缓存时 EPERM，
 * 用户看到的是"转写失败"，而根因是缓存路径不属于当前环境。
 *
 * `resolveAppRoot()` 认 `BOBWORK_HOME`（`lib/app-root.ts:11-14`）⇒ 隔离环境只碰自己的目录。
 */
export async function parseProjectRoot(): Promise<string> {
  try {
    return (await getCurrentProject()).path;
  } catch {
    return join(resolveAppRoot(), SANDBOX_DIRNAME);
  }
}
