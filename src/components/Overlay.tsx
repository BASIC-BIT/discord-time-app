import { useState, useEffect, useRef } from 'react';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { Row } from './Row';
import { formats } from '../lib/formats';
import { parseWithLLM, getUserTimezone, LLMResponse } from '../lib/prompt';
import { parseFallback } from '../lib/parse';
import { getFormatStats, incrementFormatUsage, getMostUsedFormatIndex, initStats } from '../lib/stats';

interface OverlayProps {
  onClose: () => void;
}

export function Overlay({ onClose }: OverlayProps) {
  const [inputText, setInputText] = useState('');
  const [epoch, setEpoch] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confidence, setConfidence] = useState(1);
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const appWindow = getCurrentWindow();

  // Initialize and load clipboard content
  useEffect(() => {
    const initialize = async () => {
      try {
        // Initialize stats database
        await initStats();
        
        // Load clipboard content
        const clipboardText = await readText();
        if (clipboardText) {
          setInputText(clipboardText);
        }
        
        // Focus the textarea
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.select();
        }
      } catch (error) {
        console.error('Error initializing overlay:', error);
      }
    };
    
    initialize();
  }, []);

  // Parse input text when it changes
  useEffect(() => {
    if (inputText.trim()) {
      parseInput(inputText.trim());
    } else {
      setEpoch(null);
      setError(null);
    }
  }, [inputText]);

  const parseInput = async (text: string) => {
    setLoading(true);
    setError(null);
    
    try {
      // Get format stats for LLM context
      const stats = await getFormatStats();
      const timezone = getUserTimezone();
      
      // Try LLM parsing first
      const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
      let result: LLMResponse | null = null;
      
      if (apiKey && apiKey !== 'your-openai-api-key-here') {
        result = await parseWithLLM(text, timezone, stats, apiKey);
      }
      
      if (result) {
        // LLM parsing successful
        setEpoch(result.epoch);
        setSelectedIndex(result.suggestedFormatIndex);
        setConfidence(result.confidence);
      } else {
        // Fallback to chrono-node
        const fallbackEpoch = parseFallback(text);
        if (fallbackEpoch) {
          setEpoch(fallbackEpoch);
          // Use most used format or default to 0
          const mostUsedIndex = getMostUsedFormatIndex(stats);
          setSelectedIndex(mostUsedIndex);
          setConfidence(0.7); // Medium confidence for fallback
        } else {
          setEpoch(null);
          setError('Unable to parse date/time. Please try a more specific format.');
        }
      }
    } catch (error) {
      console.error('Error parsing input:', error);
      setError('Error parsing input. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (epoch !== null) {
        handleCopy();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!expanded) {
        setExpanded(true);
      } else {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : formats.length - 1));
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!expanded) {
        setExpanded(true);
      } else {
        setSelectedIndex((prev) => (prev < formats.length - 1 ? prev + 1 : 0));
      }
    }
  };

  const handleCopy = async () => {
    if (epoch !== null) {
      try {
        await incrementFormatUsage(selectedIndex);
        onClose();
      } catch (error) {
        console.error('Error copying:', error);
      }
    }
  };

  const handleRowClick = (index: number) => {
    setSelectedIndex(index);
  };

  return (
    <div className="overlay" onKeyDown={handleKeyDown} tabIndex={-1}>
      <div className="input-section">
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Enter date/time (e.g., 'tomorrow at 2pm', 'next Friday')"
          className="input-textarea"
          rows={2}
        />
        {loading && <div className="loading">Parsing...</div>}
        {error && <div className="error">{error}</div>}
        {confidence < 0.5 && (
          <div className="warning">Low confidence - please check the result</div>
        )}
      </div>

      {epoch !== null && (
        <div className="results-section">
          {expanded ? (
            <div className="format-list">
              {formats.map((_, index) => (
                <Row
                  key={index}
                  epoch={epoch}
                  formatIndex={index}
                  isSelected={index === selectedIndex}
                  onClick={() => handleRowClick(index)}
                  onCopy={handleCopy}
                />
              ))}
            </div>
          ) : (
            <div className="single-result">
              <Row
                epoch={epoch}
                formatIndex={selectedIndex}
                isSelected={true}
                onClick={() => setExpanded(true)}
                onCopy={handleCopy}
              />
              <div className="hint">↑↓ to see more formats</div>
            </div>
          )}
        </div>
      )}

      <div className="footer">
        <span className="hint">Enter to copy • Esc to close</span>
      </div>
    </div>
  );
} 