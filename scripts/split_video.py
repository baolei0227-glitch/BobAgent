#!/usr/bin/env python3
"""
微信聊天记录录屏智能切页截图

把连续滚动的聊天录屏切分为"页"级截图序列，控制相邻页内容重叠率在目标值附近
（默认 10%，容差 ±5%），保证上下文连贯的同时避免大段重复。

算法（两阶段，全部本地）：
  1. 像素滚动检测（零成本）：ffmpeg 低分辨率灰度帧流 → 行均值向量 → 逐帧估计内容
     垂直位移（滚动/新消息弹出），累计滚动量达到 overlap*屏高 时记录候选切页点
  2. OCR 精选（macOS Vision，可选）：对候选切页点附近帧做本地 OCR，按文本行重叠率
     选最接近目标重叠率的一帧作为最终页；OCR 不可用时回退像素切页

用法:
  python3 split_video.py <video> --out <dir> [选项]

选项:
  --overlap 0.10       目标重叠率（下一页含上一页的比例）
  --tolerance 0.05     重叠率容差（report 中标记偏离项）
  --fps 5              像素检测抽帧率（越高越准、越慢）
  --width 270          像素检测帧宽度（越小越快）
  --max-duration 300   视频时长上限（秒），超出拒绝
  --ocr                启用本地 OCR 精选（macOS 且可编译 swift 时可用）
  --ocr-script PATH    指定 ocr_vision.swift 路径（默认自动探测）
  --min-gap 0.6        相邻页最小时间间隔（秒），避免画面抖动导致连续切页

输出:
  <out>/page-001.png, page-002.png ...  原始分辨率截图序列
  <out>/split-report.json               每页时间戳、验证方式等
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# ==================== ffmpeg 定位 ====================

def find_ffmpeg():
    """按优先级定位 ffmpeg：FFMPEG_PATH → @ffmpeg-installer（含 pnpm 布局）→ node 解析 → PATH"""
    env = os.environ.get('FFMPEG_PATH')
    if env and os.path.exists(env):
        return env
    for root in [str(Path.home() / 'Desktop' / 'BobWork' / 'projects'), os.getcwd()]:
        nm = Path(root) / 'node_modules'
        if not nm.is_dir():
            continue
        # 扁平布局：node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg
        installer = nm / '@ffmpeg-installer'
        if installer.is_dir():
            for sub in sorted(installer.iterdir()):
                for name in ('ffmpeg', 'ffmpeg.exe'):
                    p = sub / name
                    if p.exists():
                        return str(p)
        # pnpm 布局：node_modules/.pnpm/@ffmpeg-installer+<platform>@*/node_modules/@ffmpeg-installer/<platform>/ffmpeg
        pnpm = nm / '.pnpm'
        if pnpm.is_dir():
            for d in sorted(pnpm.glob('@ffmpeg-installer+*/node_modules/@ffmpeg-installer/*')):
                if not d.is_dir():
                    continue
                for name in ('ffmpeg', 'ffmpeg.exe'):
                    p = d / name
                    if p.exists():
                        return str(p)
        # 与应用逻辑一致：node 运行时解析 @ffmpeg-installer/ffmpeg
        try:
            r = subprocess.run(
                ['node', '-e', 'try{console.log(require("@ffmpeg-installer/ffmpeg").path)}catch(e){}'],
                capture_output=True, text=True, timeout=10, cwd=root,
            )
            p = r.stdout.strip()
            if p and os.path.exists(p):
                return p
        except Exception:
            pass
    return shutil.which('ffmpeg')

# ==================== 视频探测 ====================

def probe_duration(ffmpeg, video):
    """返回视频时长（秒），未知返回 None"""
    try:
        r = subprocess.run([ffmpeg, '-i', video], capture_output=True, text=True, timeout=15)
        out = r.stderr + r.stdout
    except Exception:
        return None
    for line in out.splitlines():
        if 'Duration:' not in line:
            continue
        idx = line.find('Duration:')
        seg = line[idx + 9:idx + 30]
        parts = seg.split(':')
        try:
            hh, mm = float(parts[0]), float(parts[1])
            ss = float(parts[2].split(',')[0])
            return hh * 3600 + mm * 60 + ss
        except (ValueError, IndexError):
            return None
    return None

# ==================== 灰度帧流 ====================

def probe_resolution(ffmpeg, video):
    """从 ffmpeg -i stderr 解析视频分辨率 (w, h)；失败返回 None"""
    try:
        r = subprocess.run([ffmpeg, '-i', video], capture_output=True, text=True, timeout=15)
        out = r.stderr + r.stdout
    except Exception:
        return None
    for line in out.splitlines():
        m = re.search(r'\b(\d{2,5})x(\d{2,5})\b', line)
        if m:
            return int(m.group(1)), int(m.group(2))
    return None

def stream_gray_frames(ffmpeg, video, fps, width, height=None):
    """
    生成器：逐帧产出 (t_sec, frame_bytes, w, h)。
    ffmpeg 输出 rawvideo 灰度帧，Python 直接读字节流，零图像库依赖。
    """
    if height is None:
        res = probe_resolution(ffmpeg, video)
        height = round(res[1] * width / res[0] / 2) * 2 if res else 480
    cmd = [
        ffmpeg, '-v', 'error', '-i', video,
        '-vf', f'scale={width}:{height},fps={fps:g},format=gray',
        '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    out = proc.stdout
    frame_size = width * height

    idx = 0
    buf = b''
    while True:
        while len(buf) < frame_size:
            c = out.read(frame_size - len(buf))
            if not c:
                break
            buf += c
        if len(buf) < frame_size:
            break
        frame = buf[:frame_size]
        buf = buf[frame_size:]
        yield idx / fps, frame, width, height
        idx += 1
    out.close()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()

# ==================== 像素位移估计 ====================

def row_vector(frame, w, h):
    """行均值向量：每行像素均值（比逐像素 SAD 快一个量级）"""
    return [sum(frame[y * w:(y + 1) * w]) // w for y in range(h)]

def estimate_shift(pv, cv, h, max_d=80, step=2, top_ratio=0.10, bot_ratio=0.88):
    """
    估计相邻帧内容垂直位移（正 = 内容向上滚动，新内容从底部进入）。
    只统计消息区（排除顶部状态栏/底部输入栏），行向量平移匹配。
    稳健性：
      - 画面基本静止（零位移 SAD 很小）→ 返回 0
      - 画面变化但无法形成整体平移（动画/弹窗等）→ 返回 0（best 不显著优于 s0）
    """
    top = int(h * top_ratio)
    bot = int(h * bot_ratio)
    n = max(1, bot - top)
    s0 = 0
    for y in range(top, bot):
        s0 += abs(pv[y] - cv[y])
    avg0 = s0 / n
    if avg0 < 6:  # 画面基本静止（含光标闪烁、细微噪声）
        return 0
    best_d, best_s = 0, s0
    for d in range(-max_d, max_d + 1, step):
        if d == 0:
            continue
        s = 0
        for y in range(top, bot):
            yy = y - d
            if 0 <= yy < h:
                s += abs(pv[y] - cv[yy])
            else:
                s += 255
        if s < best_s:
            best_s = s
            best_d = d
    # 匹配质量门槛：整体平移必须显著优于零位移，否则视为"变化而非滚动"
    if best_s > s0 * 0.80:
        return 0
    return best_d

def bottom_new_height(pv, cv, h, top_ratio=0.82, thresh=30):
    """
    零/微滚动时，检测底部新内容带高度（新消息原地弹出等场景）。
    返回底部连续变化行数（像素）。
    """
    start = int(h * top_ratio)
    run = 0
    best = 0
    for y in range(start, h):
        if abs(pv[y] - cv[y]) > thresh:
            run += 1
            best = max(best, run)
        else:
            run = 0
    return best

# ==================== 候选切页（像素阶段） ====================

def pixel_candidates(ffmpeg, video, fps, width, overlap, min_gap_sec):
    """
    像素阶段：返回候选切页时间列表（精确到帧）。

    切页数学：相邻页顶滚动间隔 Δ 时，内容重叠率 = 1 - Δ/屏高。
    要"下一页含上一页 ≈ overlap"，需 Δ = (1-overlap)*屏高（如 overlap=10% → 滚动 90% 屏高切一页）。

    滚动段模型：真实滚动是连续多帧同向位移；编码噪声/界面抖动是正负交替的
    微位移（±10px 级）。只有"同向连续 ≥2 帧"的段才累计为有效滚动。
    累计滚动达标后，取**下一个静止帧**（滚动活动结束）作为页顶，保证页面稳定可读；
    持续滚动超过 1.5s 未遇静止时强制切页兜底。
    """
    pv = None
    acc = 0.0          # 自上次切页累计的有效滚动
    seg_acc = 0.0      # 当前同向段累计
    seg_dir = 0        # 当前段方向（1 向上 / -1 向下）
    seg_frames = 0     # 当前段帧数（≥2 帧的同向段才视为有效滚动）
    pages = [0.0]
    last_page_t = 0.0
    ready_since = None  # acc 达标的时刻（等待静止或超时）
    for t, frame, w, h in stream_gray_frames(ffmpeg, video, fps, width):
        cv = row_vector(frame, w, h)
        if pv is None:
            pv = cv
            continue
        d = estimate_shift(pv, cv, h)
        pv = cv
        # 抖动/微变过滤：一条聊天消息在缩略帧上通常 ≥20px，<12px 视为噪声
        if abs(d) < 12:
            d = 0

        thr = (1 - overlap) * h

        if d == 0:
            # 段结束：仅"同向连续 ≥2 帧"的段并入总累计（单帧抖动不入账）
            if seg_dir != 0:
                if seg_dir > 0 and seg_frames >= 2:
                    acc += seg_acc
                seg_acc = 0.0
                seg_dir = 0
                seg_frames = 0
            # 静止帧：若累计已达标且满足页间距，取为页顶（稳定可读）
            if ready_since is not None and (t - last_page_t) >= min_gap_sec:
                pages.append(t)
                acc = 0.0
                ready_since = None
                last_page_t = t
            continue

        ndir = 1 if d > 0 else -1
        if seg_dir == 0:
            seg_dir = ndir
            seg_acc = abs(d)
            seg_frames = 1
        elif ndir == seg_dir:
            seg_acc += abs(d)
            seg_frames += 1
        else:
            # 方向反转（抖动）→ 丢弃该段，从新方向重新累计
            seg_dir = ndir
            seg_acc = abs(d)
            seg_frames = 1

        # 累计滚动达标（仅正向），标记等待静止帧
        if (seg_dir > 0 and seg_frames >= 2
                and acc + seg_acc >= thr
                and ready_since is None):
            ready_since = t

        # 持续滚动超时兜底（未遇静止）
        if ready_since is not None and (t - ready_since) >= 1.5 and (t - last_page_t) >= min_gap_sec:
            pages.append(t)
            acc = 0.0
            seg_acc = 0.0
            seg_dir = 0
            seg_frames = 0
            ready_since = None
            last_page_t = t
    return pages

# ==================== OCR 精选（可选） ====================

def locate_ocr_script(explicit):
    if explicit and os.path.exists(explicit):
        return explicit
    cands = [
        str(Path.home() / 'Desktop' / 'BobWork' / 'projects' / 'src' / 'lib' / 'pdf' / 'core' / 'ocr_vision.swift'),
        str(Path.cwd() / 'src' / 'lib' / 'pdf' / 'core' / 'ocr_vision.swift'),
        str(Path.cwd() / 'scripts' / 'ocr_vision.swift'),
    ]
    for c in cands:
        if os.path.exists(c):
            return c
    return None

def ensure_ocr_bin(script_path):
    """swiftc 编译 ocr_vision.swift（源码 hash 缓存）→ 二进制路径；失败返回 None"""
    if not shutil.which('swiftc'):
        return None
    try:
        digest = hashlib.sha256(Path(script_path).read_bytes()).hexdigest()[:12]
        cache = Path.home() / 'Library' / 'Caches' / 'BobWork'
        cache.mkdir(parents=True, exist_ok=True)
        binp = cache / f'ocr-vision-{digest}'
        if not binp.exists():
            r = subprocess.run(['swiftc', '-O', script_path, '-o', str(binp)],
                               capture_output=True, timeout=120)
            if r.returncode != 0 or not binp.exists():
                return None
        return str(binp)
    except Exception:
        return None

def ocr_text_lines(ocr_bin, img_path):
    """OCR 单张图 → 消息区文本行列表（排除顶部/底部固定 UI 文字）"""
    try:
        r = subprocess.run([ocr_bin, img_path], capture_output=True, timeout=60)
        data = json.loads(r.stdout)
        pages = data.get('pages') or []
        if not pages:
            return []
        lines = []
        for b in (pages[0].get('blocks') or []):
            y = b.get('y', 0.5)
            if 0.12 <= y <= 0.86:  # 只统计消息区
                t = (b.get('text') or '').strip()
                if t:
                    lines.append(t)
        return lines
    except Exception:
        return []

def overlap_ratio(prev_lines, cur_lines):
    """文本行重叠率：|A∩B| / min(|A|,|B|)；任一侧为空返回 None"""
    if not prev_lines or not cur_lines:
        return None
    a, b = set(prev_lines), set(cur_lines)
    return len(a & b) / min(len(a), len(b))

# ==================== 主流程 ====================

def export_frame(ffmpeg, video, t_sec, out_path):
    """按时间点抽原始分辨率 PNG"""
    cmd = [ffmpeg, '-v', 'error', '-ss', f'{t_sec:.2f}', '-i', video,
           '-frames:v', '1', '-y', out_path]
    return subprocess.run(cmd, capture_output=True, timeout=60).returncode == 0

def main():
    ap = argparse.ArgumentParser(description='微信聊天录屏智能切页截图')
    ap.add_argument('video')
    ap.add_argument('--out', required=True)
    ap.add_argument('--overlap', type=float, default=0.10)
    ap.add_argument('--tolerance', type=float, default=0.05)
    ap.add_argument('--fps', type=float, default=5)
    ap.add_argument('--width', type=int, default=270)
    ap.add_argument('--max-duration', type=float, default=300)
    ap.add_argument('--ocr', action='store_true', help='启用本地 OCR 精选（macOS）')
    ap.add_argument('--ocr-script', default='')
    ap.add_argument('--min-gap', type=float, default=0.6)
    args = ap.parse_args()

    if not os.path.exists(args.video):
        print(json.dumps({'ok': False, 'error': f'视频不存在: {args.video}'}, ensure_ascii=False))
        sys.exit(1)
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print(json.dumps({'ok': False, 'error': '未找到 ffmpeg（FFMPEG_PATH / @ffmpeg-installer / PATH 均不可用）'}, ensure_ascii=False))
        sys.exit(1)

    duration = probe_duration(ffmpeg, args.video)
    if duration is not None and duration > args.max_duration:
        print(json.dumps({'ok': False, 'error': f'视频时长 {duration:.0f}s 超过上限 {args.max_duration:.0f}s'}, ensure_ascii=False))
        sys.exit(1)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- 阶段 1：像素候选切页 ----
    pages = pixel_candidates(ffmpeg, args.video, args.fps, args.width, args.overlap, args.min_gap)
    verify = 'pixel-only'

    # ---- 阶段 2：OCR 精选（可选） ----
    ocr_bin = None
    if args.ocr:
        script = locate_ocr_script(args.ocr_script)
        if script:
            ocr_bin = ensure_ocr_bin(script)
        if ocr_bin:
            verify = 'ocr'
            frame_gap = 1.0 / args.fps
            refined = [0.0]
            prev_lines = None
            for t in pages[1:]:
                window = [max(0.0, t - 2 * frame_gap), t, t + 2 * frame_gap]
                best_t, best_score, best_overlap = t, None, None
                for wt in window:
                    tmp = out_dir / f'.probe-{wt:.2f}.png'
                    if not export_frame(ffmpeg, args.video, wt, str(tmp)):
                        continue
                    lines = ocr_text_lines(ocr_bin, str(tmp))
                    tmp.unlink(missing_ok=True)
                    if prev_lines is None or not lines:
                        continue
                    ov = overlap_ratio(prev_lines, lines)
                    if ov is None:
                        continue
                    score = abs(ov - args.overlap)
                    if best_score is None or score < best_score:
                        best_score, best_t, best_overlap = score, wt, ov
                if best_score is not None:
                    refined.append(best_t)
                else:
                    refined.append(t)
            pages = refined

    # ---- 阶段 3：导出 PNG + 报告 ----
    exported = []
    for i, t in enumerate(pages):
        out_png = out_dir / f'page-{i + 1:03d}.png'
        ok = export_frame(ffmpeg, args.video, t, str(out_png))
        exported.append({'index': i + 1, 'time_sec': round(t, 2), 'exported': ok})

    report = {
        'ok': True,
        'video': args.video,
        'duration_sec': round(duration, 1) if duration else None,
        'overlap_target': args.overlap,
        'tolerance': args.tolerance,
        'verify': verify,
        'pages_count': len(exported),
        'pages': exported,
        'out_dir': str(out_dir),
    }
    (out_dir / 'split-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), 'utf-8')
    print(json.dumps(report, ensure_ascii=False))
    sys.exit(0)

if __name__ == '__main__':
    main()
