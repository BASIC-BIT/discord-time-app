import { useRef, useState } from 'react';
import { formatDiscordRange, getRangeLabel, rangeFormats } from '../lib/formats';
import type { ParseRangeResult } from '../lib/api-client';

interface RangeRowProps {
  range: ParseRangeResult;
  formatIndex: number;
  isSelected: boolean;
  isTentative?: boolean;
  onCopyAndClose: () => Promise<void> | void;
  onMouseEnter: () => void;
}

export function RangeRow({ range, formatIndex, isSelected, isTentative = false, onCopyAndClose, onMouseEnter }: RangeRowProps) {
  const [copying, setCopying] = useState(false);
  const mountedAt = useRef(performance.now());
  const format = rangeFormats[formatIndex];
  const discordCode = formatDiscordRange(range, formatIndex);
  const preview = getRangeLabel(range, formatIndex);

  const handleClick = async () => {
    if (copying) return;

    setCopying(true);
    try {
      await onCopyAndClose();
    } catch (error) {
      console.error('Failed to copy range:', error);
    } finally {
      setCopying(false);
    }
  };

  return (
    <div
      className={`row ${isSelected ? 'selected' : ''} ${isTentative ? 'tentative' : ''} ${copying ? 'copying' : ''}`}
      role="button"
      tabIndex={isSelected ? 0 : -1}
      aria-label={`Copy ${format.description}: ${discordCode}`}
      onKeyDown={event => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          void handleClick();
        }
      }}
      onClick={handleClick}
      onMouseMove={event => {
        // WebKit can replay pre-mount motion with nonzero deltas after layout changes.
        if (event.timeStamp < mountedAt.current) return;
        if (event.movementX !== 0 || event.movementY !== 0) onMouseEnter();
      }}
      style={{ cursor: 'pointer' }}
    >
      <div className="row-content">
        <div className="preview">{preview}</div>
        <div className="format-info">
          <span className="format-description">{format.description}</span>
          <span className="format-code">{discordCode}</span>
        </div>
      </div>
    </div>
  );
}
