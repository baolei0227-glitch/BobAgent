#!/usr/bin/env swift
// 本地 OCR：macOS Vision 框架逐张识别图片中的文字（零成本、无网络、无需 API Key）
//
// 用法: swift ocr_vision.swift <img1> [img2] ...   （也可使用 swiftc -O 编译后的二进制）
// 输出: {"pages":[{"index":1,"text":"...", "blocks":[...]}, ...]}  （index 从 1 开始，text 为空表示该页未识别到文字）
//
// 说明：仅识别文字（VNRecognizeTextRequest），适用于扫描件 PDF 页面图片；
// 不解析图表/版式语义——需要语义理解时仍回退到视觉大模型。
//
// 方向自适应（v2）：
//   部分扫描件是"横版表格竖扫"（表格被旋转 90°），Vision 直接识别时 bbox 行列错位
//   （表头纵向排列、数据列横向排列），导致下游按 bbox 聚行/勾稽全部失效。
//   处理：OCR 后检测表头关键词块（序号/摘要/日期/金额/余额等）是否纵向排列；
//   若判定旋转，则转置所有块的 bbox 坐标（new_x = 1-(y+h), new_y = x, new_w = h, new_h = w），
//   并按转置后的阅读顺序重排文本。转置只改坐标语义，不改像素，保真零重采样。

import Foundation
import Vision
import AppKit

let imagePaths = Array(CommandLine.arguments.dropFirst())
var pages: [[String: Any]] = []

/// 单个文字块（归一化 bbox，Vision 坐标系：原点左下、x 向右、y 向上）
struct RawBlock {
    var text: String
    var confidence: Double
    var x: Double
    var y: Double
    var w: Double
    var h: Double
}

/// 读取图片像素（缩小到最长边 maxSide 内，表格线是贯穿性长线，低分辨率不受影响），返回 RGBA 数组
func rgbaPixels(_ cg: CGImage, maxSide: Int) -> (data: [UInt8], w: Int, h: Int)? {
    let scale = min(1.0, Double(maxSide) / Double(max(cg.width, cg.height)))
    let w = max(1, Int(Double(cg.width) * scale))
    let h = max(1, Int(Double(cg.height) * scale))
    var data = [UInt8](repeating: 0, count: w * h * 4)
    guard let ctx = CGContext(
        data: &data, width: w, height: h, bitsPerComponent: 8,
        bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    return (data, w, h)
}

/// 检测贯穿性横/竖线（表格框线特征）：长度 ≥ 1/4 页面边长 且 连续深色
func detectTableLines(rgba: [UInt8], w: Int, h: Int) -> (hLines: Int, vLines: Int) {
    let step = 2
    let minHLine = w / 4
    let minVLine = h / 4
    var hLines = 0
    var vLines = 0

    func isDark(_ i: Int) -> Bool {
        let r = Int(rgba[i]); let g = Int(rgba[i + 1]); let b = Int(rgba[i + 2])
        return (r + g + b) / 3 < 128
    }

    for y in stride(from: 0, to: h, by: step) {
        var run = 0, maxRun = 0
        for x in stride(from: 0, to: w, by: step) {
            if isDark((y * w + x) * 4) { run += 1 } else { maxRun = max(maxRun, run); run = 0 }
        }
        if max(maxRun, run) * step >= minHLine { hLines += 1 }
    }
    for x in stride(from: 0, to: w, by: step) {
        var run = 0, maxRun = 0
        for y in stride(from: 0, to: h, by: step) {
            if isDark((y * w + x) * 4) { run += 1 } else { maxRun = max(maxRun, run); run = 0 }
        }
        if max(maxRun, run) * step >= minVLine { vLines += 1 }
    }
    return (hLines, vLines)
}

/// 方向检测：表头关键词块（序号/摘要/日期/金额/余额等，块高 > 0.02）若纵向排列
/// （y 跨度 > x 跨度 × 2）→ 表格被旋转 90°（横表竖扫），需转置 bbox 恢复行列结构。
func detectRotation(_ blocks: [RawBlock]) -> Bool {
    let headerKws = ["序号", "摘要", "日期", "金额", "余额", "户名", "币别", "账号", "标志", "商户", "操作员"]
    let headers = blocks.filter { b in
        guard b.h > 0.02 else { return false }
        return headerKws.contains { b.text.contains($0) }
    }
    // 至少 3 个表头块才可信，避免纯文字页误触发
    guard headers.count >= 3 else { return false }
    let xs = headers.map { $0.x + $0.w / 2 }
    let ys = headers.map { $0.y + $0.h / 2 }
    let xSpan = (xs.max() ?? 0) - (xs.min() ?? 0)
    let ySpan = (ys.max() ?? 0) - (ys.min() ?? 0)
    // 正常横表：表头横向排列（x 跨度大、y 跨度小）；旋转表：表头纵向排列（y 跨度大）
    return ySpan > xSpan * 2
}

/// 转置 bbox（表格顺时针旋转 90° 扫描）：new_x = 1-(y+h), new_y = x, new_w = h, new_h = w
/// 使旋转后的"数据列"恢复为"表格行"、旋转后的"表头行"恢复为"表头列"。
func transposeBlock(_ b: RawBlock) -> RawBlock {
    RawBlock(text: b.text, confidence: b.confidence, x: 1 - (b.y + b.h), y: b.x, w: b.h, h: b.w)
}

/// 180° 颠倒检测：表头关键词块若聚集在页面下半部（Vision 原点左下，midY < 0.5），
/// 说明整页被上下颠倒扫描（扫描仪放反/元数据 rotation 与实物不符的典型形态）。
/// 此时文字本身可识别，但 bbox 位置镜像、阅读顺序倒置，需整体翻转恢复。
func detectFlipped(_ blocks: [RawBlock]) -> Bool {
    let headerKws = ["序号", "摘要", "日期", "金额", "余额", "户名", "币别", "账号", "标志", "商户", "操作员"]
    let headers = blocks.filter { b in
        guard b.h > 0.02 else { return false }
        return headerKws.contains { b.text.contains($0) }
    }
    // 至少 3 个表头块才可信，避免纯文字页误触发
    guard headers.count >= 3 else { return false }
    let avgMidY = headers.map { $0.y + $0.h / 2 }.reduce(0, +) / Double(headers.count)
    return avgMidY < 0.5
}

/// 翻转 bbox（180° 颠倒）：new_x = 1-(x+w), new_y = 1-(y+h)，宽高不变。
/// 翻转后按阅读顺序重排即恢复自上而下、自左而右的表格结构。
func flipBlock(_ b: RawBlock) -> RawBlock {
    RawBlock(text: b.text, confidence: b.confidence, x: 1 - (b.x + b.w), y: 1 - (b.y + b.h), w: b.w, h: b.h)
}

/// 按阅读顺序排序（转置后表格坐标）：
/// 先按 midY 精确排序（阈值比较做排序器违反严格弱序会乱序，必须先精确排），
/// 再聚类为行（相邻 midY 差 ≤ 0.02 视为同一行），行内按 x 从左到右。
func sortedByReadingOrder(_ blocks: [RawBlock]) -> [RawBlock] {
    let byY = blocks.sorted { ($0.y + $0.h / 2) > ($1.y + $1.h / 2) }
    var rows: [[RawBlock]] = []
    for b in byY {
        let midY = b.y + b.h / 2
        if var last = rows.last, let first = last.first {
            let lastMidY = first.y + first.h / 2
            if abs(midY - lastMidY) <= 0.02 {
                last.append(b)
                rows[rows.count - 1] = last
            } else {
                rows.append([b])
            }
        } else {
            rows.append([b])
        }
    }
    return rows.flatMap { $0.sorted { $0.x < $1.x } }
}

/// 近似页面 skew（°）：取每行首末 2 个文本块的 (midX, midY) 做线性拟合，计算斜率对应的角度。
/// 经验上扫描仪倾斜一般 ±3° 以内；Vision 的 VNRecognizeTextRequest 不做去倾斜，但 bbox 给出的中心位置能
/// 足够好地反映「整行是否在同一水平线上」，因此可用来估计角度。
/// 无法估计（行数太少）时返回 nil。
func estimateSkewAngleDeg(_ blocks: [RawBlock]) -> Double? {
    // 先聚类成行（同 sortedByReadingOrder 的算法）
    let byY = blocks.sorted { ($0.y + $0.h / 2) > ($1.y + $1.h / 2) }
    var rows: [[RawBlock]] = []
    for b in byY {
        let midY = b.y + b.h / 2
        if var last = rows.last, let first = last.first {
            let lastMidY = first.y + first.h / 2
            if abs(midY - lastMidY) <= 0.02 {
                last.append(b)
                rows[rows.count - 1] = last
            } else {
                rows.append([b])
            }
        } else {
            rows.append([b])
        }
    }
    // 每行取 4 个代表点：该行最小 x 块、x 四分位数 0.25 / 0.5 / 0.75 最大 x 块的中心点
    struct Pt { let x: Double; let y: Double }
    var pts: [Pt] = []
    for row in rows {
        if row.count < 2 { continue }
        let sorted = row.sorted { $0.x < $1.x }
        func pick(_ q: Double) -> RawBlock {
            let idx = min(sorted.count - 1, max(0, Int(Double(sorted.count - 1) * q)))
            return sorted[idx]
        }
        for q in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let b = pick(q)
            pts.append(Pt(x: b.x + b.w / 2, y: b.y + b.h / 2))
        }
    }
    if pts.count < 10 { return nil }
    // 线性拟合 slope：y = a + b*x，返回角度 atan(b)（度）
    let n = Double(pts.count)
    let sumX = pts.reduce(0.0) { $0 + $1.x }
    let sumY = pts.reduce(0.0) { $0 + $1.y }
    let sumXY = pts.reduce(0.0) { $0 + $1.x * $1.y }
    let sumXX = pts.reduce(0.0) { $0 + $1.x * $1.x }
    let denom = n * sumXX - sumX * sumX
    guard abs(denom) > 1e-9 else { return nil }
    let slope = (n * sumXY - sumX * sumY) / denom
    // slope 为 y 对 x 的导数（Vision 归一化坐标）；真实角度（°）≈ atan(slope) * 180 / π
    // 注意 Vision 坐标归一化 x/y 都是 0..1 方形，aspect 比不影响角度估计（因为 slope 无量纲）。
    return atan(slope) * 180.0 / Double.pi
}

for (i, path) in imagePaths.enumerated() {
    var text = ""
    var blocks: [[String: Any]] = [] // 每个文字块：text + 归一化 bbox（原点左下）
    var imgWidth = 0
    var imgHeight = 0
    var hLines = 0
    var vLines = 0
    var rotated = false
    var flipped = false
    var orientation: Int = 0     // 0 / 90 / 180 / 270（顺时针）
    var skewAngle: Double? = nil
    var tableLineInterference: Double = 0.0
    if let img = NSImage(contentsOfFile: path),
       let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
        imgWidth = cg.width
        imgHeight = cg.height
        // 表格线检测（贯穿性横/竖线）：纯像素统计，用于版式复杂度判定
        if let px = rgbaPixels(cg, maxSide: 800) {
            let lines = detectTableLines(rgba: px.data, w: px.w, h: px.h)
            hLines = lines.hLines
            vLines = lines.vLines
            // tableLineInterference（0..1）：横+竖线越多，越可能表格线贯穿压字；超过阈值就归一化
            let total = Double(hLines + vLines)
            // 经验：纯无框文本 ≈ 0-2；虚线框表 ≈ 10-30；密集实线发票框 ≈ 80+；映射到 0..1：total/(total+30)
            tableLineInterference = max(0.0, min(1.0, total / (total + 30.0)))
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = true
        request.minimumTextHeight = 0.01

        let handler = VNImageRequestHandler(cgImage: cg, options: [:])
        do {
            try handler.perform([request])
            let observations = request.results ?? []
            // 收集原始块（保留 Vision 原始 bbox，用于方向检测）
            var raw: [RawBlock] = []
            for obs in observations {
                guard let cand = obs.topCandidates(1).first else { continue }
                let b = obs.boundingBox
                raw.append(RawBlock(text: cand.string, confidence: Double(cand.confidence),
                                    x: Double(b.minX), y: Double(b.minY), w: Double(b.width), h: Double(b.height)))
            }
            // 方向检测 + 转置（横表竖扫的旋转页恢复行列结构）
            rotated = detectRotation(raw)
            if rotated {
                raw = raw.map(transposeBlock)
                // 旋转后真实表格的横线 = 检测的竖线，竖线 = 检测的横线
                swap(&hLines, &vLines)
                orientation = 270 // Vision 顺时针旋转 270° 等价于图像顺时针 90° 旋转扫描（横表竖扫的典型）
                // 重新计算 interference（因为 hLines/vLines 已 swap）
                let total = Double(hLines + vLines)
                tableLineInterference = max(0.0, min(1.0, total / (total + 30.0)))
            }
            // 180° 颠倒检测：表头关键词聚集在页面下半部 → 整体翻转 bbox 恢复阅读顺序
            // （在 90° 转置之后执行，二者叠加时先转置后翻转）
            flipped = detectFlipped(raw)
            if flipped {
                raw = raw.map(flipBlock)
                orientation = (orientation + 180) % 360
            }
            // Skew 估计：在 OCR 后（已转置/翻转后的坐标）做，保证拟合出来的是"纸面真实倾斜角"
            skewAngle = estimateSkewAngleDeg(raw)
            // 按转置后的阅读顺序重排，并拼接文本
            let ordered = sortedByReadingOrder(raw)
            text = ordered.map { $0.text }.joined(separator: "\n")
            blocks = ordered.map {
                ["text": $0.text, "confidence": $0.confidence, "x": $0.x, "y": $0.y, "w": $0.w, "h": $0.h]
            }
        } catch {
            // 单页识别失败置空，由上层决定是否回退
        }
    }
    pages.append([
        "index": i + 1,
        "text": text,
        "blocks": blocks,
        "width": imgWidth,
        "height": imgHeight,
        "rotated": rotated,
        "flipped": flipped,
        "orientation": orientation,
        "skewAngle": (skewAngle ?? NSNull()) as Any,
        "tableLineInterference": tableLineInterference,
        "layout": [
            "hLines": hLines,
            "vLines": vLines,
            "hasTableLines": hLines >= 2 && vLines >= 2,
        ],
    ])
}

let payload: [String: Any] = ["pages": pages]
if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.withoutEscapingSlashes]) {
    FileHandle.standardOutput.write(data)
}
