'use client';

/**
 * components/canvas/ToggleSwitch.tsx — 极简开关（启用/停用）
 *
 * 主题 token 驱动：开 = 品牌主色，关 = 中性灰；纯展示 + onChange，无样式副作用。
 * 用于 Skills / MCP Installed 卡片的启用开关，替代「✓ Enabled」文字按钮。
 */

interface ToggleSwitchProps {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  title?: string;
}

export function ToggleSwitch({ checked, disabled = false, onChange, title }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      title={title}
      className="relative shrink-0 cursor-pointer rounded-full outline-none transition-opacity disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2"
      style={{
        width: 34,
        height: 18,
        backgroundColor: checked ? 'var(--primary)' : 'color-mix(in oklab, var(--ink-muted) 28%, transparent)',
        transition: 'background-color 0.15s ease',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: 0,
          width: 14,
          height: 14,
          borderRadius: 999,
          backgroundColor: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
          transform: checked ? 'translateX(18px)' : 'translateX(2px)',
          transition: 'transform 0.15s ease',
        }}
      />
    </button>
  );
}
