import React, { useState, useCallback } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { EpicTitleTooltip, EpicTitleTooltipProps } from './EpicTitleTooltip';

type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

export interface EpicTooltipWrapperProps extends EpicTitleTooltipProps {
  children: React.ReactNode;
  /** Tooltip position relative to trigger */
  side?: TooltipSide;
  /** Enable dynamic side calculation based on viewport space */
  dynamicSide?: boolean;
  /** Minimum space (px) needed on the preferred side before flipping */
  dynamicSideThreshold?: number;
  /** Tooltip alignment */
  align?: 'start' | 'center' | 'end';
  /** Delay before showing tooltip (ms) */
  delayDuration?: number;
  /** Offset from trigger element (px) */
  sideOffset?: number;
  /** Additional class for TooltipContent */
  contentClassName?: string;
}

/**
 * Reusable wrapper that combines Tooltip + EpicTitleTooltip.
 * Use this to show epic preview on hover for any trigger element.
 *
 * For dynamic positioning based on viewport space, use `dynamicSide={true}`.
 */
export function EpicTooltipWrapper({
  children,
  side = 'right',
  dynamicSide = false,
  dynamicSideThreshold = 360,
  align = 'start',
  delayDuration = 150,
  sideOffset,
  contentClassName = 'max-w-xs',
  // EpicTitleTooltip props
  title,
  statusLabel,
  statusColor,
  agentName,
  description,
  showFilterToggle,
  onViewDetails,
  onToggleParentFilter,
  showBulkEdit,
  onBulkEdit,
  onEdit,
  onDelete,
  showOpenDetails,
}: EpicTooltipWrapperProps) {
  const [computedSide, setComputedSide] = useState<TooltipSide>(side);

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent) => {
      if (!dynamicSide) return;
      try {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const availableRight = vw - rect.right;
        const newSide: TooltipSide = availableRight < dynamicSideThreshold ? 'left' : 'right';
        if (newSide !== computedSide) {
          setComputedSide(newSide);
        }
      } catch {
        // Ignore errors in side calculation
      }
    },
    [dynamicSide, dynamicSideThreshold, computedSide],
  );

  const actualSide = dynamicSide ? computedSide : side;

  return (
    <TooltipProvider delayDuration={delayDuration}>
      <Tooltip>
        <TooltipTrigger asChild onMouseEnter={handleMouseEnter}>
          {children}
        </TooltipTrigger>
        <TooltipContent
          side={actualSide}
          align={align}
          sideOffset={sideOffset}
          className={contentClassName}
        >
          <EpicTitleTooltip
            title={title}
            statusLabel={statusLabel}
            statusColor={statusColor}
            agentName={agentName}
            description={description}
            showFilterToggle={showFilterToggle}
            onViewDetails={onViewDetails}
            onToggleParentFilter={onToggleParentFilter}
            showBulkEdit={showBulkEdit}
            onBulkEdit={onBulkEdit}
            onEdit={onEdit}
            onDelete={onDelete}
            showOpenDetails={showOpenDetails}
          />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default EpicTooltipWrapper;
