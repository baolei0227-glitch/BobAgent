'use client';

/**
 * Butler 悬浮球的「外观」部分（球体玻璃皮肤 + 河马脸 + 未读角标）
 *
 * 为什么单独抽出来：同一颗球现在有两个宿主——
 *   ① 主窗口内的 DOM 浮层（ButlerOrb，BobWork 可见时）
 *   ② 最小化后的独立置顶小窗（/butler-orb 路由，见 electron/butler-orb.ts）
 * 交互（拖拽 / 点击）两边不同，必须各自实现；外观若各写一份必然逐渐走形，故只留这一份。
 * 常量（尺寸 / 留白）在 `@/lib/butler/orb-geometry`，那边同时被主进程与单测引用。
 */
import { HippoFace } from './HippoFace';

/** 球体玻璃皮肤。`standalone` = 独立置顶窗（桌面悬浮）下的加厚版本 */
export function OrbGlassStyle() {
  return (
    <style>{`
        .butler-orb:active { cursor: grabbing !important; }
        /* 球体：**不用黑色描边**，靠「液态玻璃」撑出立体球感——
           ① 折射（backdrop-filter）：背后画布被模糊 + 提饱和，这是「液态玻璃」与「半透明圆」的分界。
              blur 压在 5px（悬停 8px）——球是 position:fixed 常驻元素，大半径 blur 在画布拖动时掉帧明显；
              「更水晶」主要靠 saturate 拉高（230%）：透过球看到的画布明显更浓，玻璃感立现且几乎零开销。
           ② 左上柔光高光（径向渐变，不是硬线，所以不会跟河马耳朵打架）
           ③ 边缘暗化（limb darkening）：中心全透明 → 越靠边越沉，球体边界由此成形（加强后球面立体感更足）
           ④ 上缘镜面弧 + 下缘反射亮弧（::after，见下）+ 外投影 + 左上内高光 + 右下内阴影（体积） */
/* 玻璃本体色用变量：默认=冰晶蓝（冷静），有未读=暖琥珀（提醒）。
           只染「边缘暗化 + 内光晕 + 内阴影 + 极淡中心晕」，高光弧保持纯白——
           真玻璃的高光永远是光源色，染了反而显假。 */
        .butler-orb {
          --glass-tint: rgba(90,150,220,0.06);
          --glass-edge-mid: rgba(90,150,220,0.20);
          --glass-edge-deep: rgba(40,90,160,0.55);
          --glass-glow: rgba(90,150,220,0.30);
          --glass-glow-hover: rgba(90,150,220,0.36);
          --glass-inner-dark: rgba(30,60,120,0.28);
          --glass-inner-dark-hover: rgba(30,60,120,0.32);
        }
        .butler-orb.has-unread {
          --glass-tint: rgba(210,160,80,0.07);
          --glass-edge-mid: rgba(210,160,80,0.20);
          --glass-edge-deep: rgba(160,110,40,0.52);
          --glass-glow: rgba(210,160,80,0.30);
          --glass-glow-hover: rgba(210,160,80,0.36);
          --glass-inner-dark: rgba(120,80,30,0.28);
          --glass-inner-dark-hover: rgba(120,80,30,0.32);
        }
        .butler-orb .ball {
          position: absolute; inset: 0; border-radius: 50%;
          overflow: hidden;
          background:
            radial-gradient(circle at 50% 50%, var(--glass-tint) 0%, transparent 55%),
            radial-gradient(circle at 28% 22%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.38) 13%, rgba(255,255,255,0) 35%),
            radial-gradient(circle at 36% 30%, rgba(255,255,255,0.48) 0%, rgba(255,255,255,0) 51%),
            radial-gradient(circle at 50% 50%, rgba(255,255,255,0) 40%, var(--glass-edge-mid) 70%, var(--glass-edge-deep) 100%);
          -webkit-backdrop-filter: blur(5px) saturate(230%);
          backdrop-filter: blur(5px) saturate(230%);
          box-shadow:
            0 6px 18px rgba(15,20,40,0.26),
            0 1px 2px rgba(15,20,40,0.16),
            0 0 0 0.5px rgba(255,255,255,0.55),
            inset 0 0 7px var(--glass-glow),
            inset 0 1px 1px rgba(255,255,255,1),
            inset 3px 4px 10px rgba(255,255,255,0.72),
            inset -3px -5px 12px var(--glass-inner-dark),
            inset 0 -5px 9px rgba(255,255,255,0.30);
          transition: box-shadow .18s ease, background .18s ease, transform .18s ease, backdrop-filter .18s ease;
        }
        /* 镜面弧（specular rim）：上缘一道贴内缘的窄亮弧 + 下缘一道更淡的反射亮弧——
           一主一反两道弧是玻璃球（而非水珠/气泡）最经典的视觉特征。
           单独用 ::after 画，避免与中心高光糊成一片白。 */
        .butler-orb .ball::after {
          content: ''; position: absolute; inset: 0; border-radius: 50%;
          background:
            radial-gradient(ellipse 76% 46% at 50% -14%, rgba(255,255,255,0.98) 0%, rgba(255,255,255,0.26) 42%, rgba(255,255,255,0) 72%),
            radial-gradient(ellipse 58% 26% at 50% 106%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 62%);
          mix-blend-mode: screen;
          pointer-events: none;
        }
        .butler-orb:hover .ball {
          box-shadow:
            0 9px 24px rgba(15,20,40,0.32),
            0 1px 3px rgba(15,20,40,0.18),
            0 0 0 0.5px rgba(255,255,255,0.70),
            inset 0 0 9px var(--glass-glow-hover),
            inset 0 1px 1px rgba(255,255,255,1),
            inset 4px 5px 13px rgba(255,255,255,0.85),
            inset -4px -6px 15px var(--glass-inner-dark-hover),
            inset 0 -6px 11px rgba(255,255,255,0.36);
          transform: scale(1.05);
          -webkit-backdrop-filter: blur(8px) saturate(250%);
          backdrop-filter: blur(8px) saturate(250%);
        }
        /* 河马线稿：黑色线条、透明底 → 叠在玻璃球里（不投影，才像「球里」而不是「球上」）。
           用矢量版 HippoFace（同一张线稿描的路径），好处是眼睛能独立分组、可眨眼。
           尺寸按 34px 球内河马实渲染 ≈25px 折算：25/34 ≈ 73.5%，每边留白 (1-73.5%)/2 = 13.25%。 */
        .butler-orb .ball .hippo-face { position: absolute; inset: 13.25%; width: 73.5%; height: 73.5%; }

        /* ===== 独立置顶窗（桌面悬浮）专用加厚 =====
           透明 BrowserWindow 的 backdrop-filter **拿不到窗口背后的桌面像素**（不进同一合成层），
           所以「折射」在独立态是失效的：照搬主窗口那套会明显发飘、读不出球体边界。
           这里① 去掉无效的 backdrop-filter；② 把中心晕与边缘暗化加重补回体积；
           ③ 投影换成小半径——窗外框只有 ORB_WINDOW_PAD(10px) 内边距，主窗口那套
              「0 9px 24px」会被窗口边缘切出一条直边（比没有投影更难看）。 */
        .butler-orb.standalone .ball {
          -webkit-backdrop-filter: none;
          backdrop-filter: none;
          background:
            radial-gradient(circle at 50% 50%, var(--glass-tint) 0%, rgba(255,255,255,0.10) 45%, transparent 60%),
            radial-gradient(circle at 28% 22%, rgba(255,255,255,0.98) 0%, rgba(255,255,255,0.42) 13%, rgba(255,255,255,0) 35%),
            radial-gradient(circle at 36% 30%, rgba(255,255,255,0.52) 0%, rgba(255,255,255,0) 51%),
            radial-gradient(circle at 50% 50%, rgba(255,255,255,0.06) 34%, var(--glass-edge-mid) 62%, var(--glass-edge-deep) 100%);
          box-shadow:
            0 4px 10px rgba(15,20,40,0.34),
            0 1px 2px rgba(15,20,40,0.22),
            0 0 0 0.5px rgba(255,255,255,0.60),
            inset 0 0 8px var(--glass-glow),
            inset 0 1px 1px rgba(255,255,255,1),
            inset 3px 4px 10px rgba(255,255,255,0.66),
            inset -3px -5px 12px var(--glass-inner-dark),
            inset 0 -5px 9px rgba(255,255,255,0.26);
        }
        .butler-orb.standalone:hover .ball {
          /* 悬停放大不取消（+5% 仍在窗口内边距里），但投影同样不得超出内边距 */
          box-shadow:
            0 5px 11px rgba(15,20,40,0.38),
            0 1px 3px rgba(15,20,40,0.24),
            0 0 0 0.5px rgba(255,255,255,0.72),
            inset 0 0 9px var(--glass-glow-hover),
            inset 0 1px 1px rgba(255,255,255,1),
            inset 4px 5px 13px rgba(255,255,255,0.80),
            inset -4px -6px 15px var(--glass-inner-dark-hover),
            inset 0 -6px 11px rgba(255,255,255,0.32);
          transform: scale(1.05);
        }
      `}</style>
  );
}

/** 球体内容：玻璃球 + 河马脸 + 未读角标。宿主负责外层 button 的定位与交互 */
export function OrbFace({
  unread,
  tiltDeg = 0,
  dragging = false,
}: {
  unread: number;
  /** 拖拽歪头角度（度） */
  tiltDeg?: number;
  dragging?: boolean;
}) {
  return (
    <>
      <span className="ball" aria-hidden>
        {/* wiggle：有未读时河马左右轻摇；tilt/dragging：拖拽时朝移动方向歪头 */}
        <HippoFace className="hippo-face" wiggle={unread > 0} tiltDeg={tiltDeg} dragging={dragging} />
      </span>
      {unread > 0 && (
        <span
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            minWidth: 12,
            height: 12,
            padding: '0 3px',
            borderRadius: 999,
            background: 'var(--danger)',
            color: '#fff',
            fontSize: 8,
            lineHeight: '12px',
            textAlign: 'center',
            boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
          }}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </>
  );
}
