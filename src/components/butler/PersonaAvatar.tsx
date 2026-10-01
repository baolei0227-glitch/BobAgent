/**
 * PersonaAvatar —— Butler 联系人的人物卡通头像素材（扁平 SVG，12 张）。
 *
 * 与 lib/butler/avatar.ts 的分工：那边只决定「用哪张」（性格关键词 → id，名字兜底；
 * 系统身份另走钉死的映射），这边只负责「长什么样」。**底色不在这里画** ——
 * 由调用方用 avatarTint(name) 铺在容器上，所以同性格不同名的人底色不同，
 * 且能跟着 App 的明暗主题自适应。
 *
 * 每张都是 64×64 的透明底半身像，共用同一套头型（Base）与线宽，只换发型轮廓 / 配色 / 表情。
 * 刻意画得很平：缩到 20px（中栏工具行）时五官会糊掉，能认出来的只有发型轮廓和主色，
 * 所以区分度全压在发型与配色上，不靠五官细节。
 */
import type { ReactNode } from 'react';
import type { AvatarId } from '@/lib/butler/avatar';

/** 常规发盖：盖住头顶，发际线带一点波浪 */
const CAP =
  'M18.5 27.5 C18.5 15 25 9.5 32 9.5 C39.5 9.5 45.5 15 45.5 27.5 C43.5 21.5 40 18.8 36 19.8 C32.5 20.7 29 22.8 25 21.8 C21.8 21 19.6 23.3 18.5 27.5 Z';

/** 刺猬发盖：同一顶帽子，发际线改成锯齿 */
const CAP_SPIKY =
  'M18.5 27.5 C18.5 15 25 9.5 32 9.5 C39.5 9.5 45.5 15 45.5 27.5 L42.6 20.8 L38.8 24.2 L35.6 17.6 L31.6 23.2 L28.6 16.8 L24.6 23 L20.9 20.2 Z';

/** 共用头颈肩：所有头像同一套头型，只换肤色 / 暗部 / 衣色（衣领会被容器的圆角裁掉一点，是刻意的） */
function Base({ skin, shade, cloth }: { skin: string; shade: string; cloth: string }) {
  return (
    <>
      <path d="M10 64 C10 50.5 20 44 32 44 C44 44 54 50.5 54 64 Z" fill={cloth} />
      <rect x="28.4" y="34.5" width="7.2" height="10.5" rx="3.4" fill={shade} />
      <ellipse cx="32" cy="28" rx="13" ry="14" fill={skin} />
      <circle cx="19.4" cy="29.5" r="2.6" fill={skin} />
      <circle cx="44.6" cy="29.5" r="2.6" fill={skin} />
    </>
  );
}

/** 睁眼（圆点）：半径即「眼睛睁多大」，天然呆最大、严谨最小 */
function Eyes({ r = 1.7 }: { r?: number }) {
  return (
    <>
      <circle cx="26.6" cy="29.4" r={r} fill="#2B2B33" />
      <circle cx="37.4" cy="29.4" r={r} fill="#2B2B33" />
    </>
  );
}

function Blush({ opacity = 0.4 }: { opacity?: number }) {
  return (
    <>
      <circle cx="23.6" cy="33.2" r="2.6" fill="#EF8F8F" opacity={opacity} />
      <circle cx="40.4" cy="33.2" r="2.6" fill="#EF8F8F" opacity={opacity} />
    </>
  );
}

/** 两侧发片：短发到下颌（长=false）或长发过肩（长=true） */
function SidePanels({ color, long }: { color: string; long?: boolean }) {
  if (long) {
    return (
      <>
        <path d="M18.4 25.5 C16.3 34 16.4 42.5 17.6 48.6 C18.6 51 21.8 51 22.6 48.6 C21.2 41.5 20.8 32.5 21.6 25.5 Z" fill={color} />
        <path d="M45.6 25.5 C47.7 34 47.6 42.5 46.4 48.6 C45.4 51 42.2 51 41.4 48.6 C42.8 41.5 43.2 32.5 42.4 25.5 Z" fill={color} />
      </>
    );
  }
  return (
    <>
      <path d="M18.6 25.5 C17.2 31.5 17.5 37 18.7 40.2 C19.6 42.2 21.8 42.4 22.7 40.4 C21.3 36.2 20.9 31 21.7 25.5 Z" fill={color} />
      <path d="M45.4 25.5 C46.8 31.5 46.5 37 45.3 40.2 C44.4 42.2 42.2 42.4 41.3 40.4 C42.7 36.2 43.1 31 42.3 25.5 Z" fill={color} />
    </>
  );
}

/** 双马尾 + 发圈：两条尾巴挂在头两侧，比任何五官都更容易在小尺寸被认出来 */
function Twins({ color, tie }: { color: string; tie: string }) {
  return (
    <>
      <ellipse cx="15.4" cy="32.5" rx="4.4" ry="7" fill={color} />
      <ellipse cx="48.6" cy="32.5" rx="4.4" ry="7" fill={color} />
      <rect x="17.2" y="26.4" width="3.6" height="2.6" rx="1.3" fill={tie} />
      <rect x="43.2" y="26.4" width="3.6" height="2.6" rx="1.3" fill={tie} />
    </>
  );
}

/** id → 画面。id 由 lib/butler/avatar.ts 的规则表给出，两边是一一对应的 */
const ART: Record<AvatarId, ReactNode> = {
  /** 傲娇：侧分短发 + 挑起的眉 + 收敛的笑 */
  tsundere: (
    <>
      <Base skin="#F3D0B4" shade="#DFB795" cloth="#E07A5F" />
      <path d={CAP} fill="#B84A3C" />
      <path d="M24.6 25 L28.2 23.8" stroke="#A03F33" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <path d="M39.4 23.8 L35.8 25" stroke="#A03F33" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <Eyes />
      <path d="M29.2 35.6 Q32.4 37.9 34.9 34.6" stroke="#8A4A3C" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </>
  ),
  /** 元气：双马尾 + 大眼睛 + 张嘴笑 + 腮红 */
  genki: (
    <>
      <Base skin="#F7DCC2" shade="#EBC7A6" cloth="#F5A623" />
      <path d={CAP} fill="#E8B33C" />
      <Twins color="#E8B33C" tie="#E07A5F" />
      <Blush opacity={0.42} />
      <Eyes r={1.9} />
      <path d="M27.6 34.4 Q32 39.6 36.4 34.4 Z" fill="#9A4A46" />
    </>
  ),
  /** 天然呆：齐刘海波波头 + 睁大的圆眼 + 有点犯难的嘴 */
  airhead: (
    <>
      <Base skin="#F7DCC2" shade="#EBC7A6" cloth="#8EC9E8" />
      <path d={CAP} fill="#6B4B3A" />
      <SidePanels color="#6B4B3A" />
      <Blush opacity={0.4} />
      <Eyes r={2.1} />
      <path d="M29.4 35.4 Q32 33.5 34.6 35.4" stroke="#8A4A3C" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </>
  ),
  /** 三无：长直发 + 半阖的眼 + 一条平嘴 */
  kuudere: (
    <>
      <Base skin="#EAC7A8" shade="#D8B08F" cloth="#5B6B8C" />
      <path d={CAP} fill="#2E2E38" />
      <SidePanels color="#2E2E38" long />
      <path d="M24.4 29.4 Q26.6 28.1 28.8 29.4" stroke="#2B2B33" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M35.2 29.4 Q37.4 28.1 39.6 29.4" stroke="#2B2B33" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M29.4 35.8 L34.6 35.8" stroke="#8A4A3C" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </>
  ),
  /** 温柔治愈：波波头 + 浅腮红 + 弯眼笑 */
  gentle: (
    <>
      <Base skin="#F3D0B4" shade="#DFB795" cloth="#6FBF9B" />
      <path d={CAP} fill="#8B5E3C" />
      <SidePanels color="#8B5E3C" />
      <Blush opacity={0.32} />
      <Eyes />
      <path d="M28.8 34.9 Q32 37.7 35.2 34.9" stroke="#8A4A3C" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </>
  ),
  /** 病娇：长卷发 + 一缕遮住右眼 + 只露一只眼 */
  yandere: (
    <>
      <Base skin="#F7DCC2" shade="#EBC7A6" cloth="#A85C8E" />
      <path d={CAP} fill="#5B3A5B" />
      <SidePanels color="#5B3A5B" long />
      <path d="M33.4 19.8 C38.2 20.8 42.2 24.2 43.4 29.8 C40.8 25.8 37.2 23.6 33.2 23.2 Z" fill="#5B3A5B" />
      <circle cx="26.6" cy="29.4" r="1.7" fill="#2B2B33" />
      <path d="M29.6 35.3 Q32 36.9 34.4 35.3" stroke="#8A4A3C" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </>
  ),
  /** 严谨：利落短发 + 圆框眼镜 + 平嘴 */
  rigorous: (
    <>
      <Base skin="#E3B892" shade="#CFA47C" cloth="#3F5D8A" />
      <path d={CAP} fill="#3A3A44" />
      <Eyes r={1.5} />
      <g fill="none" stroke="#3A3A44" strokeWidth="1.4">
        <circle cx="26.6" cy="29.4" r="4.5" />
        <circle cx="37.4" cy="29.4" r="4.5" />
        <path d="M31.1 29.2 L32.9 29.2" />
        <path d="M22.1 28.6 L20 28.2" />
        <path d="M41.9 28.6 L44 28.2" />
      </g>
      <path d="M29.5 35.8 L34.5 35.8" stroke="#8A4A3C" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </>
  ),
  /** 幽默：刺猬头 + 单眼眨眼 + 咧开的笑 */
  humorous: (
    <>
      <Base skin="#EFC9A4" shade="#DBB089" cloth="#F08A3C" />
      <path d={CAP_SPIKY} fill="#C97B3C" />
      <circle cx="26.6" cy="29.4" r="1.7" fill="#2B2B33" />
      <path d="M35.2 29.8 Q37.4 27.6 39.6 29.8" stroke="#2B2B33" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M28.2 34.6 Q32 38.8 35.8 34.6 Z" fill="#9A4A46" />
    </>
  ),
  /** 可爱：双马尾 + 大眼睛 + 腮红 + 小小的笑 */
  cute: (
    <>
      <Base skin="#FADCC8" shade="#EDC6AC" cloth="#F2A0BE" />
      <path d={CAP} fill="#E58AA8" />
      <Twins color="#E58AA8" tie="#C97BB0" />
      <Blush opacity={0.4} />
      <Eyes r={1.9} />
      <path d="M29.9 35.1 Q32 37.2 34.1 35.1" stroke="#8A4A3C" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </>
  ),
  /** 勇敢：刺猬头 + 内压的眉 + 抿嘴 */
  brave: (
    <>
      <Base skin="#D9A479" shade="#C08F63" cloth="#4A8A5C" />
      <path d={CAP_SPIKY} fill="#7A4A28" />
      <path d="M24.8 25.9 L28.6 26.8" stroke="#5E3719" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <path d="M39.2 25.9 L35.4 26.8" stroke="#5E3719" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <Eyes r={1.8} />
      <path d="M28.9 35.3 Q32 37.4 35.1 35.3" stroke="#7A4230" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </>
  ),
  /**
   * Bobby：深色短发 + 一撮翘起的呆毛 + 蓝色制服 + 胸前一枚铃铛（通知 / 回执的母题）。
   * 2026-10-01 新增的**专用件**：此前系统身份只有 `wechat` 一张定制件（现归小微），
   * Bobby 借的是性格原型 `rigorous` —— 于是和「严谨」人设的普通好友同形，
   * 而系统身份的设计目标是「一眼分得开」，故补这一张。
   * 铃铛缩到 20px 只剩一个暖黄点，认人仍靠「短发呆毛 + 蓝制服」。
   */
  bell: (
    <>
      <Base skin="#F3D0B4" shade="#DFB795" cloth="#3E6FA8" />
      <path d={CAP} fill="#33323C" />
      <path d="M38.8 15.4 C40.4 11.2 43.6 9.4 46.2 10.2 C44.2 11.4 42.6 13.4 42.2 16.2 Z" fill="#33323C" />
      <SidePanels color="#33323C" />
      <circle cx="32" cy="46.2" r="1.7" fill="#D9A227" />
      <path d="M25 57 C25 50.2 27.6 46.8 32 46.8 C36.4 46.8 39 50.2 39 57 Z" fill="#F2C14E" />
      <rect x="23.4" y="56.6" width="17.2" height="2.4" rx="1.2" fill="#D9A227" />
      <circle cx="32" cy="60.9" r="1.7" fill="#D9A227" />
      <Eyes />
      <path d="M29.2 35.2 Q32 37.6 34.8 35.2" stroke="#8A4A3C" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </>
  ),
  /**
   * 小微：黑发双丸子头 + 微信绿卫衣 + 胸前对话气泡
   * （气泡缩到 20px 只剩一个白点，认人靠「绿 + 丸子头」）。
   * 2026-09-30 起由「小微」使用，此前归「Bobby」——画家与用家互换，画面本身未动。
   */
  wechat: (
    <>
      <Base skin="#F7DCC2" shade="#EBC7A6" cloth="#07C160" />
      <path d={CAP} fill="#2E2E38" />
      <circle cx="20.5" cy="15.5" r="5" fill="#2E2E38" />
      <circle cx="43.5" cy="15.5" r="5" fill="#2E2E38" />
      <SidePanels color="#2E2E38" />
      <rect x="23" y="49.5" width="18" height="10.5" rx="3.5" fill="#FFFFFF" />
      <path d="M27.5 59 L24.5 63.5 L31.5 59.5 Z" fill="#FFFFFF" />
      <Eyes />
      <path d="M28.8 34.9 Q32 37.7 35.2 34.9" stroke="#8A4A3C" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </>
  ),
};

/** 64×64 透明底半身像，铺满容器（容器负责底色 / 圆角 / 裁剪） */
export default function PersonaAvatar({ id }: { id: AvatarId }) {
  return (
    <svg className="block h-full w-full" viewBox="0 0 64 64" aria-hidden>
      {ART[id]}
    </svg>
  );
}