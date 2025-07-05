import { useState, useEffect, useRef } from 'react';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { Row } from './Row';
import { formats } from '../lib/formats';
import { parseWithLLM, getUserTimezone, LLMResponse } from '../lib/prompt';
import { parseFallback } from '../lib/parse';
import { getFormatStats, incrementFormatUsage, getMostUsedFormatIndex, initStats } from '../lib/stats';

// Function to detect and parse existing Discord timestamps
function parseExistingTimestamp(text: string): { epoch: number; formatCode: string } | null {
  // Match Discord timestamp format: <t:1234567890:d>
  const timestampRegex = /<t:(\d+)(:[dDtTfFR])>/;
  const match = text.match(timestampRegex);
  
  if (match) {
    const epoch = parseInt(match[1], 10);
    const formatCode = match[2];
    
    // Validate epoch (reasonable timestamp range)
    if (epoch > 0 && epoch < 2147483647) { // Unix timestamp limits
      return { epoch, formatCode };
    }
  }
  
  return null;
}

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
  const debounceTimeoutRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Initialize and load clipboard content
  useEffect(() => {
    const initialize = async () => {
      try {
        // Initialize stats database
        await initStats();
        
        // Load clipboard content
        const clipboardText = await readText();
        if (clipboardText) {
          // Check if clipboard contains an existing Discord timestamp
          const existingTimestamp = parseExistingTimestamp(clipboardText);
          
          if (existingTimestamp) {
            // Found existing timestamp - extract epoch and set format
            setEpoch(existingTimestamp.epoch);
            setInputText(clipboardText);
            
            // Find the format index that matches the current format code
            const formatIndex = formats.findIndex(f => f.code === existingTimestamp.formatCode);
            setSelectedIndex(formatIndex >= 0 ? formatIndex : 0);
            setExpanded(true); // Show all formats so user can pick different ones
          } else {
            // Regular text - set as input for parsing
            setInputText(clipboardText);
          }
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

  // Parse input text when it changes (with debounce)
  useEffect(() => {
    // Clear previous debounce timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    // Cancel any ongoing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    if (inputText.trim()) {
      // Check if input is already a Discord timestamp (no debounce needed)
      const existingTimestamp = parseExistingTimestamp(inputText.trim());
      
      if (existingTimestamp) {
        // Already a timestamp - just update the epoch and format immediately
        setEpoch(existingTimestamp.epoch);
        const formatIndex = formats.findIndex(f => f.code === existingTimestamp.formatCode);
        setSelectedIndex(formatIndex >= 0 ? formatIndex : 0);
        setError(null);
        setLoading(false);
      } else {
        // Parse as natural language with debounce
        setLoading(true);
        debounceTimeoutRef.current = setTimeout(() => {
          parseInput(inputText.trim());
        }, 500); // 500ms debounce
      }
    } else {
      setEpoch(null);
      setError(null);
      setLoading(false);
    }
  }, [inputText]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const parseInput = async (text: string) => {
    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    
    setError(null);
    
    try {
      // Check if request was already cancelled
      if (abortController.signal.aborted) {
        return;
      }

      // Get format stats for LLM context
      const stats = await getFormatStats();
      const timezone = getUserTimezone();
      
      // Check again if request was cancelled
      if (abortController.signal.aborted) {
        return;
      }
      
      // Try LLM parsing first
      const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
      let result: LLMResponse | null = null;
      
      if (apiKey && apiKey !== 'your-openai-api-key-here') {
        result = await parseWithLLM(text, timezone, stats, apiKey, abortController.signal);
        console.log("LLM Result: ", result);
      }

      // Check if request was cancelled after API call
      if (abortController.signal.aborted) {
        return;
      }
      
      if (result) {
        // LLM normalization successful - now parse the normalized text
        console.log('LLM normalized:', result.normalizedText, 'Reasoning:', result.reasoning);
        const normalizedEpoch = parseFallback(result.normalizedText);
        if (normalizedEpoch) {
          setEpoch(normalizedEpoch);
          setSelectedIndex(result.suggestedFormatIndex);
          setConfidence(result.confidence);
        } else {
          // If normalized text still fails, try original text as fallback
          const fallbackEpoch = parseFallback(text);
          if (fallbackEpoch) {
            setEpoch(fallbackEpoch);
            setSelectedIndex(result.suggestedFormatIndex);
            setConfidence(result.confidence * 0.7); // Reduce confidence
          } else {
            setEpoch(null);
            setError(`Unable to parse even after normalization. LLM suggested: "${result.normalizedText}"`);
          }
        }
      } else {
        // Fallback to chrono-node directly
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
      // Don't show errors for aborted requests
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Parsing request aborted');
        return;
      }
      
      console.error('Error parsing input:', error);
      setError('Error parsing input. Please try again.');
    } finally {
      // Only set loading to false if this request wasn't aborted
      if (!abortController.signal.aborted) {
        setLoading(false);
      }
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
        const discordCode = `<t:${epoch}${formats[selectedIndex].code}>`;
        await writeText(discordCode);
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