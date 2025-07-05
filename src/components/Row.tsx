import { useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { formats, formatDiscordTimestamp, getFormatLabel } from '../lib/formats';

interface RowProps {
  epoch: number;
  formatIndex: number;
  isSelected: boolean;
  onClick: () => void;
  onCopy: () => void;
}

export function Row({ epoch, formatIndex, isSelected, onClick, onCopy }: RowProps) {
  const [copying, setCopying] = useState(false);
  
  const format = formats[formatIndex];
  const discordCode = formatDiscordTimestamp(epoch, formatIndex);
  const preview = getFormatLabel(epoch, formatIndex);
  
  const handleCopy = async () => {
    setCopying(true);
    try {
      await writeText(discordCode);
      onCopy();
    } catch (error) {
      console.error('Failed to copy:', error);
    } finally {
      setCopying(false);
    }
  };
  
  return (
    <div 
      className={`row ${isSelected ? 'selected' : ''}`}
      onClick={onClick}
    >
      <div className="row-content">
        <div className="format-info">
          <span className="format-code">{discordCode}</span>
          <span className="format-description">{format.description}</span>
        </div>
        <div className="preview">{preview}</div>
      </div>
      <button 
        className="copy-button"
        onClick={(e) => {
          e.stopPropagation();
          handleCopy();
        }}
        disabled={copying}
      >
        {copying ? '📋' : '📄'}
      </button>
    </div>
  );
} 