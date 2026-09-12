'use client';

// ButlerNode：管家（BobWork Butler）节点薄壳，注入 butler 身份给共享内核，
// 内核据此使用专属系统提示与固定工具画像（query_schedule / create_scheduled_todo）。
import { memo } from 'react';
import { AGENT_IDS } from '@/lib/agents/profiles';
import { ChatNodeKernel, type ChatNodeKernelProps, areNodePropsEqual } from './ChatNodeKernel';

function ButlerNodeInner(props: Omit<ChatNodeKernelProps, 'identity'>) {
  return <ChatNodeKernel {...props} identity={AGENT_IDS.butler} />;
}

export const ButlerNode = memo(ButlerNodeInner, areNodePropsEqual);
