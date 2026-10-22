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
    // Butler 线程存储（Phase 4）：先领取旧 chat_sessions 的历史数据（幂等，只跑一次），
    // 再启动清理与过期兜底。进程存活期间的 60s 周期 sweep 在"未退出直接关应用"的场景下
    // 不会执行，需在启动时兜底清理过期线程（wechat 24h TTL，只删过期行）。
    const { migrateLegacyThreads } = await import('@/lib/butler/threads-migrate');
    await migrateLegacyThreads();
    const { startThreadSweeper, purgeRetiredWechatThread, purgeRetiredRecorderThread } = await import('@/lib/butler/threads');
    // 周期清理：进程存活期间，每 60s 删除过期线程（wechat 24h TTL）
    startThreadSweeper();
    // 一次性退役清理：删除旧「Bobby」微信桥常驻线程（2026-09-28 微信消息改并入通知助理线程）。
    // 幂等；失败只记日志，不影响启动。
    purgeRetiredWechatThread()
      .then((removed) => {
        if (removed) console.log('[butler/threads] 已清除退役的 Bobby 微信线程');
      })
      .catch((e) => {
        console.error('[butler/threads] 退役线程清理失败:', e);
      });
    // 一次性退役清理：删除旧「Recorder」会议记录员常驻线程（2026-10-09 该常驻联系人已移除）。
    // 幂等；失败只记日志，不影响启动。
    purgeRetiredRecorderThread()
      .then((removed) => {
        if (removed) console.log('[butler/threads] 已清除退役的 Recorder 线程');
      })
      .catch((e) => {
        console.error('[butler/threads] 退役线程清理失败:', e);
      });
  } catch (e) {
    console.error('[butler/threads] 启动清理加载失败:', e);
  }
  try {
    // 每日任务调度：每天 9:00 或当天首次打开软件时生成 Report 摘要 + Notes 知识库维护 + News 简报
    const { startDailyTaskScheduler } = await import('@/lib/core/daily-tasks');
    setTimeout(() => {
      startDailyTaskScheduler().catch((e) => {
        console.error('[daily-tasks] 调度启动失败:', e);
      });
    }, 4000);
  } catch (e) {
    console.error('[daily-tasks] 调度加载失败:', e);
  }
  try {
    // 历史日报回执清理：日报三页签已整体移交 Today 面板（Bobby 不再推送日报），
    // 存量收件箱里的 Progress / Morning / Sticky 回执一次性删除（幂等，无匹配行为 0）。
    const { purgeInboxDailyReports } = await import('@/lib/core/inbox');
    setTimeout(() => {
      purgeInboxDailyReports()
        .then((n) => {
          if (n > 0) console.log(`[inbox] 已清理历史日报回执 ${n} 条（日报已移交 Today 面板）`);
        })
        .catch((e) => {
          console.error('[inbox] 历史日报回执清理失败:', e);
        });
    }, 3000);
  } catch (e) {
    console.error('[inbox] 历史日报回执清理加载失败:', e);
  }
  try {
    // 日历到期提醒调度：事件到点即提醒 + 应用打开时补发遗漏到期提醒
    const { startEventReminderScheduler } = await import('@/lib/core/event-reminder');
    setTimeout(() => {
      startEventReminderScheduler().catch((e) => {
        console.error('[event-reminder] 调度启动失败:', e);
      });
    }, 4000);
  } catch (e) {
    console.error('[event-reminder] 调度加载失败:', e);
  }
  try {
    // 邮件感知（2026-10-10 感知面 ①）：读设置里的邮箱凭证 → 常驻 IMAP 增量拉未读 →
    // 过滤营销/退信/自动回复后写 Butler 收件箱，并经 push-out 播报到微信/飞书。
    // 未配置凭证时每轮静默 idle（不建连、不报错），用户在设置里填好即自动开始工作。
    // 自带调度器而没挂进 [1]~[4] 的链路 —— 它静态依赖 lib/core/* 与 lib/butler/storage，
    // 反向挂载会成 import 环（eslint import/no-cycle）。
    const { startMailScheduler } = await import('@/lib/bridge/mail-poll');
    setTimeout(() => {
      startMailScheduler();
    }, 4000);
  } catch (e) {
    console.error('[mail-poll] 调度加载失败:', e);
  }
  try {
    // 晚间回顾调度（20:00 起）：Butler 目前唯一会推外部通道（微信/飞书）的助理主动汇报。
    // 自带调度器而没挂进 daily-tasks —— 后者被 today-advice 静态依赖，反向引用会成 import 环。
    // 打扰裁决不在调度器里，统一交给 lib/core/push-out.ts（免打扰窗口 / 单日上限）。
    const { startEveningReportScheduler } = await import('@/lib/butler/evening-report');
    setTimeout(() => {
      startEveningReportScheduler();
    }, 4000);
  } catch (e) {
    console.error('[evening-report] 调度加载失败:', e);
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
    // 一次性清理旧画布便签（Bob-Mind 拆分遗留，node_type='note'/'sticky'）：备份进 .trash 后删除。
    // 幂等；宿主已不再渲染/管理这类节点，此清扫只清理历史数据。
    const { purgeLegacyCanvasThoughts } = await import('@/lib/legacy-canvas-thoughts-purge');
    setTimeout(() => {
      purgeLegacyCanvasThoughts().catch((e) => {
        console.error('[purge] 旧画布便签清扫失败:', e);
      });
    }, 6000);
  } catch (e) {
    console.error('[purge] 旧画布便签清扫加载失败:', e);
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
    // 延迟启动飞书桥：与微信桥同构，复用上面的 2s /api/chat 预热窗口。
    // 无凭证时 start() 内部直接 idle 返回，不建连、不报错。
    const { feishuBridge } = await import('@/lib/bridge/feishu-bridge');
    setTimeout(() => {
      feishuBridge.start().catch((e) => {
        console.error('[feishu-bridge] 启动失败:', e);
      });
    }, 5000);
  } catch (e) {
    console.error('[feishu-bridge] 加载失败:', e);
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
  try {
    // 文件自动整理：设置里开启 File Organizer 并配好投递箱目录后，常驻监听该目录，
    // 放入文件即自动改名并移入分类子目录（开关/目录变更由 watcher 周期对账感知）。
    const { startFileOrganizerWatcher } = await import('@/lib/file-organizer/watcher');
    setTimeout(() => {
      startFileOrganizerWatcher().catch((e) => {
        console.error('[file-organizer] 启动失败:', e);
      });
    }, 3500);
  } catch (e) {
    console.error('[file-organizer] 加载失败:', e);
  }
}
