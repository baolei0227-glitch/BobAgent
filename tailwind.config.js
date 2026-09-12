/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
      },
      /* UI 微字号刻度（刻度收敛）：此前 UI 层直写 text-[10px]/[11px] 等 arbitrary px，
         绕开了 html{font-size:var(--fs-md)} 的 rem 缩放基线，data-fontscale 切档时不跟随。
         以下按 M 档基线 15px 换算为 rem（px/15），渲染值不变，但全站字号缩放恢复一致。
         命名即像素（text-10 = 10px@M），避免再写 arbitrary。 */
      fontSize: {
        '7': '0.466667rem',
        '8': '0.533333rem',
        '9': '0.6rem',
        '9.5': '0.633333rem',
        '10': '0.666667rem',
        '10.5': '0.7rem',
        '11': '0.733333rem',
        '11.5': '0.766667rem',
        '12': '0.8rem',
        '12.5': '0.833333rem',
        '13': '0.866667rem',
        '13.5': '0.9rem',
        '14': '0.933333rem',
        '15': '1rem',
        '17': '1.133333rem',
        '31': '2.066667rem',
      },
      /* 圆角刻度（刻度收敛）：px 锤定，与 --radius-* 同源同值。
         覆盖 tailwind 默认 rem 圆角，使其不随 html 字号缩放（圆角不应跟随字号档位）。
         数值即常规 web 曲率：rounded-sm 2 / DEFAULT 4 / md 6 / lg 8 / xl 12 / 2xl 16。 */
      borderRadius: {
        DEFAULT: '4px',
        sm: '2px',
        md: '6px',
        lg: '8px',
        xl: '12px',
        '2xl': '16px',
        '3xl': '24px',
        full: '9999px',
      },
      /* 阴影刻度（token 消费）：tailwind shadow-* 类映射到 --shadow-* 六档 token。
         此前组件用 tailwind 默认值，--shadow 系列（更柔的多层 soft shadow）闲置。
         2xl 与 xl 同档（token 最深为 xl），shadow-xs 为新增语义（此前无此类）。 */
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        '2xl': 'var(--shadow-xl)',
      },
    },
  },
  plugins: [],
};