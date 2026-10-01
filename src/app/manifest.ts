import type { MetadataRoute } from 'next';

/**
 * PWA 清单：让 BobWork Web UI 能被 iPhone Safari「添加到主屏幕」后以独立 App 形态启动
 * （standalone、无浏览器地址栏），用于「本地算力 + 私有隧道」的远程访问形态。
 * Next 会自动把本文件发布到 /manifest.webmanifest。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'BobWork',
    short_name: 'BobWork',
    description: 'BobWork AI Canvas 与 Butler 助理的移动端入口',
    // 移动端只给 Butler：主屏幕启动 / 登录成功都落到 /butler 单栏页，
    // 而不是桌面工作台（/ 在手机上只剩一个空画布）
    start_url: '/butler',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f7f7f8',
    theme_color: '#6a5acd',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // 河马造型接近满幅，maskable 会被圆形裁掉鼻子/尾巴，这里用留了安全区的专用图
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}