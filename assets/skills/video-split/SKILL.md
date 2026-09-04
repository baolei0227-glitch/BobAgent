---
name: video-split
description: 微信录屏智能切页截图。通过 ffmpeg 灰度帧流 + 行均值向量估计滚动位移，在滚动稳定帧处自动切页截图。用于将长录屏视频自动拆分为逐页图片，支持 --ocr 本地文字识别。触发场景：用户提到"录屏切页"、"视频截图"、"屏幕录制分段"、"滚动截图"等。
version: 1.0.0
scenes: video
---

# video-split — 录屏智能切页截图

## 用途

将屏幕录制视频（如微信聊天记录、文档滚动录屏）自动拆分为逐页截图，每个截页对应一次滚动停止后的稳定画面。

## 环境要求

**ffmpeg 自动定位，无需系统安装**（与应用内视频识别同策略，按优先级）：
1. `--ffmpeg` 参数（最明确，可手动指定任意路径）
2. `FFMPEG_PATH` 环境变量（打包版 Electron main 注入 `Resources/bin/ffmpeg`）
3. `@ffmpeg-installer/ffmpeg` 内置二进制（dev/standalone，脚本自动用 node 解析 npm 包）
4. PATH 兜底（系统已安装 ffmpeg）

ffprobe 缺失时自动降级：先解析 `ffmpeg -i` 输出，再回退 OpenCV（`cv2.VideoCapture`）。

> 若自动定位全部失败（报错信息会给出提示），用 run_command 在应用目录执行
> `node -e "console.log(require('@ffmpeg-installer/ffmpeg').path)"` 拿到内置路径，再以 `--ffmpeg <path>` 传入。

## 核心脚本

### `scripts/split_video.py`

```bash
python3 split_video.py <视频路径> [--out-dir <输出目录>] [--ocr] [--overlap <0.1-0.5>] [--ffmpeg <路径>]
```

**参数说明：**
- `<视频路径>`：输入视频文件路径（mp4/mov 等 ffmpeg 支持的格式）
- `--out-dir`：输出目录，默认在视频同目录下创建 `frames/` 子目录
- `--ocr`：启用本地 Vision 文字识别（需 macOS Vision 框架）
- `--overlap`：相邻页重叠比例，默认 0.1（即 10% 重叠），范围 0.1–0.5
- `--ffmpeg`：手动指定 ffmpeg 可执行文件路径（默认按上方策略自动定位）

**切页算法：**
1. ffmpeg 逐帧提取灰度图，计算每帧的行均值向量
2. 相邻帧通过行均值向量的位移估计滚动距离（亚像素级）
3. 抖动过滤：位移 <12px 归零；同方向连续 ≥2 帧才累计
4. 切页条件：累计滚动达到屏高的 90%（对应 10% 重叠）时，取滚动停止后的稳定帧
5. 超时兜底：持续滚动超过 1.5 秒未停止，强制切页

**输出：**
- `page_001.png`, `page_002.png`, ... — 逐页截图
- `result.json` — 切页元数据（每页的时间戳、滚动位移等）
- 若启用 `--ocr`，额外输出 `page_001.txt`, `page_002.txt`, ... — 每页识别文本

## 使用示例

```bash
# 基本切页
python3 scripts/split_video.py ~/Desktop/recording.mp4

# 指定输出目录 + OCR
python3 scripts/split_video.py ~/Desktop/recording.mp4 --out-dir ~/Desktop/pages --ocr

# 调整重叠率（20%）
python3 scripts/split_video.py ~/Desktop/recording.mp4 --overlap 0.2
```
