'use client';

import { CanvasFlow } from '@/components/canvas/CanvasFlow';
import { UpdateNotification } from '@/components/canvas/UpdateNotification';

export default function Home() {
  return (
    <>
      <UpdateNotification />
      <CanvasFlow />
    </>
  );
}
