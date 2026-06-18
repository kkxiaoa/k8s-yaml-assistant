import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 右侧栏可拖拽宽度。返回当前宽度 + 拖拽手柄的 onResizeStart(onMouseDown)。
 * 侧栏在右侧,所以宽度 = 视口宽 - 鼠标 X,再夹在 [min, max]。
 */
export function useResizable(initial: number, min: number, max: number) {
  const [width, setWidth] = useState(initial);
  const dragging = useRef(false);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) return;
      setWidth(Math.min(max, Math.max(min, window.innerWidth - e.clientX)));
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [min, max]);

  return { width, onResizeStart };
}
