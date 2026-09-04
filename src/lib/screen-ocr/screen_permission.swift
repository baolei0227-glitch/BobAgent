// 屏幕录制权限：检测 + 主动请求（macOS 10.15+）——无副作用，不截图
//
// 用法: screen_permission check | request
//   check   仅查询状态（CGPreflightScreenCaptureAccess，不弹窗、不截图）
//   request 未授权时触发系统标准授权弹窗（CGRequestScreenCaptureAccess，
//           与 screencapture 同属「屏幕录制」TCC 服务，归因当前应用的责任进程），
//           等待用户响应后输出最终状态。新授权对「全新启动的子进程」通常即时生效
//           （screencapture 每次都是新进程）；个别系统版本仍要求完全重启应用，由调用方引导。
// 输出: screen=1|0    退出码: 0（输出即状态；超时由调用方控制）
import CoreGraphics
import Foundation

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "check"
if mode == "request" {
    // 主动请求：与 screencapture 同一 TCC 服务；已决（授权/拒绝）时立即返回不弹窗
    _ = CGRequestScreenCaptureAccess()
}
print(CGPreflightScreenCaptureAccess() ? "screen=1" : "screen=0")
