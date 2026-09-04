#!/usr/bin/env python3
"""
split_video.py — 录屏智能切页截图

通过 ffmpeg 灰度帧流 + 行均值向量估计滚动位移，在滚动稳定帧处自动切页截图。

算法概要：
1. ffmpeg 逐帧提取灰度数据（format=gray），管道读取
2. 每帧计算行均值向量（每行所有像素的均值 → 1D 信号）
3. 相邻帧通过行均值信号的位移估计滚动距离
4. 抖动过滤：|d| < 12px 归零；同方向连续 ≥2 帧才累计
5. 切页：累计滚动达到屏高的 (1-overlap) 比例时，取滚动停止后的稳定帧
6. 超时兜底：持续滚动超过 1.5 秒未停止，强制切页

用法：
  python3 split_video.py <视频路径> [--out-dir <输出目录>] [--ocr] [--overlap <0.1-0.5>]
"""

import argparse
import json
import os
import subprocess
import sys
import struct
from pathlib import Path

# ── 常量 ──
JITTER_THRESHOLD = 12       # 位移 <12px 视为抖动，归零
MIN_CONSECUTIVE = 2         # 同方向连续 ≥2 帧才累计
SCROLL_TIMEOUT_MS = 1500    # 持续滚动超 1.5s 强制切页
STABLE_FRAME_COUNT = 3      # 连续 3 帧位移 <JITTER_THRESHOLD 视为稳定

# ── ffmpeg/ffprobe 定位（与应用内 resolveFfmpegPath 同策略，按优先级）──
# 1. --ffmpeg 参数（最明确，SKILL.md 文档化）
# 2. FFMPEG_PATH 环境变量（打包版 Electron main 注入 Resources/bin/ffmpeg）
# 3. @ffmpeg-installer/ffmpeg 内置二进制（dev/standalone：node 解析 npm 包）
# 4. PATH 兜底（系统已安装 ffmpeg）
def resolve_ffmpeg():
    candidates = []
    env_path = os.environ.get('FFMPEG_PATH')
    if env_path:
        candidates.append(env_path)
    try:
        out = subprocess.check_output(
            ['node', '-e',
             "try{console.log(require('@ffmpeg-installer/ffmpeg').path)}catch(e){process.exit(1)}"],
            text=True, timeout=10, stderr=subprocess.DEVNULL,
        ).strip()
        if out:
            candidates.append(out)
    except Exception:
        pass
    candidates.append('ffmpeg')
    import shutil
    for c in candidates:
        if not c:
            continue
        if os.path.sep in c:
            if os.path.isfile(c) and os.access(c, os.X_OK):
                return c
        else:
            found = shutil.which(c)
            if found:
                return found
    return None

def resolve_ffprobe():
    """ffprobe 定位：优先与 ffmpeg 同目录（打包版 Resources/bin/），否则 PATH"""
    ffmpeg = resolve_ffmpeg()
    if ffmpeg and os.path.sep in ffmpeg:
        sibling = os.path.join(os.path.dirname(ffmpeg), 'ffprobe')
        if os.path.isfile(sibling) and os.access(sibling, os.X_OK):
            return sibling
    import shutil
    return shutil.which('ffprobe')

_FFMPEG_CACHE = {'path': None, 'override': None}
def get_ffmpeg(override=None):
    """获取可用的 ffmpeg 路径（缓存 + override 支持），不可用则抛出明确错误"""
    if override:
        if os.path.isfile(override) and os.access(override, os.X_OK):
            return override
        raise RuntimeError(f'--ffmpeg 指定的路径无效: {override}')
    if _FFMPEG_CACHE['path'] is None:
        _FFMPEG_CACHE['path'] = resolve_ffmpeg()
    if not _FFMPEG_CACHE['path']:
        raise RuntimeError(
            'ffmpeg 不可用：FFMPEG_PATH 未设置、内置二进制未找到且系统 PATH 无 ffmpeg。'
            '可在应用目录执行 `node -e "console.log(require(\'@ffmpeg-installer/ffmpeg\').path)"` '
            '拿到内置路径后用 --ffmpeg <path> 传入。'
        )
    return _FFMPEG_CACHE['path']

def get_video_info(video_path):
    """获取视频宽高和帧率：ffprobe → ffmpeg -i stderr 解析 → cv2 兜底"""
    import re
    # 1) ffprobe（内置或系统）
    ffprobe = resolve_ffprobe()
    if ffprobe:
        try:
            cmd = [
                ffprobe, '-v', 'quiet',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=width,height,r_frame_rate',
                '-of', 'csv=p=0',
                video_path,
            ]
            out = subprocess.check_output(cmd, text=True, timeout=15).strip()
            parts = out.split(',')
            width = int(parts[0])
            height = int(parts[1])
            num, den = parts[2].split('/')
            fps = float(num) / float(den) if float(den) != 0 else 30.0
            return width, height, fps
        except Exception:
            pass
    # 2) ffmpeg -i stderr 解析（@ffmpeg-installer 只带 ffmpeg 无 ffprobe 时的主要路径）
    try:
        result = subprocess.run(
            [get_ffmpeg(), '-i', video_path],
            capture_output=True, text=True, timeout=15,
        )
        info = result.stderr or result.stdout or ''
        m = re.search(r'Video:.*?(\d{2,5})x(\d{2,5})[^\n]*?([\d.]+)\s*fps', info, re.S)
        if m:
            return int(m.group(1)), int(m.group(2)), float(m.group(3))
    except Exception:
        pass
    # 3) cv2 兜底（机器装有 opencv 时）
    try:
        import cv2
        cap = cv2.VideoCapture(video_path)
        if cap.isOpened():
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            cap.release()
            if width > 0 and height > 0:
                return width, height, fps
    except Exception:
        pass
    raise RuntimeError('无法获取视频宽高/帧率：ffprobe、ffmpeg -i 解析、cv2 均不可用')

def extract_grayscale_frames(video_path, width, height, ffmpeg=None):
    """用 ffmpeg 管道输出灰度帧（每帧 width*height 字节）"""
    cmd = [
        get_ffmpeg(ffmpeg), '-i', video_path,
        '-f', 'rawvideo',
        '-pix_fmt', 'gray',
        '-v', 'quiet',
        '-',
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    frame_size = width * height
    try:
        while True:
            raw = proc.stdout.read(frame_size)
            if len(raw) < frame_size:
                break
            yield raw
    finally:
        proc.terminate()
        proc.wait()

def compute_row_means(raw_frame, width, height):
    """计算行均值向量（每行所有像素的均值 → 长度 height 的 float 数组）"""
    row_means = [0.0] * height
    for y in range(height):
        offset = y * width
        row_sum = sum(raw_frame[offset:offset + width])
        row_means[y] = row_sum / width
    return row_means

def estimate_scroll(prev_means, curr_means, height):
    """估计两帧之间的滚动位移（正=向下滚动）"""
    best_d = 0
    best_score = float('inf')
    # 搜索范围：±height 的 80%
    max_d = int(height * 0.8)
    for d in range(1, max_d + 1):
        # 向下滚动 d：curr 的 [d:] 对应 prev 的 [:height-d]
        overlap = height - d
        if overlap < 10:
            break
        diff = 0.0
        for i in range(overlap):
            diff += abs(curr_means[d + i] - prev_means[i])
        score = diff / overlap
        if score < best_score:
            best_score = score
            best_d = d
    # 也检查向上滚动
    for d in range(1, max_d + 1):
        overlap = height - d
        if overlap < 10:
            break
        diff = 0.0
        for i in range(overlap):
            diff += abs(curr_means[i] - prev_means[d + i])
        score = diff / overlap
        if score < best_score:
            best_score = score
            best_d = -d
    return best_d if best_score < 30 else 0

def estimate_scroll_fast(prev_means, curr_means, height):
    """快速版：用 numpy 加速（如果可用），否则回退到纯 Python"""
    try:
        import numpy as np
        prev = np.array(prev_means, dtype=np.float32)
        curr = np.array(curr_means, dtype=np.float32)
        max_d = int(height * 0.8)
        best_d = 0
        best_score = float('inf')
        for d in range(1, max_d + 1):
            overlap = height - d
            if overlap < 10:
                break
            # 向下滚动
            score_down = np.mean(np.abs(curr[d:] - prev[:overlap]))
            if score_down < best_score:
                best_score = score_down
                best_d = d
            # 向上滚动
            score_up = np.mean(np.abs(curr[:overlap] - prev[d:]))
            if score_up < best_score:
                best_score = score_up
                best_d = -d
        return best_d if best_score < 30 else 0
    except ImportError:
        return estimate_scroll(prev_means, curr_means, height)

def extract_frame_png(video_path, timestamp, out_path, ffmpeg=None):
    """从视频中提取指定时间点的 PNG 截图"""
    cmd = [
        get_ffmpeg(ffmpeg), '-ss', str(timestamp),
        '-i', video_path,
        '-frames:v', '1',
        '-f', 'image2',
        '-y', '-v', 'quiet',
        out_path,
    ]
    subprocess.run(cmd, check=True)

def run_ocr(image_path):
    """用 macOS Vision 框架做本地文字识别"""
    script = f'''
    import Cocoa
    import Vision
    from Foundation import NSURL

    image_url = NSURL.fileURLWithPath_("{image_path}")
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLanguages_(["zh-Hans", "en"])
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)

    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(image_url, None)
    success = handler.performRequests_error_([request], None)

    results = request.results()
    texts = []
    if results:
        for obs in results:
            candidate = obs.topCandidates_(1)
            if candidate:
                texts.append(candidate[0].string())
    print("\\n".join(texts))
    '''
    try:
        out = subprocess.check_output(
            ['/usr/bin/python3', '-c', script],
            text=True, timeout=30,
        )
        return out.strip()
    except Exception as e:
        return f'[OCR Error: {e}]'

def main():
    parser = argparse.ArgumentParser(description='录屏智能切页截图')
    parser.add_argument('video', help='视频文件路径')
    parser.add_argument('--out-dir', default='', help='输出目录（默认视频同目录下 frames/）')
    parser.add_argument('--ocr', action='store_true', help='启用本地 Vision 文字识别')
    parser.add_argument('--overlap', type=float, default=0.1, help='相邻页重叠比例（0.1-0.5，默认 0.1）')
    parser.add_argument('--ffmpeg', default='', help='指定 ffmpeg 可执行文件路径（默认自动定位内置二进制）')
    args = parser.parse_args()

    video_path = args.video
    if not os.path.isfile(video_path):
        print(json.dumps({'error': f'视频文件不存在: {video_path}'}, ensure_ascii=False))
        sys.exit(1)

    ffmpeg = args.ffmpeg or None
    # 尽早预检 ffmpeg 可用性，给出明确错误而非半途失败
    try:
        get_ffmpeg(ffmpeg)
    except RuntimeError as e:
        print(json.dumps({'error': str(e)}, ensure_ascii=False))
        sys.exit(1)

    overlap = max(0.1, min(0.5, args.overlap))
    scroll_threshold_ratio = 1.0 - overlap  # 滚动到屏高的 (1-overlap) 比例时切页

    # 输出目录
    video_dir = os.path.dirname(os.path.abspath(video_path))
    video_stem = Path(video_path).stem
    out_dir = args.out_dir if args.out_dir else os.path.join(video_dir, f'{video_stem}_frames')
    os.makedirs(out_dir, exist_ok=True)

    # 获取视频信息
    width, height, fps = get_video_info(video_path)
    scroll_threshold = int(height * scroll_threshold_ratio)
    frame_interval_ms = 1000.0 / fps if fps > 0 else 33.33

    print(f'[info] 视频: {width}x{height} @ {fps:.1f}fps')
    print(f'[info] 切页阈值: 滚动 {scroll_threshold}px (屏高 {height} 的 {scroll_threshold_ratio*100:.0f}%)')
    print(f'[info] 输出目录: {out_dir}')

    # ── 逐帧处理 ──
    pages = []
    page_num = 0
    cumulative_scroll = 0
    prev_means = None
    prev_d = 0
    consecutive_count = 0
    scroll_start_ms = 0
    stable_count = 0
    last_cut_frame = 0
    frame_idx = 0

    for raw_frame in extract_grayscale_frames(video_path, width, height):
        curr_means = compute_row_means(raw_frame, width, height)

        if prev_means is not None:
            d = estimate_scroll_fast(prev_means, curr_means, height)

            # 抖动过滤
            if abs(d) < JITTER_THRESHOLD:
                d = 0

            # 同方向连续性检测
            if d != 0 and prev_d != 0 and ((d > 0) == (prev_d > 0)):
                consecutive_count += 1
            else:
                consecutive_count = 1 if d != 0 else 0

            # 只有连续 ≥2 帧同方向才累计
            if d != 0 and consecutive_count >= MIN_CONSECUTIVE:
                cumulative_scroll += d
                if scroll_start_ms == 0:
                    scroll_start_ms = frame_idx * frame_interval_ms
                stable_count = 0
            elif d == 0:
                stable_count += 1

            prev_d = d

            # 检查切页条件
            current_ms = frame_idx * frame_interval_ms
            should_cut = False

            # 条件 1：累计滚动达到阈值，且当前帧稳定
            if abs(cumulative_scroll) >= scroll_threshold and stable_count >= STABLE_FRAME_COUNT:
                should_cut = True

            # 条件 2：持续滚动超时
            if scroll_start_ms > 0 and (current_ms - scroll_start_ms) > SCROLL_TIMEOUT_MS:
                should_cut = True

            if should_cut and (frame_idx - last_cut_frame) > 5:
                page_num += 1
                timestamp = frame_idx / fps if fps > 0 else 0
                page_png = os.path.join(out_dir, f'page_{page_num:03d}.png')
                extract_frame_png(video_path, timestamp, page_png, ffmpeg)

                page_info = {
                    'page': page_num,
                    'frame': frame_idx,
                    'timestamp': round(timestamp, 3),
                    'cumulative_scroll': cumulative_scroll,
                    'image': page_png,
                }

                if args.ocr:
                    page_info['text'] = run_ocr(page_png)
                    txt_path = os.path.join(out_dir, f'page_{page_num:03d}.txt')
                    with open(txt_path, 'w', encoding='utf-8') as f:
                        f.write(page_info['text'])

                pages.append(page_info)
                cumulative_scroll = 0
                scroll_start_ms = 0
                stable_count = 0
                last_cut_frame = frame_idx
                print(f'[page {page_num}] frame={frame_idx} t={timestamp:.2f}s')

        prev_means = curr_means
        frame_idx += 1

    # ── 确保至少有第一帧 ──
    if page_num == 0:
        page_num += 1
        timestamp = 0.0
        page_png = os.path.join(out_dir, f'page_{page_num:03d}.png')
        extract_frame_png(video_path, timestamp, page_png)
        page_info = {
            'page': page_num,
            'frame': 0,
            'timestamp': 0.0,
            'cumulative_scroll': 0,
            'image': page_png,
        }
        if args.ocr:
            page_info['text'] = run_ocr(page_png)
            txt_path = os.path.join(out_dir, f'page_{page_num:03d}.txt')
            with open(txt_path, 'w', encoding='utf-8') as f:
                f.write(page_info['text'])
        pages.append(page_info)
        print(f'[page {page_num}] frame=0 t=0.00s (fallback)')

    # ── 输出 result.json ──
    result = {
        'video': video_path,
        'width': width,
        'height': height,
        'fps': round(fps, 2),
        'overlap': overlap,
        'total_pages': page_num,
        'pages': pages,
    }
    result_path = os.path.join(out_dir, 'result.json')
    with open(result_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f'\n[done] 共 {page_num} 页，输出到 {out_dir}')
    print(json.dumps({'success': True, 'total_pages': page_num, 'out_dir': out_dir, 'pages': pages}, ensure_ascii=False))

if __name__ == '__main__':
    main()
