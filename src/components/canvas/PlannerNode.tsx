'use client';

// PlannerNode：日程安排专家（Scheduling Planner）节点薄壳，注入 planner 身份给共享内核，
// 内核据此使用专属系统提示与固定工具画像（query_schedule / create_scheduled_todo）。
import { memo } from 'react';
import { AGENT_IDS } from '@/lib/agents/profiles';
import { ChatNodeKernel, type ChatNodeKernelProps, areNodePropsEqual } from './ChatNodeKernel';

function PlannerNodeInner(props: Omit<ChatNodeKernelProps, 'identity'>) {
  return <ChatNodeKernel {...props} identity={AGENT_IDS.planner} />;
}

export const PlannerNode = memo(PlannerNodeInner, areNodePropsEqual);
