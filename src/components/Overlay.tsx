import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { Row } from './Row';
import { RangeRow } from './RangeRow';
import { formatDiscordRange, formats, getFormatLabel, getRangeLabel, rangeFormats } from '../lib/formats';
import { getUserTimezone } from '../lib/prompt';
import { createAPIClient, TimeParserAPIError, TimeParserUnavailableError, type ParseAlternative, type ParseRangeResult, type ParseResponse } from '../lib/api-client';
import { parseFallback } from '../lib/parse';
import { getFormatStats, incrementFormatUsage, getMostUsedFormatIndex, initStats } from '../lib/stats';

const LOCAL_FALLBACK_CONFIDENCE = 0.65;

interface AppSettings {
  deterministic_preflight: boolean;
}

function clarificationKeyLabel(index: number): string {
  return index === 9 ? '0' : String(index + 1);
}

function clarificationIndexForKey(key: string): number | null {
  if (key === '0') {
    return 9;
  }
  if (/^[1-9]$/.test(key)) {
    return Number(key) - 1;
  }
  return null;
}

const DISCORD_TIMESTAMP_PATTERN = '<t:(\\d+)(:[dDtTfFR])>';
const DISCORD_TIMESTAMP_REGEX = new RegExp(DISCORD_TIMESTAMP_PATTERN);
const DISCORD_TIMESTAMP_RANGE_REGEX = new RegExp(`${DISCORD_TIMESTAMP_PATTERN}\\s*(?:-|–|—|to)\\s*${DISCORD_TIMESTAMP_PATTERN}`, 'i');

function formatIndexForCode(formatCode: string): number {
  const formatIndex = formats.findIndex(f => f.code === formatCode);
  return formatIndex >= 0 ? formatIndex : 0;
}

function isValidDiscordEpoch(epoch: number): boolean {
  return epoch > 0 && epoch < 2147483647; // Unix timestamp limits
}

function getZonedDateTimeLabel(epoch: number, timeZone: string): string {
  const date = new Date(epoch * 1000);
  try {
    return date.toLocaleString('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).replace(' ', 'T');
  } catch {
    return date.toISOString();
  }
}

function buildDiscordRangeEndpoint(epoch: number, formatCode: string, timeZone: string): ParseRangeResult['start'] {
  const isoInstant = new Date(epoch * 1000).toISOString();
  return {
    epoch,
    suggestedFormatIndex: formatIndexForCode(formatCode),
    canonical: {
      isoInstant,
      zonedDateTime: getZonedDateTimeLabel(epoch, timeZone),
      timeZone,
      precision: 'datetime',
    },
  };
}

// Function to detect and parse existing Discord timestamps
function parseExistingTimestamp(text: string): { epoch: number; formatCode: string } | null {
  // Match Discord timestamp format: <t:1234567890:d>
  const match = text.match(DISCORD_TIMESTAMP_REGEX);
  
  if (match) {
    const epoch = parseInt(match[1], 10);
    const formatCode = match[2];
    
    if (isValidDiscordEpoch(epoch)) {
      return { epoch, formatCode };
    }
  }
  
  return null;
}

function parseExistingTimestampRange(text: string): ParseRangeResult | null {
  const match = text.match(DISCORD_TIMESTAMP_RANGE_REGEX);
  if (!match) {
    return null;
  }

  const startEpoch = parseInt(match[1], 10);
  const startFormatCode = match[2];
  const endEpoch = parseInt(match[3], 10);
  const endFormatCode = match[4];
  if (!isValidDiscordEpoch(startEpoch) || !isValidDiscordEpoch(endEpoch)) {
    return null;
  }

  const timeZone = getUserTimezone();
  return {
    start: buildDiscordRangeEndpoint(startEpoch, startFormatCode, timeZone),
    end: buildDiscordRangeEndpoint(endEpoch, endFormatCode, timeZone),
    discord: `<t:${startEpoch}${startFormatCode}> - <t:${endEpoch}${endFormatCode}>`,
  };
}

interface OverlayProps {
  onClose: () => void;
  openToken: number;
}

export function Overlay({ onClose, openToken }: OverlayProps) {
  const [inputText, setInputText] = useState('');
  const [epoch, setEpoch] = useState<number | null>(null);
  const [range, setRange] = useState<ParseRangeResult | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clarificationQuestion, setClarificationQuestion] = useState<string | null>(null);
  const [clarificationAlternatives, setClarificationAlternatives] = useState<ParseAlternative[]>([]);
  const [selectedAlternativeIndex, setSelectedAlternativeIndex] = useState(0);
  const [confidence, setConfidence] = useState(1);
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [isClipboardText, setIsClipboardText] = useState(false);
  const [parseProgressMessage, setParseProgressMessage] = useState<string | null>(null);
  const [deterministicPreflight, setDeterministicPreflight] = useState(false);
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceTimeoutRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const verificationAbortControllerRef = useRef<AbortController | null>(null);
  const selectionTouchedRef = useRef(false);
  const progressTimeoutsRef = useRef<number[]>([]);

  const clearProgressTimers = () => {
    for (const timeoutId of progressTimeoutsRef.current) {
      clearTimeout(timeoutId);
    }
    progressTimeoutsRef.current = [];
  };

  const startBackendProgress = (hasLocalEstimate: boolean) => {
    clearProgressTimers();
    setParseProgressMessage(hasLocalEstimate ? 'Checking' : 'APIing');
    progressTimeoutsRef.current = [
      window.setTimeout(() => setParseProgressMessage('Mathing'), 1500),
      window.setTimeout(() => setParseProgressMessage('Picking'), 3600),
      window.setTimeout(() => setParseProgressMessage('Still churning'), 6500),
    ];
  };

  // Initialize and load clipboard content. Re-run when Rust reports a fresh overlay open.
  useEffect(() => {
    const initialize = async () => {
      try {
        // Initialize stats database
        await initStats();

        try {
          const settings = await invoke<AppSettings>('get_settings');
          setDeterministicPreflight(settings.deterministic_preflight);
        } catch (settingsError) {
          console.log('Settings unavailable, using parser defaults:', settingsError);
        }
        
        // Load clipboard content (handle empty clipboard gracefully)
        let clipboardText = '';
        try {
          clipboardText = await readText();
        } catch (clipboardError) {
          console.log('Clipboard is empty or unavailable:', clipboardError);
          clipboardText = '';
        }
        
        if (clipboardText) {
          // Check if clipboard contains existing Discord timestamps.
          const existingRange = parseExistingTimestampRange(clipboardText);
          const existingTimestamp = existingRange === null ? parseExistingTimestamp(clipboardText) : null;
          
          if (existingRange) {
            setEpoch(null);
            setRange(existingRange);
            setInputText(clipboardText);
            setSelectedIndex(0);
          } else if (existingTimestamp) {
            // Found existing timestamp - extract epoch and set format
            setEpoch(existingTimestamp.epoch);
            setRange(null);
            setInputText(clipboardText);
            
            // Find the format index that matches the current format code
            setSelectedIndex(formatIndexForCode(existingTimestamp.formatCode));
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
  }, [openToken]);

  // Parse input text when it changes (with debounce)
  useEffect(() => {
    // Clear previous debounce timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    clearProgressTimers();

    // Cancel any ongoing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (verificationAbortControllerRef.current) {
      verificationAbortControllerRef.current.abort();
      verificationAbortControllerRef.current = null;
    }
    setVerifying(false);

    if (inputText.trim()) {
      // Check if input is already a Discord timestamp or range (no debounce needed)
      const existingRange = parseExistingTimestampRange(inputText.trim());
      const existingTimestamp = existingRange === null ? parseExistingTimestamp(inputText.trim()) : null;
      
      if (existingRange) {
        setEpoch(null);
        setRange(existingRange);
        setConfidence(1);
        setClarificationQuestion(null);
        setClarificationAlternatives([]);
        setSelectedAlternativeIndex(0);
        setGenerationId(null);
        setVerifying(false);
        setSelectedIndex(0);
        selectionTouchedRef.current = false;
        setError(null);
        setParseProgressMessage(null);
        setLoading(false);
      } else if (existingTimestamp) {
        // Already a timestamp - just update the epoch and format immediately
        setEpoch(existingTimestamp.epoch);
        setRange(null);
        setConfidence(1);
        setClarificationQuestion(null);
        setClarificationAlternatives([]);
        setSelectedAlternativeIndex(0);
        setGenerationId(null);
        setVerifying(false);
        setSelectedIndex(formatIndexForCode(existingTimestamp.formatCode));
        selectionTouchedRef.current = false;
        setError(null);
        setParseProgressMessage(null);
        setLoading(false);
      } else {
        setEpoch(null);
        setRange(null);
        setConfidence(1);
        setError(null);
        setClarificationQuestion(null);
        setClarificationAlternatives([]);
        setSelectedAlternativeIndex(0);
        setGenerationId(null);
        setVerifying(false);
        selectionTouchedRef.current = false;
        // Parse as natural language with debounce
        setLoading(true);
        setParseProgressMessage('Settling');
        debounceTimeoutRef.current = setTimeout(() => {
          parseInput(inputText.trim(), isClipboardText);
        }, 300); // 300ms debounce for faster response
      }
    } else {
      setEpoch(null);
      setRange(null);
      setError(null);
      setClarificationQuestion(null);
      setClarificationAlternatives([]);
      setSelectedAlternativeIndex(0);
      setGenerationId(null);
      setVerifying(false);
      setConfidence(1);
      setParseProgressMessage(null);
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
  }, [epoch, range, selectedIndex, loading, error, clarificationQuestion, clarificationAlternatives]); // Resize when content changes

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (verificationAbortControllerRef.current) {
        verificationAbortControllerRef.current.abort();
      }
      clearProgressTimers();
    };
  }, []);

  const parseInput = async (text: string, isFromClipboard: boolean = false) => {
    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    
    setError(null);
    setRange(null);
    setClarificationQuestion(null);
    setClarificationAlternatives([]);
    setSelectedAlternativeIndex(0);
    setGenerationId(null);
    setVerifying(false);
    setParseProgressMessage('Localing');
    
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
      
      const apiClient = await createAPIClient();
      const fallbackEpoch = apiClient || isFromClipboard ? null : parseFallback(text);
      let displayedFallback = false;
      if (fallbackEpoch) {
        setEpoch(fallbackEpoch);
        setRange(null);
        setSelectedIndex(getMostUsedFormatIndex(stats));
        setConfidence(LOCAL_FALLBACK_CONFIDENCE);
        displayedFallback = true;
      }

      // Prefer the supervised parser when available; local chrono is an offline fallback.
      let result: ParseResponse | null = null;
      let apiError: Error | null = null;
      
      if (apiClient) {
        startBackendProgress(displayedFallback);
        try {
          result = await apiClient.parseTime(text, timezone, abortController.signal, { deterministicPreflight });
          setGenerationId(result.generationId);
          console.log("API Result: ", result);
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            throw error; // Re-throw abort errors
          }
          apiError = error instanceof Error ? error : new Error('Unknown API parsing error');
          if (error instanceof TimeParserAPIError) {
            setGenerationId(error.generationId ?? null);
          }
          console.error('API parsing failed:', error);
          // Fall through to chrono-node fallback
        }
      } else {
        setParseProgressMessage(null);
      }

      // Check if request was cancelled after API call
      if (abortController.signal.aborted) {
        return;
      }
      
      if (result?.kind === 'time_range' && result.range) {
        console.log('API parsed range successfully:', result);
        setEpoch(null);
        setRange(result.range);
        setSelectedIndex(0);
        setConfidence(result.confidence);
        setClarificationQuestion(null);
        setClarificationAlternatives([]);
        setSelectedAlternativeIndex(0);
      } else if (result && typeof result.epoch === 'number') {
        console.log('API parsed successfully:', result);
        setEpoch(result.epoch);
        setRange(null);
        if (!selectionTouchedRef.current) {
          setSelectedIndex(result.suggestedFormatIndex);
        }
        setConfidence(result.confidence);
        setClarificationQuestion(null);
        setClarificationAlternatives([]);
        setSelectedAlternativeIndex(0);
        void verifyDisplayedResult(apiClient, text, timezone, result);
      } else {
        const hardParseRejection = apiError instanceof TimeParserAPIError && apiError.status === 400;
        if (displayedFallback && !hardParseRejection) {
          setConfidence(LOCAL_FALLBACK_CONFIDENCE);
        } else {
          setEpoch(null);
          setRange(null);
          setConfidence(1);
          if (isFromClipboard) {
            setError(null);
          } else if (apiError instanceof TimeParserAPIError && apiError.alternatives && apiError.alternatives.length > 0) {
            setClarificationQuestion(apiError.message);
            setClarificationAlternatives(apiError.alternatives);
            setSelectedAlternativeIndex(0);
            setError(null);
          } else if (apiError instanceof TimeParserUnavailableError) {
            setError(apiError.message);
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
        clearProgressTimers();
        setParseProgressMessage(null);
        setLoading(false);
      }
    }
  };

  const verifyDisplayedResult = async (apiClient: Awaited<ReturnType<typeof createAPIClient>>, text: string, timezone: string, result: ParseResponse) => {
    if (!apiClient || result.method !== 'agent+plan' || result.kind === 'time_range') {
      return;
    }

    const verificationController = new AbortController();
    verificationAbortControllerRef.current = verificationController;
    setVerifying(true);

    try {
      const verification = await apiClient.verifyParse({ text, tz: timezone, ...result }, verificationController.signal);
      if (verificationController.signal.aborted) {
        return;
      }
      if (verification.decision === 'uncertain' && verification.reasonCodes.includes('missing_openai_api_key')) {
        return;
      }
      if (verification.decision !== 'accept') {
        setEpoch(null);
        setRange(null);
        setConfidence(1);
        setError('I could not verify that timestamp. Try adding AM/PM, a date, or more context.');
        setClarificationQuestion(null);
        setClarificationAlternatives([]);
        setSelectedAlternativeIndex(0);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      console.log('Post-display verification failed:', error);
    } finally {
      if (verificationAbortControllerRef.current === verificationController) {
        verificationAbortControllerRef.current = null;
      }
      if (!verificationController.signal.aborted) {
        setVerifying(false);
      }
    }
  };

  const hasClarification = clarificationQuestion !== null && clarificationAlternatives.length > 0;
  const hasResolvedResult = epoch !== null || range !== null;
  const showLowConfidence = !loading && hasResolvedResult && confidence < 0.5;
  const statusTone = error ? 'error' : hasClarification ? 'choice' : showLowConfidence ? 'warning' : 'info';
  const hasInlineStatus = error || hasClarification || showLowConfidence;
  const isBusy = loading || verifying;
  const showVerifyingTab = isBusy && !hasClarification && !error;
  const progressText = verifying ? 'Verifying' : parseProgressMessage ?? (hasResolvedResult ? 'Checking' : 'Parsing');
  const overlayTone = error
    ? 'error'
    : hasClarification
      ? 'clarifying'
      : isBusy
        ? 'verifying'
        : showLowConfidence
          ? 'low-confidence'
          : hasResolvedResult && confidence >= 0.85
            ? 'confident'
            : hasResolvedResult
              ? 'ready'
              : 'idle';
  const footerHint = hasClarification
    ? '←→/Tab or 1-9/0 to choose • Enter to use • Esc to close'
    : verifying
      ? 'Verifying before copy • Esc to close'
    : range !== null
      ? '↑↓/Tab to choose range • Enter to copy • Esc to close'
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
    if (alternative.kind === 'time_range' && alternative.range) {
      setEpoch(null);
      setRange(alternative.range);
      setSelectedIndex(0);
    } else {
      setEpoch(alternative.epoch);
      setRange(null);
      setSelectedIndex(alternative.suggestedFormatIndex);
    }
    setConfidence(alternative.confidence);
    setError(null);
    setClarificationQuestion(null);
    setClarificationAlternatives([]);
    setSelectedAlternativeIndex(0);
  };

  const recordParserOutcome = async (action: 'copied' | 'dismissed') => {
    if (generationId === null) {
      return;
    }
    try {
      const apiClient = await createAPIClient();
      await apiClient?.recordOutcome({ generationId, action, selectedFormatIndex: selectedIndex });
    } catch (error) {
      console.log('Parser outcome logging failed:', error);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const formatCount = range !== null ? rangeFormats.length : formats.length;

    if (e.key === 'Escape') {
      void recordParserOutcome('dismissed');
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
      } else {
        const alternativeIndex = clarificationIndexForKey(e.key);
        if (alternativeIndex === null) {
          return;
        }
        const alternative = clarificationAlternatives[alternativeIndex];
        if (alternative) {
          e.preventDefault();
          handleClarificationAlternative(alternative);
        }
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (hasResolvedResult) {
        handleCopy();
      }
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      selectionTouchedRef.current = true;
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : formatCount - 1));
    } else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      selectionTouchedRef.current = true;
      setSelectedIndex((prev) => (prev < formatCount - 1 ? prev + 1 : 0));
    }
  };

  const handleCopy = async () => {
    if (verifying) {
      return;
    }

    if (range !== null) {
      try {
        await writeText(formatDiscordRange(range, selectedIndex));
        void recordParserOutcome('copied');
        onClose();
      } catch (error) {
        console.error('Error copying range:', error);
      }
      return;
    }

    if (epoch !== null) {
      try {
        const discordCode = `<t:${epoch}${formats[selectedIndex].code}>`;
        await writeText(discordCode);
        await incrementFormatUsage(selectedIndex);
        void recordParserOutcome('copied');
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
      setRange(null);
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
        {range !== null && !hasClarification && (
          <div className="found-time-card" aria-live="polite">
            <div className="found-time-value">{getRangeLabel(range, selectedIndex)}</div>
          </div>
        )}
        {epoch !== null && range === null && !hasClarification && (
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
                <div className="clarification-help">Use ←/→, Tab, or number keys to choose, then Enter.</div>
                <div className="clarification-options">
                  {clarificationAlternatives.map((alternative, index) => (
                    <button
                      key={`${alternative.label}-${alternative.range?.start.epoch ?? alternative.epoch}-${alternative.range?.end.epoch ?? 'instant'}`}
                      type="button"
                      className={`clarification-option ${index === selectedAlternativeIndex ? 'selected' : ''}`}
                      aria-pressed={index === selectedAlternativeIndex}
                      onClick={() => handleClarificationAlternative(alternative)}
                      onFocus={() => setSelectedAlternativeIndex(index)}
                      onMouseEnter={() => setSelectedAlternativeIndex(index)}
                    >
                      <span className="clarification-key">{clarificationKeyLabel(index)}</span>
                      <span className="clarification-label">{alternative.label}</span>
                      <span className="clarification-preview">{alternative.range ? getRangeLabel(alternative.range) : getFormatLabel(alternative.epoch, alternative.suggestedFormatIndex)}</span>
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

      {epoch !== null && range === null && (
        <div className="results-section">
          <div className="format-list">
            {formats.map((_, index) => (
              <Row
                key={index}
                epoch={epoch}
                formatIndex={index}
                isSelected={index === selectedIndex}
                isTentative={isBusy && index === selectedIndex}
                onCopyAndClose={handleCopy}
                onMouseEnter={() => handleRowMouseEnter(index)}
              />
            ))}
          </div>
        </div>
      )}

      {range !== null && (
        <div className="results-section">
          <div className="format-list">
            {rangeFormats.map((_, index) => (
              <RangeRow
                key={index}
                range={range}
                formatIndex={index}
                isSelected={index === selectedIndex}
                isTentative={isBusy && index === selectedIndex}
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
            <span className="verifying-label">{progressText}</span>
          </div>
        </div>
        <span className="hint">{footerHint}</span>
      </div>
    </div>
  );
}
