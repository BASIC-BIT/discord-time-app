import { useState, useEffect, useRef } from 'react';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { Row } from './Row';
import { formats, getFormatLabel } from '../lib/formats';
import { getUserTimezone } from '../lib/prompt';
import { createAPIClient, TimeParserAPIError, type ParseAlternative } from '../lib/api-client';
import { parseFallback } from '../lib/parse';
import { getFormatStats, incrementFormatUsage, getMostUsedFormatIndex, initStats } from '../lib/stats';

const LOCAL_FALLBACK_CONFIDENCE = 0.65;

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
  const [clarificationQuestion, setClarificationQuestion] = useState<string | null>(null);
  const [clarificationAlternatives, setClarificationAlternatives] = useState<ParseAlternative[]>([]);
  const [selectedAlternativeIndex, setSelectedAlternativeIndex] = useState(0);
  const [confidence, setConfidence] = useState(1);
  const [isClipboardText, setIsClipboardText] = useState(false);
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceTimeoutRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const selectionTouchedRef = useRef(false);

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
        setConfidence(1);
        setClarificationQuestion(null);
        setClarificationAlternatives([]);
        setSelectedAlternativeIndex(0);
        const formatIndex = formats.findIndex(f => f.code === existingTimestamp.formatCode);
        setSelectedIndex(formatIndex >= 0 ? formatIndex : 0);
        selectionTouchedRef.current = false;
        setError(null);
        setLoading(false);
      } else {
        setEpoch(null);
        setConfidence(1);
        setError(null);
        setClarificationQuestion(null);
        setClarificationAlternatives([]);
        setSelectedAlternativeIndex(0);
        selectionTouchedRef.current = false;
        // Parse as natural language with debounce
        setLoading(true);
        debounceTimeoutRef.current = setTimeout(() => {
          parseInput(inputText.trim(), isClipboardText);
        }, 300); // 300ms debounce for faster response
      }
    } else {
      setEpoch(null);
      setError(null);
      setClarificationQuestion(null);
      setClarificationAlternatives([]);
      setSelectedAlternativeIndex(0);
      setConfidence(1);
      selectionTouchedRef.current = false;
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
  }, [epoch, loading, error, clarificationQuestion, clarificationAlternatives]); // Resize when content changes

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
    setClarificationQuestion(null);
    setClarificationAlternatives([]);
    setSelectedAlternativeIndex(0);
    
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
      
      const fallbackEpoch = isFromClipboard ? null : parseFallback(text);
      let displayedFallback = false;
      if (fallbackEpoch) {
        setEpoch(fallbackEpoch);
        setSelectedIndex(getMostUsedFormatIndex(stats));
        setConfidence(LOCAL_FALLBACK_CONFIDENCE);
        displayedFallback = true;
      }

      // Verify with backend API after showing a local estimate when possible.
      const apiClient = createAPIClient();
      let result: { epoch: number; suggestedFormatIndex: number; confidence: number; method: string } | null = null;
      let apiError: Error | null = null;
      
      if (apiClient) {
        try {
          result = await apiClient.parseTime(text, timezone, abortController.signal);
          console.log("API Result: ", result);
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            throw error; // Re-throw abort errors
          }
          apiError = error instanceof Error ? error : new Error('Unknown API parsing error');
          console.error('API parsing failed:', error);
          // Fall through to chrono-node fallback
        }
      }

      // Check if request was cancelled after API call
      if (abortController.signal.aborted) {
        return;
      }
      
      if (result && result.epoch) {
        console.log('API parsed successfully:', result);
        setEpoch(result.epoch);
        if (!selectionTouchedRef.current) {
          setSelectedIndex(result.suggestedFormatIndex);
        }
        setConfidence(result.confidence);
        setClarificationQuestion(null);
        setClarificationAlternatives([]);
        setSelectedAlternativeIndex(0);
      } else {
        const hardParseRejection = apiError instanceof TimeParserAPIError && apiError.status === 400;
        if (displayedFallback && !hardParseRejection) {
          setConfidence(LOCAL_FALLBACK_CONFIDENCE);
        } else {
          setEpoch(null);
          setConfidence(1);
          if (isFromClipboard) {
            setError(null);
          } else if (apiError instanceof TimeParserAPIError && apiError.alternatives && apiError.alternatives.length > 0) {
            setClarificationQuestion(apiError.message);
            setClarificationAlternatives(apiError.alternatives);
            setSelectedAlternativeIndex(0);
            setError(null);
          } else {
            setError(apiError?.message ?? 'Could not understand that time expression. Try being more specific like "Jan 15 at 3pm" or "in 2 hours".');
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

  const hasClarification = clarificationQuestion !== null && clarificationAlternatives.length > 0;
  const showLowConfidence = !loading && epoch !== null && confidence < 0.5;
  const statusTone = error ? 'error' : hasClarification ? 'choice' : showLowConfidence ? 'warning' : 'info';
  const hasInlineStatus = error || hasClarification || showLowConfidence;
  const showVerifyingTab = loading && !hasClarification && !error;
  const overlayTone = error
    ? 'error'
    : hasClarification
      ? 'clarifying'
      : loading
        ? 'verifying'
        : showLowConfidence
          ? 'low-confidence'
          : epoch !== null && confidence >= 0.85
            ? 'confident'
            : epoch !== null
              ? 'ready'
              : 'idle';
  const footerHint = hasClarification
    ? '←→/Tab to choose • Enter to use • Esc to close'
    : epoch !== null
      ? '↑↓/Tab to choose format • Enter to copy • Esc to close'
      : 'Type a time expression • Esc to close';

  const moveAlternativeSelection = (delta: number) => {
    setSelectedAlternativeIndex((current) => {
      const count = clarificationAlternatives.length;
      if (count === 0) {
        return 0;
      }
      return (current + delta + count) % count;
    });
  };

  const handleClarificationAlternative = (alternative: ParseAlternative) => {
    setEpoch(alternative.epoch);
    setSelectedIndex(alternative.suggestedFormatIndex);
    setConfidence(alternative.confidence);
    setError(null);
    setClarificationQuestion(null);
    setClarificationAlternatives([]);
    setSelectedAlternativeIndex(0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (hasClarification) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const alternative = clarificationAlternatives[selectedAlternativeIndex];
        if (alternative) {
          handleClarificationAlternative(alternative);
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        selectionTouchedRef.current = true;
        moveAlternativeSelection(-1);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        selectionTouchedRef.current = true;
        moveAlternativeSelection(1);
      } else if (/^[1-9]$/.test(e.key)) {
        const alternativeIndex = Number(e.key) - 1;
        const alternative = clarificationAlternatives[alternativeIndex];
        if (alternative) {
          e.preventDefault();
          handleClarificationAlternative(alternative);
        }
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (epoch !== null) {
        handleCopy();
      }
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      selectionTouchedRef.current = true;
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : formats.length - 1));
    } else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      selectionTouchedRef.current = true;
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
    selectionTouchedRef.current = true;
    setSelectedIndex(index);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    
    // If this is clipboard text and user is typing (not just selecting)
    if (isClipboardText && newValue !== inputText) {
      setIsClipboardText(false);
      setClarificationQuestion(null);
      setClarificationAlternatives([]);
      setSelectedAlternativeIndex(0);
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
    <div className={`overlay ${overlayTone}`} onKeyDown={handleKeyDown} tabIndex={-1}>
      <div className="input-section">
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={handleInputChange}
          placeholder="Enter date/time (e.g., 'tomorrow at 2pm', 'next Friday')"
          className="input-textarea"
          rows={2}
        />
        {epoch !== null && !hasClarification && (
          <div className="found-time-card" aria-live="polite">
            <div className="found-time-value">{getFormatLabel(epoch, 5)}</div>
          </div>
        )}
        {hasInlineStatus && (
          <div className={`status-card ${statusTone}`}>
            {error && <div className="status-line">{error}</div>}
            {hasClarification && (
              <div className="clarification">
                <div className="clarification-title">{clarificationQuestion}</div>
                <div className="clarification-help">Use ←/→ or Tab to choose, then Enter.</div>
                <div className="clarification-options">
                  {clarificationAlternatives.map((alternative, index) => (
                    <button
                      key={`${alternative.label}-${alternative.epoch}`}
                      type="button"
                      className={`clarification-option ${index === selectedAlternativeIndex ? 'selected' : ''}`}
                      aria-pressed={index === selectedAlternativeIndex}
                      onClick={() => handleClarificationAlternative(alternative)}
                      onFocus={() => setSelectedAlternativeIndex(index)}
                      onMouseEnter={() => setSelectedAlternativeIndex(index)}
                    >
                      <span className="clarification-key">{index + 1}</span>
                      <span className="clarification-label">{alternative.label}</span>
                      <span className="clarification-preview">{getFormatLabel(alternative.epoch, alternative.suggestedFormatIndex)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {showLowConfidence && (
              <div className="status-line">Low confidence. Check the timestamp before copying.</div>
            )}
          </div>
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
                isTentative={loading && index === selectedIndex}
                onCopyAndClose={handleCopy}
                onMouseEnter={() => handleRowMouseEnter(index)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="footer">
        <div className="footer-status-slot" aria-live="polite">
          <div className={`verifying-tab ${showVerifyingTab ? 'visible' : ''}`}>
            <span className="progress-dot" />
            {epoch !== null ? 'Verifying...' : 'Parsing...'}
          </div>
        </div>
        <span className="hint">{footerHint}</span>
      </div>
    </div>
  );
}
