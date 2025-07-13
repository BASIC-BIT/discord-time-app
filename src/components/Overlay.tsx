import { useState, useEffect, useRef } from 'react';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { Row } from './Row';
import { formats } from '../lib/formats';
import { getUserTimezone } from '../lib/prompt';
import { createAPIClient } from '../lib/api-client';
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [confidence, setConfidence] = useState(1);
  const [isClipboardText, setIsClipboardText] = useState(false);
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceTimeoutRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Initialize and load clipboard content
  useEffect(() => {
    const initialize = async () => {
      try {
        // Initialize stats database
        await initStats();
        
        // Load clipboard content (handle empty clipboard gracefully)
        let clipboardText = '';
        try {
          clipboardText = await readText();
        } catch (clipboardError) {
          console.log('Clipboard is empty or unavailable:', clipboardError);
          clipboardText = '';
        }
        
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
          } else {
            // Regular text - set as input for parsing
            setInputText(clipboardText);
            setIsClipboardText(true);
          }
        }
        
        // Focus the window
        const window = getCurrentWindow();
        try {
          await window.setFocus();
        } catch (error) {
          console.error('Error focusing window:', error);
        }
        
        // Then focus the textarea after a short delay
        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            if (clipboardText) {
              textareaRef.current.select();
            }
          }
        }, 10);

        // Window size is now properly set in tauri.conf.json
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
          parseInput(inputText.trim(), isClipboardText);
        }, 300); // 300ms debounce for faster response
      }
    } else {
      setEpoch(null);
      setError(null);
      setInfo(null);
      setLoading(false);
    }
  }, [inputText]);

  // Auto-resize window height based on content (only for main window)
  useEffect(() => {
    const window = getCurrentWindow();
    // Only resize if this is the main window
    if (window.label !== 'main') return;
    
    const resizeWindow = async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 50)); // Wait for DOM update
        const contentHeight = document.body.scrollHeight;
        await window.setSize(new LogicalSize(480, Math.max(contentHeight, 100)));
      } catch (error) {
        console.error('Error resizing window:', error);
      }
    };
    
    resizeWindow();
  }, [epoch, loading, error, info]); // Resize when content changes

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

  const parseInput = async (text: string, isFromClipboard: boolean = false) => {
    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    
    setError(null);
    setInfo(null);
    
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
      
      // Try backend API parsing first
      const apiClient = createAPIClient();
      let result: { epoch: number; suggestedFormatIndex: number; confidence: number; method: string } | null = null;
      
      if (apiClient) {
        try {
          result = await apiClient.parseTime(text, timezone, abortController.signal);
          console.log("API Result: ", result);
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            throw error; // Re-throw abort errors
          }
          console.error('API parsing failed:', error);
          // Fall through to chrono-node fallback
        }
      }

      // Check if request was cancelled after API call
      if (abortController.signal.aborted) {
        return;
      }
      
      if (result && result.epoch) {
        // API parsing successful - we already have the epoch
        console.log('API parsed successfully:', result);
        setEpoch(result.epoch);
        setSelectedIndex(result.suggestedFormatIndex);
        setConfidence(result.confidence);
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
          if (isFromClipboard) {
            setInfo('Enter a date/time expression like "Jan 15 at 3pm" or "in 2 hours"');
          } else {
            setError('Could not understand that time expression. Try being more specific like "Jan 15 at 3pm" or "in 2 hours".');
          }
        }
      }
    } catch (error) {
      // Don't show errors for aborted requests
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Parsing request aborted');
        return;
      }
      
      console.error('Error parsing input:', error);
      setError('Something went wrong. Please try again or check your internet connection.');
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
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : formats.length - 1));
    } else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < formats.length - 1 ? prev + 1 : 0));
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

  const handleRowMouseEnter = (index: number) => {
    setSelectedIndex(index);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    
    // If this is clipboard text and user is typing (not just selecting)
    if (isClipboardText && newValue !== inputText) {
      setIsClipboardText(false);
      setInfo(null); // Clear info message when user starts typing
      // Replace the entire text with just what they typed
      const selectionStart = e.target.selectionStart;
      const selectionEnd = e.target.selectionEnd;
      if (selectionStart === selectionEnd) {
        // Single cursor position - replace everything
        const lastChar = newValue[newValue.length - 1];
        setInputText(lastChar || '');
      } else {
        // They selected and typed - use normal behavior
        setInputText(newValue);
      }
    } else {
      setInputText(newValue);
    }
  };

  return (
    <div className="overlay" onKeyDown={handleKeyDown} tabIndex={-1}>
      <div className="input-section">
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={handleInputChange}
          placeholder="Enter date/time (e.g., 'tomorrow at 2pm', 'next Friday')"
          className="input-textarea"
          rows={2}
        />
        {loading && <div className="loading">Parsing...</div>}
        {error && <div className="error">{error}</div>}
        {info && <div className="info">{info}</div>}
        {confidence < 0.5 && (
          <div className="warning">Low confidence - please check the result</div>
        )}
      </div>

      {epoch !== null && (
        <div className="results-section">
          <div className="format-list">
            {formats.map((_, index) => (
              <Row
                key={index}
                epoch={epoch}
                formatIndex={index}
                isSelected={index === selectedIndex}
                onCopyAndClose={handleCopy}
                onMouseEnter={() => handleRowMouseEnter(index)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="footer">
        <span className="hint">↑↓ arrows/Tab to navigate • Enter to copy • Esc to close</span>
      </div>
    </div>
  );
} 