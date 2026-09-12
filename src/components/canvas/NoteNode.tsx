'use client';

// NoteNode：知识库（Notes）节点薄壳，注入 note 身份给共享内核，
// 内核据此使用 Karpathy LLM Wiki 专属系统提示与固定工具画像（butler 场景）。
import { memo } from 'react';
import { AGENT_IDS } from '@/lib/agents/profiles';
import { ChatNodeKernel, type ChatNodeKernelProps, areNodePropsEqual } from './ChatNodeKernel';

function NoteNodeInner(props: Omit<ChatNodeKernelProps, 'identity'>) {
  return <ChatNodeKernel {...props} identity={AGENT_IDS.note} />;
}

export const NoteNode = memo(NoteNodeInner, areNodePropsEqual);
