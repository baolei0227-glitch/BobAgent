/**
 * Next.js instrumentation — server 启动时执行
 *
 * 用于启动微信 iLink 桥接：若存在已保存的凭证，自动恢复长轮询会话。
 * dev / prod / standalone 均生效（Next.js 15 默认支持）。
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    // 从 .settings.json 恢复技能启用状态（重启不丢失）
    const { loadAgentSkillsFromSettings } = await import('@/lib/skills/registry-server');
    setTimeout(() => {
      loadAgentSkillsFromSettings().catch((e) => {
        console.error('[skills-registry] 启动恢复失败:', e);
      });
    }, 500);
  } catch (e) {
    console.error('[skills-registry] 加载失败:', e);
  }
  try {
    // 启动清理 /chat 过期会话：进程存活时的 60s 周期 sweep，在"未退出直接关应用"的场景下
    // 不会执行，需在启动时兜底清理过期会话（wechat 15min TTL，只删过期行）。
    const { startChatSessionSweeper } = await import('@/lib/wanted/chat-session');
    // 周期清理：进程存活期间，每 60s 删除过期会话（wechat 15min TTL）
    startChatSessionSweeper();
  } catch (e) {
    console.error('[chat-session] 启动清理加载失败:', e);
  }
  try {
    // 每日自动报告调度：每天 9:00 或当天首次打开软件时发送 Morning 报告
    const { startDailyReportScheduler } = await import('@/lib/wanted/daily-report');
    setTimeout(() => {
      startDailyReportScheduler().catch((e) => {
        console.error('[daily-report] 调度启动失败:', e);
      });
    }, 4000);
  } catch (e) {
    console.error('[daily-report] 调度加载失败:', e);
  }
  try {
    // 日历到期提醒调度：事件到点即提醒 + 应用打开时补发遗漏到期提醒
    const { startEventReminderScheduler } = await import('@/lib/wanted/event-reminder');
    setTimeout(() => {
      startEventReminderScheduler().catch((e) => {
        console.error('[event-reminder] 调度启动失败:', e);
      });
    }, 4000);
  } catch (e) {
    console.error('[event-reminder] 调度加载失败:', e);
  }
  try {
    // OCR 归档缓存清理调度：归档超 30 天的项目定时删除其 .cache/parse/ 释放磁盘
    const { startCacheCleanupScheduler } = await import('@/lib/parse/cache');
    setTimeout(() => {
      startCacheCleanupScheduler();
    }, 6000);
  } catch (e) {
    console.error('[parse-cache] 归档缓存清理调度启动失败:', e);
  }
  try {
    // 便签 note 页全量清扫：把从未打开过画布便签的项目中残留的 note 页（kind='note'）
    // 一次性迁入全局笔记库 notebook.json（幂等），配合 deleteProject 删除前兜底，
    // 实现"笔记独立于项目"——删除项目不丢笔记。
    const { sweepAllStickyNotePages } = await import('@/lib/sticky-notes-migrate');
    setTimeout(() => {
      sweepAllStickyNotePages().catch((e) => {
        console.error('[sticky-notes] 启动全量清扫失败:', e);
      });
    }, 6000);
  } catch (e) {
    console.error('[sticky-notes] 全量清扫加载失败:', e);
  }
  try {
    // 预热 /api/chat 路由编译：dev 模式下 Next.js 按需编译，/api/chat 依赖超重
    // （tools.ts 5300+ 行 + openai/MCP/sqlite3 等），首次请求会因编译超时返回纯文本 500，
    // 导致微信端 /chat 首次提问报"节点请求失败"。启动时主动触发编译，编译完成后再启动微信桥。
    const port = process.env.PORT || '5000';
    const warmupUrl = `http://localhost:${port}/api/chat`;
    setTimeout(() => {
      fetch(warmupUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      })
        .then(() => console.log('[warmup] /api/chat 路由编译完成'))
        .catch((e) => console.error('[warmup] /api/chat 预热失败:', e));

    }, 2000);
    // 延迟启动微信桥：等待预热编译完成（预热在 2s 发起，桥在 5s 启动，留 3s 编译窗口）
    const { wechatBridge } = await import('@/lib/bridge/wechat-bridge');
    setTimeout(() => {
      wechatBridge.start().catch((e) => {
        console.error('[wechat-bridge] 启动失败:', e);
      });
    }, 5000);
  } catch (e) {
    console.error('[wechat-bridge] 加载失败:', e);
  }
  try {
    // 项目工作区目录监听：用户手动往 BobWorkspace 拖入/删除文件夹时，
    // 实时对账 .projects.json 并通过 SSE 通知侧边栏刷新（项目列表实时跟随磁盘变化）
    const { startProjectsDiskWatcher } = await import('@/lib/project/project-watcher');
    setTimeout(() => {
      startProjectsDiskWatcher().catch((e) => {
        console.error('[project-watcher] 启动失败:', e);
      });
    }, 1500);
  } catch (e) {
    console.error('[project-watcher] 加载失败:', e);
  }
  try {
    // 中间产物定期清扫：AI 写入 homework/.ai-workspace/ 的裁剪图/切片/临时脚本等，
    // 超过保留期自动清理，配合系统提示词「任务结束自清理」规则，彻底解决中间文件残留。
    const { startIntermediateCleanupSweeper } = await import('@/lib/cleanup/intermediate-cleanup');
    startIntermediateCleanupSweeper();
  } catch (e) {
    console.error('[intermediate-cleanup] 启动失败:', e);
  }
  try {
    // Python 包自动清理：AI 安装且超过 30 天未使用的包自动卸载（24h 门控，每次启动最多跑一次）
    const { runAutoCleanup } = await import('@/lib/python/pkg-usage');
    setTimeout(() => {
      runAutoCleanup().catch((e) => {
        console.error('[py-cleanup] 清理失败:', e);
      });
    }, 8000);
  } catch (e) {
    console.error('[py-cleanup] 加载失败:', e);
  }
}
