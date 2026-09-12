'use client';

import { useState } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';

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
      className="flex h-screen w-screen items-center justify-center px-6"
      style={{
        background:
          'linear-gradient(135deg, var(--canvas-bg) 0%, color-mix(in oklab, var(--canvas-bg) 85%, var(--primary) 15%) 100%)',
      }}
    >
      <EmptyState
        size="lg"
        tone="primary"
        title={
          <span
            style={{
              fontFamily: "var(--font-sans)",
            }}
          >
            Welcome to BobWork
          </span>
        }
        description={
          <span
            style={{
              fontFamily: "var(--font-sans)",
            }}
          >
            Build your knowledge network with AI-powered nodes on an infinite canvas
          </span>
        }
        className="w-full max-w-lg"
        icon={
          <img
            src="/welcome-icon.png"
            alt="BobWork"
            className="h-full w-full rounded-[inherit] object-contain p-1"
            draggable={false}
          />
        }
        action={
          <div
            className="w-full rounded-2xl p-5 shadow-xl"
            style={{
              backgroundColor: 'var(--popover)',
              border: '1px solid var(--line)',
              backdropFilter: 'blur(8px)',
            }}
          >
            <div className="mb-3 flex items-center gap-2">
              <Sparkles className="h-4 w-4" style={{ color: 'var(--primary)' }} />
              <span
                className="text-sm font-medium"
                style={{
                  color: 'var(--ink)',
                  fontFamily: "var(--font-sans)",
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
              className="w-full rounded-lg border px-4 py-3 text-sm outline-none transition-colors"
              style={{
                backgroundColor: 'var(--input-bg)',
                borderColor: 'var(--line)',
                color: 'var(--ink)',
                fontFamily: "var(--font-sans)",
              }}
            />

            <button
              onClick={handleCreate}
              disabled={creating || !projectName.trim()}
              className="btn btn-primary mt-4 h-11 w-full gap-2 text-sm font-medium disabled:opacity-50"
              style={{ fontFamily: "var(--font-sans)" }}
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
        }
        subAction={
          <p
            className="text-center text-xs"
            style={{
              color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)',
              fontFamily: "var(--font-sans)",
            }}
          >
            Project data is stored under ~/BobWork/BobWorkspace/
          </p>
        }
      />
    </div>
  );
}
