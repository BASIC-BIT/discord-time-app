import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrentWindow, LogicalSize, currentMonitor, PhysicalPosition } from '@tauri-apps/api/window';
import { ManualDateTimePicker } from './ManualDateTimePicker';
import { seedManualDraft, type ManualDraft, type InstantChoice } from '../lib/manualDateTime';
import { Row } from './Row';
import { RangeRow } from './RangeRow';
import { formatDiscordRange, formats, getFormatLabel, getRangeLabel, rangeFormats } from '../lib/formats';
import { getUserTimezone } from '../lib/prompt';
import { createAPIClient, TimeParserAPIError, TimeParserTimeoutError, TimeParserUnavailableError, type ParseAlternative, type ParseRangeResult, type ParseResponse } from '../lib/api-client';
import { parseFallback } from '../lib/parse';
import { getFormatStats, incrementFormatUsage, getMostUsedFormatIndex, initStats } from '../lib/stats';
import {
  classifyDiscordTimestampInput,
  type DiscordTimestampClassification,
} from '@hammer-overlay/discord-timestamp-routing';

const LOCAL_FALLBACK_CONFIDENCE = 0.65;

interface AppSettings {
  deterministic_preflight: boolean;
  discord_reference_routing: boolean;
  discord_reference_shadow: boolean;
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
function formatIndexForCode(formatCode: string): number {
  const formatIndex = formats.findIndex(f => f.code === formatCode);
  return formatIndex >= 0 ? formatIndex : 0;
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

function directInstantFromClassification(classification: DiscordTimestampClassification): { epoch: number; formatCode: string } | null {
  if (classification.route !== 'direct_instant' && classification.route !== 'copied_prose') {
    return null;
  }
  const reference = classification.references[0];
  return reference === undefined ? null : {
    epoch: reference.epochSeconds,
    formatCode: reference.formatCode,
  };
}

function directRangeFromClassification(classification: DiscordTimestampClassification): ParseRangeResult | null {
  if (classification.route !== 'direct_range') {
    return null;
  }
  const startReference = classification.references[0];
  const endReference = classification.references[1];
  if (startReference === undefined || endReference === undefined) {
    return null;
  }

  const timeZone = getUserTimezone();
  return {
    start: buildDiscordRangeEndpoint(startReference.epochSeconds, startReference.formatCode, timeZone),
    end: buildDiscordRangeEndpoint(endReference.epochSeconds, endReference.formatCode, timeZone),
    discord: `<t:${startReference.epochSeconds}${startReference.formatCode}> - <t:${endReference.epochSeconds}${endReference.formatCode}>`,
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
  const [discordReferenceRouting, setDiscordReferenceRouting] = useState(true);
  const [discordReferenceShadow, setDiscordReferenceShadow] = useState(false);
  const [endpointWarming, setEndpointWarming] = useState(false);
  
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState<ManualDraft | null>(null);
  const [parseRequest, setParseRequest] = useState(0);
  const revisionRef = useRef(0);
  const ownershipRef = useRef<'text' | 'editor' | 'manual'>('text');
  const resumeTextRef = useRef(false);
  const editorOpenerRef = useRef<HTMLElement | null>(null);
  const restoreOpenerRef = useRef(false);
  const focusResultRef = useRef(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceTimeoutRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const verificationAbortControllerRef = useRef<AbortController | null>(null);
  const copiedEpochRef = useRef<number | null>(null);
  const selectionTouchedRef = useRef(false);
  const progressTimeoutsRef = useRef<number[]>([]);
  // Text whose result came back deterministic because the hosted endpoint was still waking.
  const warmingTextRef = useRef<string | null>(null);
  const latestRef = useRef({ inputText, loading, verifying });
  latestRef.current = { inputText, loading, verifying };

  const clearProgressTimers = () => {
    for (const timeoutId of progressTimeoutsRef.current) {
      clearTimeout(timeoutId);
    }
    progressTimeoutsRef.current = [];
  };

  const invalidateWork = () => {
    revisionRef.current += 1;
    if (debounceTimeoutRef.current !== null) window.clearTimeout(debounceTimeoutRef.current);
    debounceTimeoutRef.current = null;
    abortControllerRef.current?.abort();
    verificationAbortControllerRef.current?.abort();
    clearProgressTimers();
    return revisionRef.current;
  };

  const startBackendProgress = (hasLocalEstimate: boolean, revision: number) => {
    clearProgressTimers();
    setParseProgressMessage(hasLocalEstimate ? 'Checking' : 'APIing');
    progressTimeoutsRef.current = [
      window.setTimeout(() => { if (revisionRef.current === revision) setParseProgressMessage('Mathing'); }, 1500),
      window.setTimeout(() => { if (revisionRef.current === revision) setParseProgressMessage('Picking'); }, 3600),
      window.setTimeout(() => { if (revisionRef.current === revision) setParseProgressMessage('Still working safely'); }, 5000),
    ];
  };

  const recordClientRoute = async (
    classification: DiscordTimestampClassification,
    clientGenerationId: string,
    finalStatus: 'resolved' | 'failed',
    finalEpoch: number | undefined,
    totalDurationMs: number,
  ) => {
    try {
      const apiClient = await createAPIClient();
      await apiClient?.recordClientRoute({
        generationId: clientGenerationId,
        classifierVersion: classification.version,
        route: classification.route,
        reason: classification.reason,
        referenceCount: classification.references.length,
        malformedCount: classification.malformedCount,
        contextClass: classification.contextClass,
        inputLengthBucket: classification.inputLengthBucket,
        finalStatus,
        finalMethod: 'client_deterministic',
        ...(finalEpoch === undefined ? {} : { finalEpoch }),
        totalDurationMs,
        timeZone: getUserTimezone(),
        shadow: discordReferenceShadow,
        legacyFirstMatchWouldResolve: classification.references.length > 0,
        legacyFirstMatchWouldDiffer: classification.references.length > 0 && (
          finalStatus !== 'resolved'
          || classification.route === 'direct_range'
          || finalEpoch !== classification.references[0]?.epochSeconds
        ),
      });
    } catch (telemetryError) {
      console.log('Client route telemetry failed:', telemetryError);
    }
  };

  // Initialize and load clipboard content. Re-run when Rust reports a fresh overlay open.
  useEffect(() => {
    const revision = invalidateWork();
    ownershipRef.current = 'text';
    setDraft(null);
    setManual(false);
    setInputText('');
    setIsClipboardText(false);
    setParseRequest(value => value + 1);
    let focusTimer: number | undefined;
    const active = () => revisionRef.current === revision;
    const initialize = async () => {
      try {
        // Initialize stats database
        await initStats();
        if (!active()) return;

        try {
          const settings = await invoke<AppSettings>('get_settings');
          if (!active()) return;
          setDeterministicPreflight(settings.deterministic_preflight);
          setDiscordReferenceRouting(settings.discord_reference_routing);
          setDiscordReferenceShadow(settings.discord_reference_shadow);
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
        
        if (!active()) return;
        setInputText(clipboardText);
        setIsClipboardText(Boolean(clipboardText));
        setParseRequest(value => value + 1);
        
        // Focus the window
        const appWindow = getCurrentWindow();
        try {
          await appWindow.setFocus();
        } catch (error) {
          console.error('Error focusing window:', error);
        }
        
        // Then focus the textarea after a short delay
        if (!active()) return;
        focusTimer = window.setTimeout(() => {
          if (active() && textareaRef.current) {
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
    
    void initialize();
    return () => {
      window.clearTimeout(focusTimer);
      invalidateWork();
    };
  }, [openToken]);

  // Parse input text when it changes (with debounce)
  useEffect(() => {
    if (ownershipRef.current !== 'text') return;
    const revision = revisionRef.current;
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
      const classificationStartedAt = performance.now();
      const referenceRouting = classifyDiscordTimestampInput(inputText.trim());
      const classificationDurationMs = Math.max(0, performance.now() - classificationStartedAt);
      const directRange = discordReferenceRouting ? directRangeFromClassification(referenceRouting) : null;
      const directInstant = discordReferenceRouting && directRange === null
        ? directInstantFromClassification(referenceRouting)
        : null;
      const directReject = discordReferenceRouting && referenceRouting.route === 'reject';
      
      if (directReject) {
        const clientGenerationId = `tp_client_${crypto.randomUUID()}`;
        setEpoch(null);
        setRange(null);
        setConfidence(1);
        setClarificationQuestion(null);
        setClarificationAlternatives([]);
        setSelectedAlternativeIndex(0);
        setGenerationId(clientGenerationId);
        setVerifying(false);
        selectionTouchedRef.current = false;
        setError(referenceRouting.reason === 'malformed_timestamp_syntax'
          ? 'That Discord timestamp is malformed or outside the supported range.'
          : 'That paste is too long to interpret safely. Paste only the relevant timestamp sentence.');
        setParseProgressMessage(null);
        setLoading(false);
        void recordClientRoute(referenceRouting, clientGenerationId, 'failed', undefined, classificationDurationMs);
      } else if (directRange) {
        setEpoch(null);
        setRange(directRange);
        setConfidence(1);
        setClarificationQuestion(null);
        setClarificationAlternatives([]);
        setSelectedAlternativeIndex(0);
        const clientGenerationId = `tp_client_${crypto.randomUUID()}`;
        setGenerationId(clientGenerationId);
        setVerifying(false);
        setSelectedIndex(0);
        selectionTouchedRef.current = false;
        setError(null);
        setParseProgressMessage(null);
        setLoading(false);
        void recordClientRoute(referenceRouting, clientGenerationId, 'resolved', directRange.start.epoch, classificationDurationMs);
      } else if (directInstant) {
        setEpoch(directInstant.epoch);
        setRange(null);
        setConfidence(1);
        setClarificationQuestion(null);
        setClarificationAlternatives([]);
        setSelectedAlternativeIndex(0);
        const clientGenerationId = `tp_client_${crypto.randomUUID()}`;
        setGenerationId(clientGenerationId);
        setVerifying(false);
        setSelectedIndex(formatIndexForCode(directInstant.formatCode));
        selectionTouchedRef.current = false;
        setError(null);
        setParseProgressMessage(null);
        setLoading(false);
        void recordClientRoute(referenceRouting, clientGenerationId, 'resolved', directInstant.epoch, classificationDurationMs);
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
        const debounceMs = 300;
        debounceTimeoutRef.current = window.setTimeout(() => {
          if (revisionRef.current === revision) void parseInput(inputText.trim(), isClipboardText, revision);
        }, debounceMs);
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
  }, [inputText, discordReferenceRouting, discordReferenceShadow, parseRequest]);

  // Observe editor validation as well as result changes, and fit the physical desktop.
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const element = overlayRef.current;
    if (appWindow.label !== 'main' || !element) return;
    let disposed = false;
    let timer: number | undefined;
    const resize = () => {
      window.clearTimeout(timer);
      const revision = revisionRef.current;
      timer = window.setTimeout(async () => {
        const active = () => !disposed && revisionRef.current === revision;
        try {
          const monitor = await currentMonitor();
          if (!active()) return;
          const scale = monitor?.scaleFactor ?? 1;
          const maxHeight = monitor ? monitor.size.height / scale - 32 : window.screen.availHeight - 32;
          element.style.maxHeight = `${maxHeight - 2}px`;
          const height = Math.min(maxHeight, Math.max(100, element.scrollHeight + 2));
          await appWindow.setSize(new LogicalSize(480, height));
          if (!active() || !monitor) return;
          const position = await appWindow.outerPosition();
          if (!active()) return;
          const x = Math.max(monitor.position.x, Math.min(position.x, monitor.position.x + monitor.size.width - 480 * scale));
          const y = Math.max(monitor.position.y, Math.min(position.y, monitor.position.y + monitor.size.height - height * scale));
          if (x !== position.x || y !== position.y) await appWindow.setPosition(new PhysicalPosition(x, y));
        } catch (resizeError) {
          if (active()) console.error('Error resizing window:', resizeError);
        }
      }, 0);
    };
    const observer = new ResizeObserver(resize);
    for (const child of element.children) observer.observe(child);
    resize();
    return () => { disposed = true; window.clearTimeout(timer); observer.disconnect(); };
  }, [draft !== null, epoch, range, loading, error, clarificationQuestion, clarificationAlternatives]);

  useEffect(() => {
    if (draft === null && restoreOpenerRef.current) {
      restoreOpenerRef.current = false;
      const selector = editorOpenerRef.current?.classList.contains('edit-result') ? '.edit-result' : '.calendar-button';
      overlayRef.current?.querySelector<HTMLElement>(selector)?.focus();
    }
    if (draft === null && focusResultRef.current) {
      focusResultRef.current = false;
      overlayRef.current?.querySelector<HTMLElement>('.row.selected')?.focus();
    }
  }, [draft, epoch]);

  useEffect(() => {
    if (document.activeElement?.classList.contains('row')) {
      overlayRef.current?.querySelector<HTMLElement>('.row.selected')?.focus();
    }
  }, [selectedIndex]);

  // Ask once per open whether the hosted endpoint is still waking.
  useEffect(() => {
    let disposed = false;
    void (async () => {
      const status = await (await createAPIClient())?.getPlanIrEndpointStatus();
      if (!disposed && status?.warmupEnabled && status.state !== 'ready') setEndpointWarming(true);
    })();
    return () => { disposed = true; };
  }, [openToken]);

  // While warming, poll; once ready, re-run the untouched, uncopied text so the model result lands.
  useEffect(() => {
    if (!endpointWarming) return;
    const controller = new AbortController();
    const poll = async () => {
      const status = await (await createAPIClient())?.getPlanIrEndpointStatus(controller.signal);
      if (controller.signal.aborted || !status) return;
      if (!status.warmupEnabled || status.state === 'disabled') {
        setEndpointWarming(false);
        return;
      }
      if (status.state !== 'ready') return;
      setEndpointWarming(false);
      const flaggedText = warmingTextRef.current;
      warmingTextRef.current = null;
      const current = latestRef.current;
      const text = current.inputText.trim();
      if (text && text === flaggedText && !current.loading && !current.verifying
        && copiedEpochRef.current === null && ownershipRef.current === 'text') {
        invalidateWork();
        setParseRequest(value => value + 1);
      }
    };
    const intervalId = window.setInterval(() => void poll(), 2500);
    return () => { controller.abort(); window.clearInterval(intervalId); };
  }, [endpointWarming]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      invalidateWork();
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

  const parseInput = async (text: string, isFromClipboard: boolean, revision: number) => {
    if (revisionRef.current !== revision) return;
    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const active = () => revisionRef.current === revision && !abortController.signal.aborted;
    
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
      if (!active()) {
        return;
      }

      // Get format stats for LLM context
      const stats = await getFormatStats();
      const timezone = getUserTimezone();
      
      // Check again if request was cancelled
      if (!active()) {
        return;
      }
      
      const apiClient = await createAPIClient();
      if (!active()) return;
      const referenceRouting = classifyDiscordTimestampInput(text);
      const hasDiscordReference = referenceRouting.references.length > 0 || referenceRouting.malformedCount > 0;
      const fallbackEpoch = apiClient || isFromClipboard || hasDiscordReference ? null : parseFallback(text);
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
        startBackendProgress(displayedFallback, revision);
        try {
          result = await apiClient.parseTime(text, timezone, abortController.signal, {
            requestId: crypto.randomUUID(),
            deterministicPreflight,
            discordReferenceRouting,
            discordReferenceShadow,
          });
          if (!active()) return;
          setGenerationId(result.generationId);
          if (result.debug?.endpointWarming === true) {
            warmingTextRef.current = text;
            setEndpointWarming(true);
          }
          console.log("API Result: ", result);
        } catch (error) {
          if (!active()) return;
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
      if (!active()) {
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
        void verifyDisplayedResult(apiClient, text, timezone, result, revision);
      } else {
        const hardParseRejection = apiError instanceof TimeParserAPIError && apiError.status === 400;
        if (displayedFallback && !hardParseRejection) {
          setConfidence(LOCAL_FALLBACK_CONFIDENCE);
        } else {
          setEpoch(null);
          setRange(null);
          setConfidence(1);
          if (isFromClipboard && !hasDiscordReference) {
            setError(null);
          } else if (apiError instanceof TimeParserAPIError && apiError.code === 'needs_clarification') {
            setClarificationQuestion(apiError.message);
            setClarificationAlternatives(apiError.alternatives ?? []);
            setSelectedAlternativeIndex(0);
            setError(null);
          } else if (apiError instanceof TimeParserUnavailableError || apiError instanceof TimeParserTimeoutError) {
            setError(apiError.message);
          } else {
            setError(apiError?.message ?? 'Could not understand that time expression. Try being more specific like "Jan 15 at 3pm" or "in 2 hours".');
          }
        }
      }
    } catch (error) {
      if (!active()) return;
      // Don't show errors for aborted requests
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Parsing request aborted');
        return;
      }
      
      console.error('Error parsing input:', error);
      setError('Something went wrong. Please try again or check your internet connection.');
    } finally {
      // Only set loading to false if this request wasn't aborted
      if (active()) {
        clearProgressTimers();
        setParseProgressMessage(null);
        setLoading(false);
      }
    }
  };

  const verifyDisplayedResult = async (apiClient: Awaited<ReturnType<typeof createAPIClient>>, text: string, timezone: string, result: ParseResponse, revision: number) => {
    if (revisionRef.current !== revision || !apiClient || result.method !== 'agent+plan' || result.kind === 'time_range') {
      return;
    }

    const verificationController = new AbortController();
    verificationAbortControllerRef.current = verificationController;
    const active = () => revisionRef.current === revision && !verificationController.signal.aborted;
    setVerifying(true);

    try {
      const verification = await apiClient.verifyParse({ text, tz: timezone, ...result }, verificationController.signal);
      if (verification.decision === 'uncertain' && verification.reasonCodes.includes('missing_openai_api_key')) {
        return;
      }
      if (copiedEpochRef.current === result.epoch) {
        // Copied before the verdict landed; the overlay is already closed, so warn out of band.
        if (verification.decision !== 'accept') {
          try {
            sendNotification({ title: 'HammerOverlay', body: 'Heads up: that timestamp did not verify. Check it before sending.' });
          } catch (notifyError) {
            console.log('Verification toast failed:', notifyError);
          }
        }
        return;
      }
      if (!active()) {
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
      if (!active()) return;
      console.log('Post-display verification failed:', error);
    } finally {
      if (verificationAbortControllerRef.current === verificationController) {
        verificationAbortControllerRef.current = null;
      }
      if (active()) {
        setVerifying(false);
      }
    }
  };

  const hasClarification = clarificationQuestion !== null;
  const hasSelectableClarification = hasClarification && clarificationAlternatives.length > 0;
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
  const footerHint = draft !== null ? 'Tab to move • Enter to use date/time • Esc to cancel' : hasSelectableClarification
    ? '←→/Tab or 1-9/0 to choose • Enter to use • Esc to close'
    : hasClarification
      ? 'Edit the expression to clarify • Esc to close'
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

  const recordParserOutcome = async (action: 'copied' | 'dismissed', formatIndex = selectedIndex) => {
    if (generationId === null) {
      return;
    }
    try {
      const apiClient = await createAPIClient();
      await apiClient?.recordOutcome({ generationId, action, selectedFormatIndex: formatIndex });
    } catch (error) {
      console.log('Parser outcome logging failed:', error);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (draft !== null) {
      if (e.key === 'Escape') { e.preventDefault(); cancelEditor(); }
      return;
    }
    // Ordinary actions keep native keys; clarification options retain their advertised shortcuts.
    if (e.target instanceof HTMLButtonElement && !e.target.classList.contains('clarification-option') && e.key !== 'Escape') return;
    const formatCount = range !== null ? rangeFormats.length : formats.length;
    // Tab traverses formats, then leaves the group at either end; arrows still wrap.
    const onResult = e.target instanceof HTMLElement && e.target.classList.contains('row');
    if (e.key === 'Tab' && onResult && (
      (e.shiftKey && selectedIndex === 0) || (!e.shiftKey && selectedIndex === formatCount - 1)
    )) return;

    if (e.key === 'Escape') {
      // Consume before hiding: WebKitGTK can otherwise replay this key after unmap
      // and discard the first keydown on the next open.
      e.preventDefault();
      void recordParserOutcome('dismissed');
      onClose();
    } else if (hasSelectableClarification) {
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
    } else if (hasClarification) {
      return;
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (hasResolvedResult) {
        handleCopy();
      }
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey && e.target instanceof HTMLElement && e.target.classList.contains('row'))) {
      e.preventDefault();
      selectionTouchedRef.current = true;
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : formatCount - 1));
    } else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey && e.target instanceof HTMLElement && e.target.classList.contains('row'))) {
      e.preventDefault();
      selectionTouchedRef.current = true;
      setSelectedIndex((prev) => (prev < formatCount - 1 ? prev + 1 : 0));
    }
  };

  const handleCopy = async (formatIndex = selectedIndex) => {
    const revision = revisionRef.current;
    if (ownershipRef.current === 'editor') {
      return;
    }

    if (range !== null) {
      try {
        await writeText(formatDiscordRange(range, formatIndex));
        if (revisionRef.current !== revision) return;
        void recordParserOutcome('copied', formatIndex);
        onClose();
      } catch (error) {
        console.error('Error copying range:', error);
      }
      return;
    }

    if (epoch !== null) {
      try {
        const discordCode = `<t:${epoch}${formats[formatIndex].code}>`;
        await writeText(discordCode);
        if (revisionRef.current !== revision) return;
        await incrementFormatUsage(formatIndex);
        if (revisionRef.current !== revision) return;
        void recordParserOutcome('copied', formatIndex);
        // Let an in-flight verification outlive the overlay: unmount cleanup aborts whatever this ref holds.
        copiedEpochRef.current = epoch;
        verificationAbortControllerRef.current = null;
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
    invalidateWork();
    ownershipRef.current = 'text';
    setManual(false);
    const newValue = e.target.value;
    
    // A real edit ends clipboard ownership; the browser already applied the edit.
    if (isClipboardText && newValue !== inputText) {
      setIsClipboardText(false);
      setRange(null);
      setClarificationQuestion(null);
      setClarificationAlternatives([]);
      setSelectedAlternativeIndex(0);
    }
    setInputText(newValue);
  };

  const openEditor = (opener: HTMLElement) => {
    editorOpenerRef.current = opener;
    resumeTextRef.current = ownershipRef.current === 'text' && (loading || verifying);
    invalidateWork();
    ownershipRef.current = 'editor';
    setLoading(false);
    setVerifying(false);
    setParseProgressMessage(null);
    setDraft(seedManualDraft({ epochSeconds: epoch, now: new Date(), timeZone: getUserTimezone() }));
  };

  const cancelEditor = () => {
    invalidateWork();
    ownershipRef.current = manual ? 'manual' : 'text';
    setDraft(null);
    restoreOpenerRef.current = true;
    if (resumeTextRef.current) setParseRequest(value => value + 1);
    resumeTextRef.current = false;
  };

  const applyManual = (choice: InstantChoice) => {
    invalidateWork();
    ownershipRef.current = 'manual';
    setManual(true);
    if (epoch === null) setSelectedIndex(formatIndexForCode(':f'));
    setEpoch(choice.epochSeconds);
    setRange(null);
    setGenerationId(null);
    setConfidence(1);
    setError(null);
    setClarificationQuestion(null);
    setClarificationAlternatives([]);
    setLoading(false);
    setVerifying(false);
    setParseProgressMessage(null);
    selectionTouchedRef.current = true;
    focusResultRef.current = true;
    resumeTextRef.current = false;
    setDraft(null);
  };

  const useText = () => {
    invalidateWork();
    ownershipRef.current = 'text';
    setManual(false);
    setParseRequest(value => value + 1);
    textareaRef.current?.focus();
  };

  return (
    <div ref={overlayRef} className={`overlay ${overlayTone}`} onKeyDown={handleKeyDown} tabIndex={-1}>
      <div className="input-section">
        <div className="input-controls">
        <textarea
          ref={textareaRef}
          disabled={draft !== null}
          aria-label="Time expression"
          value={inputText}
          onChange={handleInputChange}
          placeholder="Enter date/time (e.g., 'tomorrow at 2pm', 'next Friday')"
          className="input-textarea"
          rows={2}
        />
        <button className="calendar-button" type="button" aria-label="Choose date and time"
          aria-expanded={draft !== null} aria-controls="manual-picker" disabled={draft !== null}
          onClick={event => openEditor(event.currentTarget)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M7 15h3M14 15h3"/></svg>
        </button>
        </div>
        {draft !== null && <div id="manual-picker"><ManualDateTimePicker initialDraft={draft} onApply={applyManual} onCancel={cancelEditor} /></div>}
        {range !== null && draft === null && !hasClarification && (
          <div className="found-time-card" aria-live="polite">
            <div className="found-time-value">{getRangeLabel(range, selectedIndex)}</div>
          </div>
        )}
        {epoch !== null && range === null && draft === null && !hasClarification && (
          <div className="result-heading">
            <button type="button" className="found-time-card edit-result" aria-label="Edit date and time"
              onClick={event => openEditor(event.currentTarget)}>
              <span className="found-time-value">{getFormatLabel(epoch, 5)}</span>
              <span className="edit-result-hint">Edit</span>
            </button>
            {manual && <div className="manual-provenance"><span className="manual-label">Manual</span><button type="button" onClick={useText}>Use text</button></div>}
          </div>
        )}
        {draft === null && hasInlineStatus && (
          <div className={`status-card ${statusTone}`}>
            {error && <div className="status-line">{error}</div>}
            {hasClarification && (
              <div className="clarification">
                <div className="clarification-title">{clarificationQuestion}</div>
                {hasSelectableClarification ? (
                  <>
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
                  </>
                ) : (
                  <div className="clarification-help">Add the missing detail in the expression above.</div>
                )}
              </div>
            )}
            {showLowConfidence && (
              <div className="status-line">Low confidence. Check the timestamp before copying.</div>
            )}
          </div>
        )}
      </div>

      {draft === null && epoch !== null && range === null && (
        <div className="results-section">
          <div className="format-list">
            {formats.map((_, index) => (
              <Row
                key={index}
                epoch={epoch}
                formatIndex={index}
                isSelected={index === selectedIndex}
                isTentative={isBusy && index === selectedIndex}
                onCopyAndClose={() => handleCopy(index)}
                onMouseEnter={() => handleRowMouseEnter(index)}
              />
            ))}
          </div>
        </div>
      )}

      {draft === null && range !== null && (
        <div className="results-section">
          <div className="format-list">
            {rangeFormats.map((_, index) => (
              <RangeRow
                key={index}
                range={range}
                formatIndex={index}
                isSelected={index === selectedIndex}
                isTentative={isBusy && index === selectedIndex}
                onCopyAndClose={() => handleCopy(index)}
                onMouseEnter={() => handleRowMouseEnter(index)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="footer">
        <div className="footer-status-slot" aria-live="polite">
          <div className={`verifying-tab ${showVerifyingTab && !endpointWarming ? 'visible' : ''}`}>
            <span className="progress-dot" />
            <span className="verifying-label">{progressText}</span>
          </div>
          <div className={`warming-notice ${endpointWarming ? 'visible' : ''}`}>
            Smart parsing is warming up, usually under a minute. Showing basic results meanwhile.
          </div>
        </div>
        <span className="hint">{footerHint}</span>
      </div>
    </div>
  );
}
