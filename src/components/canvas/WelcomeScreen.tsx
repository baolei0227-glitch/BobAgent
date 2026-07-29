'use client';

import { useState } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';

interface WelcomeScreenProps {
  onCreateProject: (name: string) => Promise<void>;
}

export function WelcomeScreen({ onCreateProject }: WelcomeScreenProps) {
  const [projectName, setProjectName] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    const name = projectName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await onCreateProject(name);
    } catch (err) {
      console.error('创建项目失败:', err);
      alert('Failed to create project, please try again');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="flex h-screen w-screen items-center justify-center"
      style={{
        background: 'linear-gradient(135deg, oklch(0.96 0.01 80) 0%, oklch(0.94 0.015 65) 100%)',
      }}
    >
      <div className="w-full max-w-md px-6">
        {/* Logo */}
        <div className="mb-8 flex justify-center">
          <img
            src="/bobagent-logo.png"
            alt="BobAgent"
            className="h-16 w-16 rounded-2xl object-contain shadow-lg"
          />
        </div>

        {/* 标题 */}
        <h1
          className="mb-2 text-center text-2xl font-medium"
          style={{
            color: 'oklch(0.35 0.02 50)',
            fontFamily: "'Noto Serif SC', serif",
          }}
        >
          Welcome to BobAgent
        </h1>
        <p
          className="mb-10 text-center text-sm"
          style={{
            color: 'oklch(0.55 0.02 55)',
            fontFamily: "'Noto Serif SC', serif",
          }}
        >
          Build your knowledge network with AI-powered nodes on an infinite canvas
        </p>

        {/* 创建项目卡片 */}
        <div
          className="rounded-2xl p-6 shadow-xl"
          style={{
            backgroundColor: 'oklch(0.98 0.01 80 / 0.9)',
            border: '1px solid oklch(0.82 0.025 65 / 0.4)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-4 w-4" style={{ color: 'oklch(0.65 0.17 45)' }} />
            <span
              className="text-sm font-medium"
              style={{
                color: 'oklch(0.40 0.02 50)',
                fontFamily: "'Noto Serif SC', serif",
              }}
            >
              Create Your First Project
            </span>
          </div>

          <input
            type="text"
            autoFocus
            placeholder="Enter project name, e.g., Research Notes, Product Design..."
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !creating && projectName.trim()) {
                handleCreate();
              }
            }}
            disabled={creating}
            className="w-full rounded-lg border px-4 py-3 text-sm outline-none transition-colors focus:border-amber-400"
            style={{
              backgroundColor: 'oklch(1 0 0 / 0.7)',
              borderColor: 'oklch(0.82 0.025 65 / 0.5)',
              color: 'oklch(0.40 0.02 50)',
              fontFamily: "'Noto Serif SC', serif",
            }}
          />

          <button
            onClick={handleCreate}
            disabled={creating || !projectName.trim()}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg py-3 text-sm font-medium transition-all disabled:opacity-50 hover:shadow-md"
            style={{
              background: 'linear-gradient(135deg, oklch(0.72 0.18 50), oklch(0.62 0.17 45))',
              color: 'white',
              fontFamily: "'Noto Serif SC', serif",
            }}
          >
            {creating ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-r-transparent" />
            ) : (
              <>
                <span>Create Project</span>
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>
        </div>

        {/* 底部提示 */}
        <p
          className="mt-6 text-center text-xs"
          style={{
            color: 'oklch(0.55 0.02 55 / 0.7)',
            fontFamily: "'Noto Serif SC', serif",
          }}
        >
          Project data is stored under ~/BobAgent/
        </p>
      </div>
    </div>
  );
}
