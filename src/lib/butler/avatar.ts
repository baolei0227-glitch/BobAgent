/**
 * Butler 联系人头像 —— 人物卡通头像 + 配色，**按人设性格挑选，按名字兜底**。
 *
 * 两条派生规则：
 *   ① 人设里写了性格 → 关键词命中一张人物头像（傲娇=侧分短发、元气=双马尾、天然呆=齐刘海、
 *      三无=长直发、温柔=波波头、病娇=长卷发遮眼、严谨=戴眼镜、幽默=刺猬头眨眼……），
 *      头像因此和「用户描述的性格」对得上；
 *   ② 没写性格，或一句话里没命中任何关键词 → 退回按名字散列的头像，同名恒定。
 * 「长什么样」是纯数据（id），画在 components/butler/PersonaAvatar.tsx；
 * 底色仍按**名字**散列（avatarTint），所以同性格的两个人靠底色区分。
 * 全程**纯派生**：不落库、不联网、不调模型，所以联系人列与中栏工具行两处各渲染一次也永远一致。
 *
 * 例外是**系统身份**（Bobby / Recorder / 小微，见 lib/butler/storage.ts 的三个常驻线程）：
 * 形象与底色一律由 SYSTEM_IDENTITIES 按显示名钉死，不参与性格推导
 * （Bobby 与小微都允许用户设人设，但头像仍是钉死的系统形象，不随性格变）。
 *
 * 为什么不做成「用户挑」：好友（人设助理）是随手新建的，逐个挑头像纯属打扰；
 * 由性格文字推导，也符合本项目「配置类界面一律极简」的约定。
 *
 * 形象一律中性（不按性格定性别 / 长相），且刻意画得很平：缩到 20px 时五官会糊掉，
 * 能认出来的只有「发型轮廓 + 主色」。
 */

/** 性格原型调色板（10 张）：名字散列兜底只在这 10 张里挑，普通好友拿不到系统身份的专用形象 */
export const PERSONA_AVATAR_IDS = [
  'tsundere', 'genki', 'airhead', 'kuudere', 'gentle',
  'yandere', 'rigorous', 'humorous', 'cute', 'brave',
] as const;

/**
 * 系统身份专用形象（第 11–12 张，不入名字散列兜底池）——**只给系统身份**，普通好友永远拿不到：
 *   - `wechat`：常驻搜索助手「小微」（2026-09-30 与 Bobby 互换而来）
 *   - `bell`：常驻通知助理「Bobby」（2026-10-01 新增，铃铛/回执母题）
 * 两张都各钉一个身份，不共用。
 */
export const SYSTEM_AVATAR_IDS = ['wechat', 'bell'] as const;

/** 全部可渲染的形象 id（PersonaAvatar 的 ART 表按它建索引） */
export const AVATAR_IDS = [...PERSONA_AVATAR_IDS, ...SYSTEM_AVATAR_IDS] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];

/**
 * 系统身份钉死的形象 + 底色色相。键 = **显示名**
 * （lib/butler/storage.ts 的 NOTIFY_TITLE / RECORDER_TITLE / SEARCH_TITLE，改名要同步这里）。
 * 底色也一并钉死：否则名字散列会把「小微 = 微信绿」冲成随机色相，绿色卫衣就失去呼应。
 */
const SYSTEM_IDENTITIES: Record<string, { id: AvatarId; hue: number }> = {
  /**
   * Bobby（通知助理）：专用件 `bell`（深色短发呆毛 + 蓝制服 + 胸前铃铛）+ 蓝底 210°（冷静/事务感）。
   * 沿革：2026-09-30 与小微互换后曾短暂借用性格原型 `rigorous`，但那样会与「严谨」人设的
   * 普通好友同形，2026-10-01 补了这张专用件；底色一直保持 210° 未变。
   */
  'Bobby': { id: 'bell', hue: 210 },
  /**
   * Recorder（会议记录员）：借用「三无」形象（长直发 + 半阖眼，一副埋头记笔录的样子），
   * 琥珀橙底（录制指示灯的感觉）与另外两个系统身份拉开距离。
   * 没有专用美术件——系统身份只需「一眼分得开」，不值得再画一张。
   */
  Recorder: { id: 'kuudere', hue: 32 },
  /**
   * 小微（搜索与资料整理助手）：专用形象 `wechat`（黑发双丸子头 + 微信绿卫衣 + 胸前对话气泡）
   * + 微信绿（#07C160 ≈ 149°）底 —— 底色必须跟着形象走，否则绿色卫衣失去呼应。
   * 2026-09-30 与 Bobby **互换**：此前小微借「严谨」形象 + 蓝底。
   */
  小微: { id: 'wechat', hue: 149 },
};

/**
 * 性格关键词 → 头像。**数组顺序即优先级**：命中数相同时取靠前的规则
 * （所以「天然呆…真诚可爱」取 airhead 而不是 cute，「傲娇但心软」取 tsundere 而不是兜底）。
 * 关键词表覆盖 PersonaDialog 的六个预设性格文案，自定义文案按同样的词面命中。
 */
const AVATAR_RULES: ReadonlyArray<{ id: AvatarId; keywords: readonly string[] }> = [
  { id: 'tsundere', keywords: ['傲娇', '嘴硬', '刀子嘴', '毒舌', '口是心非', '别扭'] },
  { id: 'genki', keywords: ['元气', '热情', '活力', '开朗', '活泼', '积极', '阳光'] },
  { id: 'airhead', keywords: ['天然呆', '呆萌', '迷糊', '迟钝', '天真', '单纯'] },
  { id: 'kuudere', keywords: ['三无', '高冷', '冷淡', '无口', '话少', '面瘫', '冷静'] },
  { id: 'gentle', keywords: ['温柔', '治愈', '耐心', '体贴', '安抚', '鼓励', '包容'] },
  { id: 'yandere', keywords: ['病娇', '独占', '依恋', '黏人', '缠人'] },
  { id: 'rigorous', keywords: ['严谨', '专业', '可靠', '沉稳', '博学', '认真', '细致'] },
  { id: 'humorous', keywords: ['幽默', '搞笑', '风趣', '调皮', '有趣'] },
  { id: 'cute', keywords: ['可爱', '萌', '甜', '撒娇'] },
  { id: 'brave', keywords: ['勇敢', '大胆', '强势', '霸气', '果断'] },
];

/** FNV-1a：短字符串上的分布够均匀，且实现只有几行 */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 名字 + 性格 → 头像 id。
 * 系统身份（Bobby / Recorder）直接返回钉死的形象；
 * 其余先按 personality 里的关键词投票（命中最多者胜，同票取 AVATAR_RULES 靠前者），
 * 一句话都没命中（或根本没写性格）才退回名字散列——空名字退化为调色板首项。
 */
export function defaultAvatarId(name: string, personality?: string): AvatarId {
  const key = name.trim();
  const pinned = SYSTEM_IDENTITIES[key];
  if (pinned) return pinned.id;

  const text = (personality ?? '').trim();
  if (text) {
    let best: { id: AvatarId; hits: number } | null = null;
    for (const rule of AVATAR_RULES) {
      const hits = rule.keywords.reduce((n, k) => (text.includes(k) ? n + 1 : n), 0);
      if (hits > 0 && (!best || hits > best.hits)) best = { id: rule.id, hits };
    }
    if (best) return best.id;
  }
  if (!key) return PERSONA_AVATAR_IDS[0];
  return PERSONA_AVATAR_IDS[hash(key) % PERSONA_AVATAR_IDS.length];
}

/**
 * 名字 → 底色色相（0-359）：系统身份取钉死值，其余按名字散列。
 * 散列加盐与头像 id 的散列分开，否则「头像序号」和「色相」会绑定，头像会成对撞色。
 */
export function avatarHue(name: string): number {
  const key = name.trim();
  const pinned = SYSTEM_IDENTITIES[key];
  if (pinned) return pinned.hue;
  return hash(`hue:${key || 'butler'}`) % 360;
}

/** 名字 → 头像底色（柔和底 + 同色细边，衬得出深色人物轮廓，明暗主题都自适） */
export function avatarTint(name: string): { backgroundColor: string; borderColor: string } {
  const hue = avatarHue(name);
  return {
    backgroundColor: `hsl(${hue} 58% 55% / 0.16)`,
    borderColor: `hsl(${hue} 58% 55% / 0.28)`,
  };
}