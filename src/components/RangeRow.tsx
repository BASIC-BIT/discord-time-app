import { useState } from 'react';
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
      onClick={handleClick}
      onMouseEnter={onMouseEnter}
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
