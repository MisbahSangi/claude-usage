const WIDGET_ID = 'cup-v4-widget';
const TOKENS_LINE_ID = 'cup-v4-tokens';
const CONFIDENCE_SELECTOR = '.cup-widget__confidence';
const INTERCEPTOR_SOURCE = 'cup-interceptor';
const INTERCEPTOR_TYPE = 'CLAUDE_API_DATA';
const URL_IGNORE_PATTERNS = ['/sync/settings', 'datadog', '/analytics', '/telemetry'] as const;
const URL_ACCEPT_PATTERNS = ['/messages', '/chat', '/completion', '/conversations', '/attachments'] as const;
const CONTEXT_INVALIDATED_WARNING = '[CUP] context invalidated, stopping observers';
const API_TOKEN_FRESH_MS = 10 * 60 * 1000;
// CUP_PHASE_C_START
const CUP_DEBUG = true;
const PHASE_C_UI_THROTTLE_MS = 200;
const METRICS_STALE_MS = 30 * 60 * 1000;
const CUP_METRICS_STORAGE_KEY = 'cupMetricsState';

type CupMetricsState = {
  conversationTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  sessionPercent: number | null;
  weeklyPercent: number | null;
  cacheSecondsRemaining: number | null;
  lastUpdatedAt: number | null;
  sourceUrl: string | null;
  stale: boolean;
};

type CupMetricKey =
  | 'conversationTokens'
  | 'inputTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'sessionPercent'
  | 'weeklyPercent'
  | 'cacheSecondsRemaining';

type CupMetricExtraction = {
  values: Partial<Record<CupMetricKey, number>>;
  matchedPaths: Partial<Record<CupMetricKey, string>>;
};

type CupHydrationDebug = {
  found: boolean;
  stale: boolean;
  lastUpdatedAt: number | null;
  metricsSnapshot: CupMetricsState | null;
};

const CUP_METRIC_KEYS: readonly CupMetricKey[] = [
  'conversationTokens',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'sessionPercent',
  'weeklyPercent',
  'cacheSecondsRemaining',
];

const CUP_METRIC_CANDIDATE_PATHS: Record<CupMetricKey, readonly (readonly string[])[]> = {
  conversationTokens: [
    ['usage', 'conversation_tokens'],
    ['message', 'usage', 'conversation_tokens'],
    ['conversation', 'tokens'],
  ],
  inputTokens: [
    ['usage', 'input_tokens'],
    ['message', 'usage', 'input_tokens'],
    ['usage', 'prompt_tokens'],
    ['message', 'usage', 'prompt_tokens'],
  ],
  outputTokens: [
    ['usage', 'output_tokens'],
    ['message', 'usage', 'output_tokens'],
    ['usage', 'completion_tokens'],
    ['message', 'usage', 'completion_tokens'],
  ],
  totalTokens: [
    ['usage', 'total_tokens'],
    ['message', 'usage', 'total_tokens'],
    ['usage', 'tokens'],
  ],
  sessionPercent: [
    ['usage', 'session_percent'],
    ['limits', 'session', 'percent'],
    ['session', 'percent'],
  ],
  weeklyPercent: [
    ['usage', 'weekly_percent'],
    ['limits', 'weekly', 'percent'],
    ['weekly', 'percent'],
  ],
  cacheSecondsRemaining: [
    ['usage', 'cache_seconds_remaining'],
    ['cache', 'seconds_remaining'],
    ['limits', 'cache_seconds_remaining'],
  ],
};
// CUP_PHASE_C_END

type StorageResult = Record<string, unknown>;
type StorageListener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void;
type MessageListener = (event: MessageEvent) => void;
type LifecycleListener = (event: Event) => void;

type CupContentState = {
  intervalId: number | null;
  messageListener: MessageListener | null;
  storageListener: StorageListener | null;
  lifecycleListener: LifecycleListener | null;
};

type CupWindow = Window & typeof globalThis & {
  __CUP_CONTENT_INIT__?: boolean;
  __CUP_CONTENT_STATE__?: CupContentState;
};

const cupWindow = window as CupWindow;

let hasApiAssistedConfidence = false;
const loggedMessageTypes = new Set<string>();
let lastSignature = '';
let lastUiUpdate = 0;
let acceptedApiMessageCount = 0;
let lastApiTokenValue: number | null = null;
let lastApiUpdatedAt: number | null = null;
// CUP_PHASE_C_START
let cupMetricsState: CupMetricsState = {
  conversationTokens: null,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  sessionPercent: null,
  weeklyPercent: null,
  cacheSecondsRemaining: null,
  lastUpdatedAt: null,
  sourceUrl: null,
  stale: false,
};
let lastPhaseCUpdateAt = 0;
// CUP_PHASE_C_END

let refreshIntervalId: number | null = null;
let messageListenerRef: MessageListener | null = null;
let storageListenerRef: StorageListener | null = null;
let lifecycleListenerRef: LifecycleListener | null = null;
let isWorkStopped = false;
let hasWarnedContextInvalidated = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRuntimeAvailable(): boolean {
  try {
    return typeof chrome !== 'undefined' && typeof chrome.runtime?.id === 'string';
  } catch (_error) {
    return false;
  }
}

function isContextInvalidatedError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.toLowerCase().includes('context invalidated');
  }

  if (isRecord(error) && typeof error.message === 'string') {
    return error.message.toLowerCase().includes('context invalidated');
  }

  return false;
}

function warnContextInvalidatedOnce(): void {
  if (hasWarnedContextInvalidated) {
    return;
  }

  hasWarnedContextInvalidated = true;
  console.warn(CONTEXT_INVALIDATED_WARNING);
}

function updateWindowState(): void {
  if (!refreshIntervalId && !messageListenerRef && !storageListenerRef && !lifecycleListenerRef) {
    cupWindow.__CUP_CONTENT_STATE__ = undefined;
    return;
  }

  cupWindow.__CUP_CONTENT_STATE__ = {
    intervalId: refreshIntervalId,
    messageListener: messageListenerRef,
    storageListener: storageListenerRef,
    lifecycleListener: lifecycleListenerRef,
  };
}

function removeLifecycleListener(listener: LifecycleListener | null): void {
  if (!listener) {
    return;
  }

  document.removeEventListener('visibilitychange', listener);
  window.removeEventListener('pagehide', listener);
  window.removeEventListener('beforeunload', listener);
}

function safeRemoveStorageListener(listener: StorageListener | null): void {
  if (!listener) {
    return;
  }

  try {
    if (!isRuntimeAvailable()) {
      return;
    }

    chrome.storage.onChanged.removeListener(listener);
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      if (isWorkStopped) {
        warnContextInvalidatedOnce();
        return;
      }

      stopObserversForInvalidation();
    }
  }
}

function cleanupObservers(): void {
  if (refreshIntervalId !== null) {
    window.clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }

  if (messageListenerRef) {
    window.removeEventListener('message', messageListenerRef);
    messageListenerRef = null;
  }

  if (storageListenerRef) {
    safeRemoveStorageListener(storageListenerRef);
    storageListenerRef = null;
  }

  if (lifecycleListenerRef) {
    removeLifecycleListener(lifecycleListenerRef);
    lifecycleListenerRef = null;
  }

  updateWindowState();
}

function stopObserversForInvalidation(): void {
  if (isWorkStopped) {
    return;
  }

  isWorkStopped = true;
  warnContextInvalidatedOnce();
  cleanupObservers();
}

function maybeHandleContextInvalidation(error: unknown): boolean {
  if (!isRuntimeAvailable() || isContextInvalidatedError(error)) {
    stopObserversForInvalidation();
    return true;
  }

  return false;
}

function safeStorageGet(keys: string | string[] | Record<string, unknown>): Promise<StorageResult> {
  return new Promise((resolve) => {
    try {
      if (isWorkStopped || !isRuntimeAvailable()) {
        if (!isWorkStopped) {
          stopObserversForInvalidation();
        }

        resolve({});
        return;
      }

      chrome.storage.local.get(keys, (result) => {
        try {
          if (chrome.runtime.lastError && isContextInvalidatedError(chrome.runtime.lastError)) {
            stopObserversForInvalidation();
            resolve({});
            return;
          }

          resolve(isRecord(result) ? result : {});
        } catch (error) {
          if (maybeHandleContextInvalidation(error)) {
            resolve({});
            return;
          }

          resolve({});
        }
      });
    } catch (error) {
      if (maybeHandleContextInvalidation(error)) {
        resolve({});
        return;
      }

      resolve({});
    }
  });
}

function safeStorageSet(obj: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (isWorkStopped || !isRuntimeAvailable()) {
        if (!isWorkStopped) {
          stopObserversForInvalidation();
        }

        resolve();
        return;
      }

      chrome.storage.local.set(obj, () => {
        try {
          if (chrome.runtime.lastError && isContextInvalidatedError(chrome.runtime.lastError)) {
            stopObserversForInvalidation();
          }
        } catch (error) {
          maybeHandleContextInvalidation(error);
        }

        resolve();
      });
    } catch (error) {
      maybeHandleContextInvalidation(error);
      resolve();
    }
  });
}

function safeAddStorageListener(fn: StorageListener): void {
  try {
    if (isWorkStopped || !isRuntimeAvailable()) {
      if (!isWorkStopped) {
        stopObserversForInvalidation();
      }

      return;
    }

    chrome.storage.onChanged.addListener(fn);
  } catch (error) {
    maybeHandleContextInvalidation(error);
  }
}

function cleanupPreviousInstance(): void {
  const previousState = cupWindow.__CUP_CONTENT_STATE__;
  if (!previousState) {
    return;
  }

  if (previousState.intervalId !== null) {
    window.clearInterval(previousState.intervalId);
  }

  if (previousState.messageListener) {
    window.removeEventListener('message', previousState.messageListener);
  }

  if (previousState.storageListener) {
    safeRemoveStorageListener(previousState.storageListener);
  }

  if (previousState.lifecycleListener) {
    removeLifecycleListener(previousState.lifecycleListener);
  }

  cupWindow.__CUP_CONTENT_STATE__ = undefined;
  cupWindow.__CUP_CONTENT_INIT__ = false;
}

type InterceptorMessage = {
  source?: string;
  type?: string;
  url?: string;
  payload?: unknown;
};

function logMessageTypeOnce(messageType: string): void {
  if (loggedMessageTypes.has(messageType)) {
    return;
  }

  loggedMessageTypes.add(messageType);
  console.debug(`[CUP] ${messageType}`);
}

// CUP_PHASE_C_START
function getNestedPathValue(payload: unknown, path: readonly string[]): unknown {
  try {
    let cursor: unknown = payload;
    for (const segment of path) {
      if (!isRecord(cursor)) {
        return undefined;
      }

      cursor = cursor[segment];
    }

    return cursor;
  } catch (_error) {
    return undefined;
  }
}

function toFiniteMetricNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normalizePercentage(value: number): number {
  if (value < 0) {
    return 0;
  }

  if (value > 100) {
    return 100;
  }

  return value;
}

function extractPhaseCMetrics(payload: unknown): CupMetricExtraction {
  const values: Partial<Record<CupMetricKey, number>> = {};
  const matchedPaths: Partial<Record<CupMetricKey, string>> = {};

  for (const metricKey of CUP_METRIC_KEYS) {
    const candidates = CUP_METRIC_CANDIDATE_PATHS[metricKey];
    for (const candidatePath of candidates) {
      const candidateValue = getNestedPathValue(payload, candidatePath);
      const finiteValue = toFiniteMetricNumber(candidateValue);
      if (finiteValue === null) {
        continue;
      }

      const normalizedValue =
        metricKey === 'sessionPercent' || metricKey === 'weeklyPercent'
          ? normalizePercentage(finiteValue)
          : finiteValue;
      values[metricKey] = normalizedValue;
      matchedPaths[metricKey] = candidatePath.join('.');
      break;
    }
  }

  return { values, matchedPaths };
}

function hasAnyAuthoritativeMetric(state: CupMetricsState): boolean {
  return CUP_METRIC_KEYS.some((metricKey) => {
    const value = state[metricKey];
    return typeof value === 'number' && Number.isFinite(value);
  });
}

function getPrimaryAuthoritativeTokenValue(state: CupMetricsState): number | null {
  if (typeof state.totalTokens === 'number' && Number.isFinite(state.totalTokens)) {
    return Math.round(state.totalTokens);
  }

  if (typeof state.conversationTokens === 'number' && Number.isFinite(state.conversationTokens)) {
    return Math.round(state.conversationTokens);
  }

  if (
    typeof state.inputTokens === 'number' &&
    Number.isFinite(state.inputTokens) &&
    typeof state.outputTokens === 'number' &&
    Number.isFinite(state.outputTokens)
  ) {
    return Math.round(state.inputTokens + state.outputTokens);
  }

  return null;
}

function isPhaseCMetricsStale(lastUpdatedAt: number | null, now: number = Date.now()): boolean {
  if (lastUpdatedAt === null) {
    return true;
  }

  return now - lastUpdatedAt > METRICS_STALE_MS;
}

function refreshPhaseCMetricsStaleFlag(now: number = Date.now()): void {
  const stale = isPhaseCMetricsStale(cupMetricsState.lastUpdatedAt, now);
  if (cupMetricsState.stale !== stale) {
    cupMetricsState = {
      ...cupMetricsState,
      stale,
    };
  }
}

function mergePhaseCMetricsState(
  currentState: CupMetricsState,
  extractedValues: Partial<Record<CupMetricKey, number>>,
  sourceUrl: string,
  updatedAt: number,
): CupMetricsState {
  const nextState: CupMetricsState = {
    ...currentState,
    lastUpdatedAt: updatedAt,
    sourceUrl,
    stale: false,
  };

  for (const metricKey of CUP_METRIC_KEYS) {
    const nextValue = extractedValues[metricKey];
    if (typeof nextValue === 'number' && Number.isFinite(nextValue)) {
      nextState[metricKey] = nextValue;
    }
  }

  return nextState;
}

function shouldPersistPhaseCMetrics(
  previousState: CupMetricsState,
  nextState: CupMetricsState,
  matchedPaths: Partial<Record<CupMetricKey, string>>,
): boolean {
  if (Object.keys(matchedPaths).length > 0) {
    return true;
  }

  return previousState.sourceUrl !== nextState.sourceUrl || previousState.stale !== nextState.stale;
}

function persistPhaseCMetricsState(state: CupMetricsState): void {
  void safeStorageSet({
    [CUP_METRICS_STORAGE_KEY]: state,
  });
}

function parseStoredPhaseCMetricsState(rawState: unknown): CupMetricsState | null {
  if (!isRecord(rawState)) {
    return null;
  }

  const sessionPercentRaw = toFiniteMetricNumber(rawState.sessionPercent);
  const weeklyPercentRaw = toFiniteMetricNumber(rawState.weeklyPercent);
  const lastUpdatedAtRaw = toFiniteMetricNumber(rawState.lastUpdatedAt);

  const parsedState: CupMetricsState = {
    conversationTokens: toFiniteMetricNumber(rawState.conversationTokens),
    inputTokens: toFiniteMetricNumber(rawState.inputTokens),
    outputTokens: toFiniteMetricNumber(rawState.outputTokens),
    totalTokens: toFiniteMetricNumber(rawState.totalTokens),
    sessionPercent: sessionPercentRaw === null ? null : normalizePercentage(sessionPercentRaw),
    weeklyPercent: weeklyPercentRaw === null ? null : normalizePercentage(weeklyPercentRaw),
    cacheSecondsRemaining: toFiniteMetricNumber(rawState.cacheSecondsRemaining),
    lastUpdatedAt: lastUpdatedAtRaw === null ? null : Math.round(lastUpdatedAtRaw),
    sourceUrl: typeof rawState.sourceUrl === 'string' ? rawState.sourceUrl : null,
    stale: false,
  };

  parsedState.stale = isPhaseCMetricsStale(parsedState.lastUpdatedAt);

  return parsedState;
}

function hydratePhaseCMetricsState(): Promise<CupHydrationDebug> {
  return safeStorageGet(CUP_METRICS_STORAGE_KEY).then((storageResult) => {
    const storedState = parseStoredPhaseCMetricsState(storageResult[CUP_METRICS_STORAGE_KEY]);
    if (!storedState) {
      return {
        found: false,
        stale: true,
        lastUpdatedAt: null,
        metricsSnapshot: null,
      };
    }

    cupMetricsState = storedState;
    refreshPhaseCMetricsStaleFlag();

    const hasAuthoritativeMetrics = hasAnyAuthoritativeMetric(cupMetricsState);
    const hasActiveAuthoritativeMetrics = hasAuthoritativeMetrics && !cupMetricsState.stale;

    const primaryTokenValue = getPrimaryAuthoritativeTokenValue(cupMetricsState);
    if (primaryTokenValue !== null && hasActiveAuthoritativeMetrics) {
      lastApiTokenValue = primaryTokenValue;
      lastApiUpdatedAt = cupMetricsState.lastUpdatedAt;
    } else {
      lastApiTokenValue = null;
      lastApiUpdatedAt = null;
    }

    if (hasActiveAuthoritativeMetrics) {
      hasApiAssistedConfidence = true;
    } else {
      hasApiAssistedConfidence = false;
    }

    return {
      found: true,
      stale: cupMetricsState.stale,
      lastUpdatedAt: cupMetricsState.lastUpdatedAt,
      metricsSnapshot: getPhaseCMetricsSnapshot(cupMetricsState),
    };
  });
}

function getPhaseCMetricsSnapshot(state: CupMetricsState): CupMetricsState {
  return {
    conversationTokens: state.conversationTokens,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    totalTokens: state.totalTokens,
    sessionPercent: state.sessionPercent,
    weeklyPercent: state.weeklyPercent,
    cacheSecondsRemaining: state.cacheSecondsRemaining,
    lastUpdatedAt: state.lastUpdatedAt,
    sourceUrl: state.sourceUrl,
    stale: state.stale,
  };
}

function hasActiveAuthoritativeMetrics(now: number = Date.now()): boolean {
  refreshPhaseCMetricsStaleFlag(now);
  return hasAnyAuthoritativeMetric(cupMetricsState) && !cupMetricsState.stale;
}
// CUP_PHASE_C_END

function updateConfidenceLine(widget: HTMLDivElement): void {
  const confidenceLine = widget.querySelector<HTMLElement>(CONFIDENCE_SELECTOR);
  if (confidenceLine) {
    confidenceLine.textContent = hasApiAssistedConfidence
      ? 'Confidence: API-assisted'
      : 'Confidence: Estimated';
  }
}

function normalizeFinitePositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function extractApiTokenValue(payload: unknown): number | null {
  const payloadRecord = isRecord(payload) ? payload : null;
  const payloadUsage = isRecord(payloadRecord?.usage) ? payloadRecord.usage : null;
  const payloadMessage = isRecord(payloadRecord?.message) ? payloadRecord.message : null;
  const messageUsage = isRecord(payloadMessage?.usage) ? payloadMessage.usage : null;

  const tokenCandidates: unknown[] = [
    payloadUsage?.output_tokens,
    payloadUsage?.input_tokens,
    payloadUsage?.total_tokens,
    messageUsage?.output_tokens,
    messageUsage?.input_tokens,
    messageUsage?.total_tokens,
  ];

  for (const candidate of tokenCandidates) {
    const normalized = normalizeFinitePositiveNumber(candidate);
    if (normalized !== null) {
      return Math.round(normalized);
    }
  }

  return null;
}

function getFreshApiTokenValue(now: number = Date.now()): number | null {
  if (lastApiTokenValue === null || lastApiUpdatedAt === null) {
    return null;
  }

  if (now - lastApiUpdatedAt >= API_TOKEN_FRESH_MS) {
    return null;
  }

  return lastApiTokenValue;
}

function updateTokenLine(widget: HTMLDivElement, text: string): void {
  const tokensLine = widget.querySelector<HTMLElement>(`#${TOKENS_LINE_ID}`);
  if (tokensLine) {
    tokensLine.textContent = text;
  }
}

function renderWidgetMetric(widget: HTMLDivElement, now: number = Date.now()): void {
  // CUP_PHASE_C_START
  if (hasActiveAuthoritativeMetrics(now)) {
    hasApiAssistedConfidence = true;
    updateConfidenceLine(widget);

    const primaryAuthoritativeTokenValue = getPrimaryAuthoritativeTokenValue(cupMetricsState);
    if (primaryAuthoritativeTokenValue !== null) {
      updateTokenLine(widget, `API tokens: ~${primaryAuthoritativeTokenValue}`);
    } else {
      updateTokenLine(widget, `~${getTokenEstimate()} tokens on page`);
    }

    return;
  }
  // CUP_PHASE_C_END

  const freshApiTokenValue = getFreshApiTokenValue(now);

  if (freshApiTokenValue !== null && hasAnyAuthoritativeMetric(cupMetricsState) && !cupMetricsState.stale) {
    hasApiAssistedConfidence = true;
    updateConfidenceLine(widget);
    updateTokenLine(widget, `API tokens: ~${freshApiTokenValue}`);
    return;
  }

  hasApiAssistedConfidence = false;
  updateConfidenceLine(widget);
  updateTokenLine(widget, `~${getTokenEstimate()} tokens on page`);
}

function injectInterceptorScript(): void {
  try {
    if (isWorkStopped) {
      return;
    }

    if (!isRuntimeAvailable()) {
      stopObserversForInvalidation();
      return;
    }

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/interceptor/interceptor.js');
    script.async = false;
    script.onload = () => {
      script.remove();
    };
    script.onerror = () => {
      script.remove();
    };

    const target = document.head ?? document.documentElement;
    target.appendChild(script);
  } catch (error) {
    if (maybeHandleContextInvalidation(error)) {
      return;
    }

    // Keep baseline widget behavior even if script injection fails.
  }
}

function shouldAcceptInterceptorUrl(url: string): boolean {
  const normalizedUrl = url.toLowerCase();

  if (URL_IGNORE_PATTERNS.some((pattern) => normalizedUrl.includes(pattern))) {
    return false;
  }

  return URL_ACCEPT_PATTERNS.some((pattern) => normalizedUrl.includes(pattern));
}

function buildMessageSignature(message: InterceptorMessage, url: string): string {
  const payload = isRecord(message.payload) ? message.payload : null;
  const signatureValue = payload?.usage ?? payload?.message ?? payload?.id ?? null;

  let encodedValue = 'null';
  try {
    encodedValue = JSON.stringify(signatureValue);
  } catch (_error) {
    encodedValue = 'null';
  }

  return `${message.type}|${url}|${encodedValue}`;
}

function handleInterceptorMessage(event: MessageEvent): void {
  try {
    if (isWorkStopped) {
      return;
    }

    if (event.source !== window) {
      return;
    }

    const data = event.data as InterceptorMessage | null;
    if (!data) {
      return;
    }

    if (data.source !== INTERCEPTOR_SOURCE || data.type !== INTERCEPTOR_TYPE) {
      return;
    }

    if (typeof data.url !== 'string') {
      return;
    }

    const normalizedUrl = data.url.toLowerCase();
    if (!shouldAcceptInterceptorUrl(normalizedUrl)) {
      return;
    }

    const signature = buildMessageSignature(data, normalizedUrl);
    if (signature === lastSignature) {
      return;
    }

    lastSignature = signature;
    acceptedApiMessageCount += 1;
    if (acceptedApiMessageCount % 10 === 0) {
      console.debug('[CUP] accepted API messages:', acceptedApiMessageCount);
    }

    logMessageTypeOnce(data.type);

    // CUP_PHASE_C_START
    const now = Date.now();
    const extractedMetrics = extractPhaseCMetrics(data.payload);
    const previousMetricsState = cupMetricsState;
    const mergedMetricsState = mergePhaseCMetricsState(
      previousMetricsState,
      extractedMetrics.values,
      normalizedUrl,
      now,
    );
    cupMetricsState = mergedMetricsState;

    if (shouldPersistPhaseCMetrics(previousMetricsState, mergedMetricsState, extractedMetrics.matchedPaths)) {
      persistPhaseCMetricsState(mergedMetricsState);
    }

    if (CUP_DEBUG) {
      console.debug('[CUP] metrics update', {
        url: normalizedUrl,
        matchedPaths: extractedMetrics.matchedPaths,
        metricsSnapshot: getPhaseCMetricsSnapshot(mergedMetricsState),
      });
    }
    // CUP_PHASE_C_END

    const tokenValue = extractApiTokenValue(data.payload);
    if (tokenValue !== null) {
      lastApiTokenValue = tokenValue;
      lastApiUpdatedAt = now;
      hasApiAssistedConfidence = true;
    }

    // CUP_PHASE_C_START
    if (now - lastPhaseCUpdateAt < PHASE_C_UI_THROTTLE_MS) {
      return;
    }

    lastPhaseCUpdateAt = now;
    // CUP_PHASE_C_END

    if (now - lastUiUpdate < PHASE_C_UI_THROTTLE_MS) {
      return;
    }

    lastUiUpdate = now;
    renderWidgetMetric(getOrCreateWidget(), now);
  } catch (_error) {
    return;
  }
}

function getMainTextLength(): number {
  const mainText = document.querySelector('main')?.textContent;
  const fallbackText = document.body.textContent;
  const text = (mainText ?? fallbackText ?? '').trim();
  return text.length;
}

function getTokenEstimate(): number {
  return Math.round(getMainTextLength() / 4);
}

function createWidget(): HTMLDivElement {
  const widget = document.createElement('div');
  widget.id = WIDGET_ID;
  widget.className = 'cup-widget';
  widget.innerHTML = `
    <div class="cup-widget__title">Claude Usage Pro</div>
    <div class="cup-widget__confidence">Confidence: Estimated</div>
    <div id="${TOKENS_LINE_ID}" class="cup-widget__tokens">~0 tokens on page</div>
  `;

  document.body.appendChild(widget);
  return widget;
}

function getOrCreateWidget(): HTMLDivElement {
  const existingWidget = document.getElementById(WIDGET_ID) as HTMLDivElement | null;
  return existingWidget ?? createWidget();
}

function readEnabledSetting(): Promise<boolean> {
  return safeStorageGet('cupEnabled').then((result) => {
    const rawValue = result.cupEnabled;
    if (typeof rawValue === 'boolean') {
      return rawValue;
    }

    void safeStorageSet({ cupEnabled: true });
    return true;
  });
}

async function refreshWidget(): Promise<void> {
  if (isWorkStopped) {
    return;
  }

  const widget = getOrCreateWidget();
  const enabled = await readEnabledSetting();

  if (isWorkStopped) {
    return;
  }

  if (!enabled) {
    widget.style.display = 'none';
    return;
  }

  widget.style.display = 'block';
  renderWidgetMetric(widget);
}

function handleUrlChange(): void {
  lastApiTokenValue = null;
  lastApiUpdatedAt = null;
  updateTokenLine(getOrCreateWidget(), 'Calculating...');
}

function handleLifecycleCleanupEvent(_event: Event): void {
  cleanupObservers();
  isWorkStopped = true;
  cupWindow.__CUP_CONTENT_INIT__ = false;
}

async function initializeContentScript(): Promise<void> {
  cleanupPreviousInstance();

  if (cupWindow.__CUP_CONTENT_INIT__) {
    return;
  }

  cupWindow.__CUP_CONTENT_INIT__ = true;
  isWorkStopped = false;

  messageListenerRef = handleInterceptorMessage;
  window.addEventListener('message', messageListenerRef);
  window.addEventListener('cup:urlchange', handleUrlChange);

  storageListenerRef = (changes, areaName) => {
    try {
      if (isWorkStopped) {
        return;
      }

      if (areaName === 'local' && Object.prototype.hasOwnProperty.call(changes, 'cupEnabled')) {
        void refreshWidget();
      }
    } catch (_error) {
      return;
    }
  };

  safeAddStorageListener(storageListenerRef);

  lifecycleListenerRef = handleLifecycleCleanupEvent;
  document.addEventListener('visibilitychange', lifecycleListenerRef);
  window.addEventListener('pagehide', lifecycleListenerRef);
  window.addEventListener('beforeunload', lifecycleListenerRef);

  injectInterceptorScript();

  // CUP_PHASE_C_START
  const hydrationDebug = await hydratePhaseCMetricsState();
  if (CUP_DEBUG) {
    console.debug('[CUP] hydrated state', hydrationDebug);
  }
  // CUP_PHASE_C_END

  try {
    await refreshWidget();
  } catch (_error) {
    return;
  }

  if (isWorkStopped) {
    updateWindowState();
    return;
  }

  refreshIntervalId = window.setInterval(() => {
    try {
      if (isWorkStopped) {
        return;
      }

      // CUP_PHASE_C_START
      if (hasActiveAuthoritativeMetrics()) {
        return;
      }
      // CUP_PHASE_C_END

      if (!isRuntimeAvailable()) {
        stopObserversForInvalidation();
        return;
      }

      if (typeof document === 'undefined') {
        return;
      }

      if (!document.querySelector('main')) {
        return;
      }

      void refreshWidget();
    } catch (_error) {
      return;
    }
  }, 3000);

  updateWindowState();
}

void initializeContentScript();
