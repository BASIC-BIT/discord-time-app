import { useState } from 'react';
import { formats, formatDiscordTimestamp, getFormatLabel } from '../lib/formats';

interface RowProps {
  epoch: number;
  formatIndex: number;
  isSelected: boolean;
  isTentative?: boolean;
  onCopyAndClose: () => void;
  onMouseEnter: () => void;
}

export function Row({ epoch, formatIndex, isSelected, isTentative = false, onCopyAndClose, onMouseEnter }: RowProps) {
  const [copying, setCopying] = useState(false);
  
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
