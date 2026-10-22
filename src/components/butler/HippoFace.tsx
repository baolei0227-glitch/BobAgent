'use client';

/**
 * HippoFace —— 河马线稿矢量版（多部件可动）
 *
 * 由 public/butler-orb.png 描摹生成（路径**请勿手改**；睁眼态与原图 IoU 0.97）：
 *   FACE_D  面部（头侧/眉线/嘴，双耳已从路径切出、耳根以弦封边）
 *   EARS    左右耳各自成组；transform-origin 钉在耳根弦的中点（轴在「根部」，
 *           扇动才不会与头脱节——历史教训）；外扇 ≤8° 时弦端点仍落在融合块内，不露缝
 *   EYES    双眼各自成组
 *
 * 动效（只动 transform，不重排；均尊重 prefers-reduced-motion）：
 *   - 眨眼 blink：JS 随机 2.2~6.2s，28% 连眨；眼睛 scaleY 收缩
 *   - 扇耳 flap：JS 随机 3.5~8s；外扇 8° → 回正 → 内收 3°
 *   - 呼吸 breathe：CSS keyframes，3.6s 上浮 0.8px + 微缩放，常驻
 *   - 摇铃 wiggle：有未读时左右轻摇 1.8s 一轮
 *   - 拖拽歪头 tilt：拖球速度 → 旋转角（rAF 里衰减），松手弹簧回正；
 *     拖动中呼吸/摇铃暂停（paused），免得各动效打架
 *
 * 分层（每层 HTML 盒各占一个 transform，互不覆盖）：
 *   span.tilt（rotate，交互） > span.wiggle（rotate，动画） > svg.breathe（translate/scale） > g 部件
 * 呼吸/摇铃不能放进 svg 内部 g：那上面 CSS px 是 viewBox 用户单位，缩到 25px 后动效看不见。
 */
import { useEffect, useState } from 'react';

const FACE_D =
  'M71.0 334.0Q72.0 344.0 76.5 354.0Q81.0 364.0 90.5 374.5Q100.0 385.0 107.0 390.0Q114.0 395.0 126.5 401.0Q139.0 407.0 152.0 411.0Q165.0 415.0 181.5 418.0Q198.0 421.0 217.5 422.5Q237.0 424.0 257.0 424.0Q277.0 424.0 299.0 422.0Q321.0 420.0 336.0 417.0Q351.0 414.0 366.5 408.5Q382.0 403.0 394.0 396.0Q406.0 389.0 416.0 379.5Q426.0 370.0 431.0 361.5Q436.0 353.0 438.5 344.5Q441.0 336.0 440.5 326.0Q440.0 316.0 437.0 309.0Q434.0 302.0 431.5 298.5Q429.0 295.0 421.5 289.0Q414.0 283.0 408.0 280.5Q402.0 278.0 397.0 277.0Q392.0 276.0 380.0 276.5Q368.0 277.0 341.5 282.5Q315.0 288.0 293.0 290.0Q271.0 292.0 241.0 291.0Q211.0 290.0 197.5 288.0Q184.0 286.0 163.5 281.5Q143.0 277.0 131.0 276.5Q119.0 276.0 111.0 278.0Q103.0 280.0 97.0 283.5Q91.0 287.0 83.5 295.5Q76.0 304.0 73.0 314.0Q70.0 324.0 71.0 334.0ZM91.0 317.5Q93.0 312.0 98.0 306.5Q103.0 301.0 106.5 299.0Q110.0 297.0 115.5 295.5Q121.0 294.0 128.0 294.0Q135.0 294.0 164.5 300.0Q194.0 306.0 210.0 307.5Q226.0 309.0 256.5 309.0Q287.0 309.0 310.5 306.0Q334.0 303.0 351.5 299.0Q369.0 295.0 380.0 294.5Q391.0 294.0 398.0 296.5Q405.0 299.0 411.0 304.5Q417.0 310.0 419.5 315.5Q422.0 321.0 422.0 329.0Q422.0 337.0 420.5 341.5Q419.0 346.0 415.0 352.5Q411.0 359.0 402.5 367.0Q394.0 375.0 382.0 382.0Q370.0 389.0 356.5 393.5Q343.0 398.0 329.5 400.5Q316.0 403.0 293.5 405.0Q271.0 407.0 252.5 407.0Q234.0 407.0 215.5 405.0Q197.0 403.0 183.5 400.5Q170.0 398.0 158.5 394.5Q147.0 391.0 137.5 386.5Q128.0 382.0 120.0 376.5Q112.0 371.0 104.0 362.0Q96.0 353.0 92.5 344.0Q89.0 335.0 89.0 329.0Q89.0 323.0 91.0 317.5ZM82.0 143.5Q80.0 148.0 81.0 151.0Q82.0 154.0 84.0 156.0Q86.0 158.0 81.0 163.0Q76.0 168.0 73.0 180.0Q70.0 192.0 61.5 198.0Q53.0 204.0 43.5 213.5Q34.0 223.0 28.5 230.5Q23.0 238.0 18.5 246.0Q14.0 254.0 10.5 262.5Q7.0 271.0 5.0 279.5Q3.0 288.0 2.5 296.5Q2.0 305.0 1.0 306.0Q0.0 307.0 0.0 315.5Q0.0 324.0 1.0 325.0Q2.0 326.0 3.5 338.5Q5.0 351.0 11.5 366.5Q18.0 382.0 24.5 391.0Q31.0 400.0 40.5 409.5Q50.0 419.0 61.5 427.0Q73.0 435.0 83.0 440.0Q93.0 445.0 107.0 450.0Q121.0 455.0 138.5 459.0Q156.0 463.0 171.0 465.0Q186.0 467.0 208.5 468.5Q231.0 470.0 254.5 470.0Q278.0 470.0 311.0 467.5Q344.0 465.0 369.0 459.5Q394.0 454.0 404.0 450.5Q414.0 447.0 424.5 442.0Q435.0 437.0 450.0 426.5Q465.0 416.0 474.0 406.5Q483.0 397.0 489.0 388.0Q495.0 379.0 499.5 369.0Q504.0 359.0 506.0 352.0Q508.0 345.0 508.5 339.5Q509.0 334.0 510.0 333.0Q511.0 332.0 511.0 314.5Q511.0 297.0 510.0 296.0Q509.0 295.0 508.5 289.5Q508.0 284.0 504.5 272.5Q501.0 261.0 495.0 249.5Q489.0 238.0 483.0 230.0Q477.0 222.0 469.5 214.5Q462.0 207.0 451.5 199.0Q441.0 191.0 438.5 179.5Q436.0 168.0 431.0 163.0Q426.0 158.0 428.0 156.0Q430.0 154.0 431.0 151.0Q432.0 148.0 430.0 143.5Q428.0 139.0 392.0 107.0Q356.0 75.0 352.0 73.5Q348.0 72.0 345.0 73.0Q342.0 74.0 339.5 76.5Q337.0 79.0 329.5 72.5Q322.0 66.0 310.0 63.5Q298.0 61.0 287.0 60.0Q276.0 59.0 257.0 59.0Q238.0 59.0 218.0 61.5Q198.0 64.0 193.0 65.5Q188.0 67.0 181.5 73.0Q175.0 79.0 172.5 76.5Q170.0 74.0 167.0 73.0Q164.0 72.0 160.0 73.5Q156.0 75.0 120.0 107.0Q84.0 139.0 82.0 143.5ZM25.5 273.5Q28.0 266.0 31.5 259.0Q35.0 252.0 39.5 245.5Q44.0 239.0 52.0 230.5Q60.0 222.0 71.5 213.5Q83.0 205.0 99.0 197.5Q115.0 190.0 134.0 184.5Q153.0 179.0 174.5 175.5Q196.0 172.0 219.0 170.5Q242.0 169.0 273.5 170.0Q305.0 171.0 331.5 175.0Q358.0 179.0 377.0 184.5Q396.0 190.0 408.5 195.5Q421.0 201.0 434.5 210.0Q448.0 219.0 459.5 231.5Q471.0 244.0 478.5 258.5Q486.0 273.0 489.0 286.0Q492.0 299.0 492.0 314.5Q492.0 330.0 490.5 337.5Q489.0 345.0 486.0 353.5Q483.0 362.0 477.5 371.5Q472.0 381.0 467.0 387.0Q462.0 393.0 450.5 403.0Q439.0 413.0 432.5 417.0Q426.0 421.0 413.0 427.0Q400.0 433.0 377.5 439.0Q355.0 445.0 325.5 448.5Q296.0 452.0 258.5 452.0Q221.0 452.0 203.0 450.5Q185.0 449.0 164.0 445.5Q143.0 442.0 123.5 436.0Q104.0 430.0 95.5 426.0Q87.0 422.0 77.5 416.0Q68.0 410.0 58.0 401.0Q48.0 392.0 39.5 380.0Q31.0 368.0 26.0 354.0Q21.0 340.0 20.0 333.5Q19.0 327.0 19.0 314.5Q19.0 302.0 21.0 291.5Q23.0 281.0 25.5 273.5ZM133.0 127.5Q168.0 97.0 171.5 92.5Q175.0 88.0 189.5 84.0Q204.0 80.0 214.5 78.5Q225.0 77.0 249.0 76.5Q273.0 76.0 287.0 77.5Q301.0 79.0 318.5 83.5Q336.0 88.0 340.0 92.5Q344.0 97.0 378.5 127.5Q413.0 158.0 417.0 168.5Q421.0 179.0 419.5 179.5Q418.0 180.0 401.0 173.5Q384.0 167.0 372.0 164.0Q360.0 161.0 342.0 158.0Q324.0 155.0 307.5 153.5Q291.0 152.0 256.0 152.0Q221.0 152.0 204.0 153.5Q187.0 155.0 162.5 159.5Q138.0 164.0 123.5 168.5Q109.0 173.0 101.0 176.5Q93.0 180.0 92.0 179.5Q91.0 179.0 94.5 168.5Q98.0 158.0 133.0 127.5Z';

interface EarDef { d: string; pivot: [number, number]; dir: number; }
const EARS: EarDef[] = [
  { d: 'M178.5 69.0Q170.0 71.0 167.5 66.5Q165.0 62.0 160.0 56.5Q155.0 51.0 149.0 47.5Q143.0 44.0 139.5 43.0Q136.0 42.0 123.5 42.5Q111.0 43.0 104.0 46.5Q97.0 50.0 91.0 56.5Q85.0 63.0 81.5 72.0Q78.0 81.0 78.0 87.5Q78.0 94.0 79.0 98.0Q80.0 102.0 82.5 107.0Q85.0 112.0 91.0 118.0Q97.0 124.0 97.0 125.0Q97.0 126.0 93.5 131.0Q90.0 136.0 83.5 150.5Q77.0 165.0 93.5 150.5Q110.0 136.0 122.0 123.5Q134.0 111.0 141.5 106.0Q149.0 101.0 168.0 84.0Q187.0 67.0 178.5 69.0ZM146.0 67.0Q150.0 71.0 151.5 74.5Q153.0 78.0 141.5 85.0Q130.0 92.0 120.0 101.0Q110.0 110.0 108.5 110.0Q107.0 110.0 103.0 105.5Q99.0 101.0 97.5 97.5Q96.0 94.0 96.0 87.5Q96.0 81.0 98.5 75.5Q101.0 70.0 105.5 66.0Q110.0 62.0 115.0 60.0Q120.0 58.0 124.5 58.0Q129.0 58.0 135.5 60.5Q142.0 63.0 146.0 67.0Z', pivot: [128.0, 116.0], dir: -1 },
  { d: 'M344.5 84.5Q364.0 102.0 372.5 108.0Q381.0 114.0 391.5 125.0Q402.0 136.0 418.5 150.5Q435.0 165.0 429.0 151.5Q423.0 138.0 419.0 132.0Q415.0 126.0 415.0 125.0Q415.0 124.0 420.5 118.5Q426.0 113.0 428.5 108.5Q431.0 104.0 432.5 98.5Q434.0 93.0 434.0 87.5Q434.0 82.0 433.0 77.5Q432.0 73.0 429.5 68.0Q427.0 63.0 421.0 56.5Q415.0 50.0 406.0 46.0Q397.0 42.0 387.0 42.0Q377.0 42.0 372.0 43.5Q367.0 45.0 362.5 47.5Q358.0 50.0 353.0 55.0Q348.0 60.0 344.5 65.5Q341.0 71.0 333.0 69.0Q325.0 67.0 344.5 84.5ZM376.0 60.5Q382.0 58.0 386.5 58.0Q391.0 58.0 395.5 59.5Q400.0 61.0 406.0 66.5Q412.0 72.0 414.0 76.5Q416.0 81.0 416.0 87.0Q416.0 93.0 415.0 96.0Q414.0 99.0 410.0 104.0Q406.0 109.0 404.0 109.5Q402.0 110.0 390.5 100.0Q379.0 90.0 368.5 84.0Q358.0 78.0 359.5 75.0Q361.0 72.0 365.5 67.5Q370.0 63.0 376.0 60.5Z', pivot: [384.0, 116.0], dir: 1 },
];

interface EyeDef { d: string; cx: number; cy: number; }
const EYES: EyeDef[] = [
  { d: 'M171.5 216.5Q170.0 219.0 170.0 222.5Q170.0 226.0 175.5 232.5Q181.0 239.0 184.5 241.0Q188.0 243.0 192.5 243.0Q197.0 243.0 199.5 241.0Q202.0 239.0 202.5 234.0Q203.0 229.0 198.0 223.0Q193.0 217.0 188.5 214.5Q184.0 212.0 180.5 212.0Q177.0 212.0 175.0 213.0Q173.0 214.0 171.5 216.5Z', cx: 186.5, cy: 227.6 },
  { d: 'M336.0 213.0Q334.0 212.0 330.5 212.0Q327.0 212.0 324.5 213.0Q322.0 214.0 316.0 220.0Q310.0 226.0 309.0 228.0Q308.0 230.0 308.5 234.0Q309.0 238.0 312.0 240.5Q315.0 243.0 319.0 243.0Q323.0 243.0 326.5 241.0Q330.0 239.0 335.5 233.0Q341.0 227.0 341.5 224.5Q342.0 222.0 340.0 218.0Q338.0 214.0 336.0 213.0Z', cx: 324.8, cy: 227.5 },
];

const BLINK_MS = 70;
const BLINK_EVERY_MIN = 2200;
const BLINK_EVERY_MAX = 6200;
const DOUBLE_CHANCE = 0.28;
const DOUBLE_GAP_MS = 130;

const FLAP_OUT_DEG = 8;   // 外扇角度（>~10° 耳根会露缝，勿加大）
const FLAP_IN_DEG = 3;
const FLAP_EVERY_MIN = 3500;
const FLAP_EVERY_MAX = 8000;
const FLAP_OUT_MS = 130;
const FLAP_BACK_MS = 110;

export function HippoFace({
  className,
  wiggle = false,
  tiltDeg = 0,
  dragging = false,
}: {
  className?: string;
  /** 未读时左右轻摇 */
  wiggle?: boolean;
  /** 拖拽歪头角度（度，正值=顺时针） */
  tiltDeg?: number;
  /** 是否正在拖球：true=快速跟随，false=松手弹簧；同时暂停呼吸/摇铃 */
  dragging?: boolean;
}) {
  const [blinking, setBlinking] = useState(false);
  /** 扇耳当前角度的「外扇基准角」，实际作用到耳上 = value * ear.dir */
  const [flapDeg, setFlapDeg] = useState(0);

  // 眨眼
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let closedTimer = 0;
    let reopenTimer = 0;
    let nextTimer = 0;
    let disposed = false;

    const blink = (withDouble: boolean) => {
      setBlinking(true);
      closedTimer = window.setTimeout(() => {
        setBlinking(false);
        if (withDouble) reopenTimer = window.setTimeout(() => blink(false), DOUBLE_GAP_MS);
      }, BLINK_MS);
    };
    const schedule = () => {
      nextTimer = window.setTimeout(() => {
        if (disposed) return;
        blink(Math.random() < DOUBLE_CHANCE);
        schedule();
      }, BLINK_EVERY_MIN + Math.random() * (BLINK_EVERY_MAX - BLINK_EVERY_MIN));
    };
    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(closedTimer);
      window.clearTimeout(reopenTimer);
      window.clearTimeout(nextTimer);
    };
  }, []);

  // 扇耳（独立随机节奏；三拍：外扇 → 回正 → 内收 → 回正）
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let t1 = 0; let t2 = 0; let t3 = 0; let nextTimer = 0;
    let disposed = false;

    const flap = () => {
      setFlapDeg(FLAP_OUT_DEG);
      t1 = window.setTimeout(() => {
        setFlapDeg(0);
        t2 = window.setTimeout(() => {
          setFlapDeg(-FLAP_IN_DEG);
          t3 = window.setTimeout(() => setFlapDeg(0), FLAP_BACK_MS);
        }, FLAP_BACK_MS);
      }, FLAP_OUT_MS);
    };
    const schedule = () => {
      nextTimer = window.setTimeout(() => {
        if (disposed) return;
        flap();
        schedule();
      }, FLAP_EVERY_MIN + Math.random() * (FLAP_EVERY_MAX - FLAP_EVERY_MIN));
    };
    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.clearTimeout(nextTimer);
    };
  }, []);

  const playState = dragging ? 'paused' : 'running';

  return (
    <>
      <style>{`
        @keyframes hippo-breathe {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-0.8px) scale(1.025); }
        }
        @keyframes hippo-wiggle {
          0%, 12% { transform: rotate(0deg); }
          20% { transform: rotate(-4deg); }
          32% { transform: rotate(3.2deg); }
          44% { transform: rotate(-2deg); }
          56% { transform: rotate(1deg); }
          64%, 100% { transform: rotate(0deg); }
        }
        .hippo-breathe { animation: hippo-breathe 3.6s ease-in-out infinite; transform-origin: center; }
        .hippo-wiggle { animation: hippo-wiggle 1.8s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .hippo-breathe, .hippo-wiggle { animation: none; }
        }
      `}</style>
      {/* tilt 层：交互歪头；拖动中快速跟随，松手弹簧回正（带回弹） */}
      <span
        className={className}
        aria-hidden="true"
        style={{
          display: 'block',
          transform: `rotate(${tiltDeg}deg)`,
          transformOrigin: 'center',
          transition: dragging
            ? 'transform 90ms ease-out'
            : 'transform 480ms cubic-bezier(.34,1.56,.64,1)',
        }}
      >
        {/* wiggle 层：未读摇铃 */}
        <span
          className={wiggle ? 'hippo-wiggle' : undefined}
          style={{ display: 'block', width: '100%', height: '100%', animationPlayState: playState }}
        >
          {/* breathe 层：常驻悬浮呼吸 */}
          <svg
            viewBox="0 0 512 512"
            className="hippo-breathe"
            focusable="false"
            style={{ width: '100%', height: '100%', display: 'block', animationPlayState: playState }}
          >
            <path fill="#000" fillRule="evenodd" d={FACE_D} />
            {EARS.map((e, i) => (
              <g
                key={`ear-${i}`}
                style={{
                  transformBox: 'view-box',
                  transformOrigin: `${e.pivot[0]}px ${e.pivot[1]}px`,
                  transform: `rotate(${flapDeg * e.dir}deg)`,
                  transition: 'transform 120ms ease-in-out',
                }}
              >
                <path fill="#000" fillRule="evenodd" d={e.d} />
              </g>
            ))}
            {EYES.map((e, i) => (
              <g
                key={`eye-${i}`}
                style={{
                  transformBox: 'fill-box',
                  transformOrigin: 'center',
                  transform: blinking ? 'scaleY(0.06)' : 'scaleY(1)',
                  transition: `transform ${BLINK_MS}ms cubic-bezier(.4,0,.2,1)`,
                }}
              >
                <path fill="#000" fillRule="evenodd" d={e.d} />
              </g>
            ))}
          </svg>
        </span>
      </span>
    </>
  );
}
