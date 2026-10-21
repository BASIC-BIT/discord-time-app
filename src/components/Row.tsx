import { useRef, useState } from 'react';
import { formats, formatDiscordTimestamp, getFormatLabel } from '../lib/formats';

interface RowProps {
  epoch: number;
  formatIndex: number;
  isSelected: boolean;
  isTentative?: boolean;
  onCopyAndClose: () => Promise<void>;
  onMouseEnter: () => void;
}

export function Row({ epoch, formatIndex, isSelected, isTentative = false, onCopyAndClose, onMouseEnter }: RowProps) {
  const [copying, setCopying] = useState(false);
  const mountedAt = useRef(performance.now());
  
  const format = formats[formatIndex];
  const discordCode = formatDiscordTimestamp(epoch, formatIndex);
  const preview = getFormatLabel(epoch, formatIndex);
  
  const handleClick = async () => {
    if (copying) return; // Prevent double-clicks
    
    setCopying(true);
    try {
      await onCopyAndClose();
    } catch (error) {
      console.error('Failed to copy:', error);
    } finally {
      setCopying(false);
    }
  };
  
  // Require pointer movement: mounting under a stationary pointer must not select a new format.
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
