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
  serverExternalPackages: ['better-sqlite3', '@modelcontextprotocol/sdk'],
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
