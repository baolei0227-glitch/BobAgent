import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  allowedDevOrigins: ['*.dev.coze.site'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*',
        pathname: '/**',
      },
    ],
  },
  // '@larksuiteoapi/node-sdk' 与 'ws'：飞书桥在 Node 端长连接收发事件，
  // 保持运行时 require（不打进 bundle），由 Next 文件追踪拷入 standalone。
  serverExternalPackages: ['better-sqlite3', '@modelcontextprotocol/sdk', '@larksuiteoapi/node-sdk', 'ws'],
  // 常驻标点服务 / 声纹提取的 C 源码不是 import 出来的（运行时用 clang 现场编译），
  // 这里追踪进来是为了「就地跑 .next/standalone」时也能找到它（源码候选 2）。
  // 注意：追踪落点在 src/ 树下，而 package-release.sh 收尾会整棵删掉 next-standalone/src，
  // 所以**打包版不能只靠这里** —— 真正随包分发由该脚本显式复制到 next-standalone/scripts/（候选 1）。
  outputFileTracingIncludes: {
    '/api/stt/punctuate': ['./src/lib/stt/native/**/*'],
    '/api/butler/meeting': ['./src/lib/stt/native/**/*'],
  },
  outputFileTracingExcludes: {
    '*': [
      '.git/**',
      '.next 3/**',
      '.next-list-test/**',
      'release-dist/**',
      'test-results/**',
      'e2e/**',
      'node_modules/typescript/**',
      'node_modules/.pnpm/typescript@*/**',
      'node_modules/@img/sharp*/**',
      'node_modules/.pnpm/@img+sharp*/**',
      'node_modules/sharp/**',
      'node_modules/.pnpm/sharp@*/**',
    ],
  },
  // 显式指定 Turbopack 项目根目录为 projects（父目录存在 package-lock.json 时
  // Turbopack 会误把 workspace root 推断为上一级，导致 dev 下 HMR 报
  // 'Resource path "src/app/layout.tsx" need to be on project filesystem "projects"'）
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
