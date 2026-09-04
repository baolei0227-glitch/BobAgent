'use client';

// CodingNode：AI Coding 节点薄壳（绑定 Bob Sandbox 小程序），注入 coding 身份给共享内核，
// 内核据此渲染蓝色边框光晕与编程任务上下文。
import { memo } from 'react';
import { AGENT_IDS } from '@/lib/agents/profiles';
import { ChatNodeKernel, type ChatNodeKernelProps, areNodePropsEqual } from './ChatNodeKernel';

function CodingNodeInner(props: Omit<ChatNodeKernelProps, 'identity'>) {
  return <ChatNodeKernel {...props} identity={AGENT_IDS.coding} />;
}

export const CodingNode = memo(CodingNodeInner, areNodePropsEqual);