'use client';

import {
  cloneElement,
  isValidElement,
  useId,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';

const ALIGNMENT = {
  start: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  end: 'right-0',
} as const;

const PLACEMENT = {
  bottom: 'top-full mt-2',
  top: 'bottom-full mb-2',
} as const;

interface TooltipProps
  extends Omit<ComponentPropsWithoutRef<'span'>, 'content'> {
  content?: ReactNode;
  align?: keyof typeof ALIGNMENT;
  describeChild?: boolean;
  placement?: keyof typeof PLACEMENT;
  tooltipClassName?: string;
}

export function Tooltip({
  content,
  align = 'center',
  describeChild = false,
  placement = 'bottom',
  tooltipClassName = 'whitespace-nowrap px-2 py-1 font-mono text-[11px]',
  className = '',
  children,
  'aria-describedby': describedBy,
  ...props
}: TooltipProps) {
  const tooltipId = useId();
  const descriptionIds = [describedBy, content ? tooltipId : null]
    .filter(Boolean)
    .join(' ');
  const childElement = isValidElement<{ 'aria-describedby'?: string }>(
    children,
  )
    ? children
    : null;
  const childDescriptionIds = childElement
    ? [childElement.props['aria-describedby'], content ? tooltipId : null]
        .filter(Boolean)
        .join(' ')
    : '';
  const describedChildren =
    describeChild && childElement
      ? cloneElement(childElement, {
          'aria-describedby': childDescriptionIds || undefined,
        })
      : children;

  return (
    <span
      {...props}
      aria-describedby={
        describeChild ? describedBy : descriptionIds || undefined
      }
      className={`group/tooltip relative inline-flex ${className}`}
    >
      {describedChildren}
      {content && (
        <span
          id={tooltipId}
          role="tooltip"
          className={`pointer-events-none absolute z-30 rounded border border-line bg-surface text-fg opacity-0 shadow-lg transition group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100 ${PLACEMENT[placement]} ${ALIGNMENT[align]} ${tooltipClassName}`}
        >
          {content}
        </span>
      )}
    </span>
  );
}
