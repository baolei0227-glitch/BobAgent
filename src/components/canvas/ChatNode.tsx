'use client';

// ChatNode：普通对话节点薄壳，注入 chat 身份给共享内核。
import { memo } from 'react';
import { AGENT_IDS } from '@/lib/agents/profiles';
import { ChatNodeKernel, type ChatNodeKernelProps, areNodePropsEqual } from './ChatNodeKernel';

function ChatNodeInner(props: Omit<ChatNodeKernelProps, 'identity'>) {
  return <ChatNodeKernel {...props} identity={AGENT_IDS.chat} />;
}

export const ChatNode = memo(ChatNodeInner, areNodePropsEqual);