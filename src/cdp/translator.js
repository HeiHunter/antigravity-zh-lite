import fs from 'node:fs';
import path from 'node:path';
import { smartFetch } from './proxy.js';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_CACHE = 2000;
const MAX_BATCH_SIZE = 30;
const MAX_GLOBAL_CONCURRENCY = 3;
const MAX_GLOBAL_QUEUE = 60;

const LLM_SYSTEM_PROMPT =
  'You translate short English UI prompts, command approval titles, and security risk descriptions in an AI coding IDE into concise, natural Simplified Chinese. Preserve all placeholder tokens like AGPH0X, AGPH1X, CLI commands, file paths, flags, and technical terms (e.g., macOS, LaunchAgent, CDP, JSON, DOM, localStorage, MutationObserver) exactly as-is. Return ONLY a JSON object mapping each exact input string to its Chinese translation.';

const SENSITIVE_TOKEN_RE =
  /`[^`]{1,120}`|~\/[^\s,;)'"`]+|\/(?:Users|home|Applications|Library|etc|var|tmp|opt|usr)\/[^\s,;)'"`]+|[A-Za-z]:\\[^\s,;)'"`]+|\b[\w.-]+(?:\/[\w.-]+)+\b|'[^'\n]{3,80}'/g;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS, proxy = '') {
  return await smartFetch(url, options, { timeoutMs, proxy });
}

export function normalizeTranslation(str) {
  return String(str || '')
    .trim()
    .replace(/反重力/g, 'Antigravity');
}

export function normalizeMaxCacheSize(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_CACHE;
  return Math.floor(n);
}

export function isValidDynamicKey(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t || t.length > 600) return false;
  const words = t.split(/\s+/);
  if (
    /^(?:Gemini|Claude|GPT|OpenAI|Anthropic|Google|Llama|DeepSeek|Qwen|Mistral|Orchestrator)\b/i.test(
      t
    ) &&
    words.length < 6
  ) {
    return false;
  }
  if (/^Allow\s+.+\?$/.test(t) && words.length >= 3) return true;
  return t.length >= 28 && words.length >= 5;
}

/**
 * Redact local paths, inline backtick code, and quoted commands into stable
 * alphanumeric placeholders (AGPH0X, AGPH1X...) before sending to external translators.
 */
export function redactSensitiveTokens(text) {
  const tokens = [];
  const redacted = String(text).replace(SENSITIVE_TOKEN_RE, (match) => {
    const idx = tokens.length;
    tokens.push(match);
    return `AGPH${idx}X`;
  });
  return { redacted, tokens };
}

/**
 * Restore all redacted placeholders and strictly verify completeness.
 * If any placeholder was dropped or corrupted by the translator, return null
 * so the caller safely discards the translation and preserves original text.
 */
export function restoreSensitiveTokens(translated, tokens) {
  if (typeof translated !== 'string' || !translated.trim()) return null;
  if (!tokens || tokens.length === 0) return translated.trim();

  let out = translated;
  for (let i = 0; i < tokens.length; i++) {
    const tokenRe = new RegExp(`AGPH${i}X`, 'gi');
    if (!tokenRe.test(out)) {
      return null;
    }
    out = out.replace(new RegExp(`AGPH${i}X`, 'gi'), () => tokens[i]);
  }
  // Ensure no orphan placeholder tokens remain
  if (/AGPH\d+X/i.test(out)) {
    return null;
  }
  return out.trim();
}

export function createSemaphore(maxConcurrent, maxQueueSize = MAX_GLOBAL_QUEUE) {
  let active = 0;
  const waiters = [];
  return async function withPermit(fn) {
    if (active >= maxConcurrent) {
      if (waiters.length >= maxQueueSize) {
        throw new Error('Dynamic translation queue full');
      }
      await new Promise((resolve) => waiters.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

async function translateViaGoogle(text, timeoutMs, proxy) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' +
    encodeURIComponent(text);
  const res = await fetchWithTimeout(url, {}, timeoutMs, proxy);
  if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Unexpected Google Translate response');
  }
  const translated = normalizeTranslation(
    data[0]
      .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
      .join('')
  );
  if (!translated) throw new Error('Empty Google Translate result');
  return translated;
}

async function translateViaMyMemory(text, timeoutMs, proxy) {
  const url =
    'https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=' + encodeURIComponent(text);
  const res = await fetchWithTimeout(url, {}, timeoutMs, proxy);
  if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
  const data = await res.json();
  const translated = data?.responseData?.translatedText;
  if (typeof translated !== 'string' || !translated.trim()) {
    throw new Error('Empty MyMemory result');
  }
  return normalizeTranslation(translated);
}

function parseJsonObjectFromLlm(content) {
  const trimmed = String(content || '').trim();
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const raw = fenceMatch ? fenceMatch[1].trim() : trimmed;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM did not return a JSON object');
  }
  return parsed;
}

async function translateBatchViaOpenAI(texts, cfg) {
  const baseUrl = (cfg.apiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = cfg.model || 'gpt-4o-mini';
  const res = await fetchWithTimeout(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: LLM_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(texts) },
        ],
      }),
    },
    cfg.timeoutMs || 10000,
    cfg.proxy || ''
  );
  if (!res.ok) throw new Error(`OpenAI-compatible HTTP ${res.status}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  return parseJsonObjectFromLlm(content);
}

async function translateBatchViaGemini(texts, cfg) {
  const model = cfg.model || 'gemini-2.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: LLM_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(texts) }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      }),
    },
    cfg.timeoutMs || 10000,
    cfg.proxy || ''
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return parseJsonObjectFromLlm(content);
}

/**
 * Create a daemon-side dynamic translator with:
 * - Persistent local disk cache (dicts/_dynamic_cache.json) with safe size bounds
 * - Strict backend validation reusing isValidDynamicKey() + per-call batch cap
 * - Global concurrency semaphore across concurrent calls
 * - Placeholder redaction + strict restoration integrity verification
 * - Zero silent privacy downgrade (no automatic fallback to MyMemory or from LLM to free APIs)
 */
export function createDynamicTranslator({ rootDir, config = {}, customTranslateFn = null }) {
  const cachePath = path.join(rootDir, 'dicts', '_dynamic_cache.json');
  const cache = new Map();
  const inFlight = new Map();
  const withGlobalPermit = createSemaphore(MAX_GLOBAL_CONCURRENCY);
  let saveTimer = null;

  let prunedOnLoad = false;
  if (fs.existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof k === 'string' && typeof v === 'string' && v.trim() && isValidDynamicKey(k)) {
            cache.set(k, normalizeTranslation(v));
          } else {
            prunedOnLoad = true;
          }
        }
      }
    } catch {
      // Ignore corrupted cache
    }
  }
  if (prunedOnLoad) {
    flushCacheSync(config?.dynamicTranslate?.maxCacheSize);
  }

  function scheduleSave(maxCacheSize = DEFAULT_MAX_CACHE) {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushCacheSync(maxCacheSize);
    }, 350);
  }

  function flushCacheSync(maxCacheSize = DEFAULT_MAX_CACHE) {
    const limit = normalizeMaxCacheSize(maxCacheSize);
    while (cache.size > limit && cache.size > 0) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const obj = Object.fromEntries(cache.entries());
      fs.writeFileSync(cachePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    } catch {
      // Ignore write failures
    }
  }

  async function translateSingleWithRedaction(originalText, provider, cfg) {
    const { redacted, tokens } = redactSensitiveTokens(originalText);
    const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
    const proxy = cfg.proxy || '';

    const rawTranslated = await withGlobalPermit(async () => {
      if (customTranslateFn) {
        return await customTranslateFn(redacted);
      }
      if (provider === 'mymemory') {
        return await translateViaMyMemory(redacted, timeoutMs, proxy);
      }
      return await translateViaGoogle(redacted, timeoutMs, proxy);
    });

    const restored = restoreSensitiveTokens(normalizeTranslation(rawTranslated), tokens);
    if (!restored || restored === originalText) return null;
    return restored;
  }

  async function translateTexts(rawTexts, runtimeConfig = config) {
    const cfg = runtimeConfig?.dynamicTranslate || {};
    if (cfg.enabled === false) {
      return { translations: {}, fromCache: 0, fetched: 0 };
    }

    const maxCacheSize = normalizeMaxCacheSize(cfg.maxCacheSize);
    const unique = [];
    const seen = new Set();
    for (const t of Array.isArray(rawTexts) ? rawTexts : []) {
      if (unique.length >= MAX_BATCH_SIZE) break;
      if (typeof t !== 'string') continue;
      const trimmed = t.trim();
      if (!isValidDynamicKey(trimmed) || seen.has(trimmed)) continue;
      seen.add(trimmed);
      unique.push(trimmed);
    }

    const translations = {};
    const misses = [];
    let fromCache = 0;

    for (const text of unique) {
      if (cache.has(text)) {
        translations[text] = cache.get(text);
        fromCache++;
      } else {
        misses.push(text);
      }
    }

    if (misses.length === 0) {
      return { translations, fromCache, fetched: 0 };
    }

    let fetched = 0;
    const provider = cfg.provider || 'google';

    // Explicit LLM provider path: NEVER silently fall back to public free translators on failure
    if ((provider === 'openai' || provider === 'gemini') && !customTranslateFn) {
      if (!cfg.apiKey) {
        console.warn(`[ag-zh] 动态翻译已配置为 ${provider}，但未设置 apiKey，跳过本次翻译。`);
        return { translations, fromCache, fetched: 0 };
      }
      try {
        const redactedItems = misses.map((orig) => ({
          orig,
          ...redactSensitiveTokens(orig),
        }));
        const batchResult = await withGlobalPermit(async () =>
          provider === 'gemini'
            ? await translateBatchViaGemini(
                redactedItems.map((i) => i.redacted),
                cfg
              )
            : await translateBatchViaOpenAI(
                redactedItems.map((i) => i.redacted),
                cfg
              )
        );
        for (const item of redactedItems) {
          const rawVal = batchResult[item.redacted] ?? batchResult[item.orig];
          if (typeof rawVal !== 'string') continue;
          const restored = restoreSensitiveTokens(normalizeTranslation(rawVal), item.tokens);
          if (restored && restored !== item.orig) {
            if (maxCacheSize > 0) cache.set(item.orig, restored);
            translations[item.orig] = restored;
            fetched++;
          }
        }
        if (fetched > 0 && maxCacheSize > 0) scheduleSave(maxCacheSize);
      } catch (err) {
        console.warn(`[ag-zh] ${provider} 动态翻译失败（已禁止隐式回退公共接口）: ${err.message}`);
      }
      return { translations, fromCache, fetched };
    }

    // Single-text path (google or explicit mymemory) with in-flight deduplication + global concurrency cap
    await Promise.all(
      misses.map(async (text) => {
        let promise = inFlight.get(text);
        if (!promise) {
          promise = translateSingleWithRedaction(text, provider, cfg)
            .catch(() => null)
            .finally(() => inFlight.delete(text));
          inFlight.set(text, promise);
        }
        const translated = await promise;
        if (typeof translated === 'string' && translated && translated !== text) {
          if (maxCacheSize > 0) cache.set(text, translated);
          translations[text] = translated;
          fetched++;
        }
      })
    );

    if (fetched > 0 && maxCacheSize > 0) {
      scheduleSave(maxCacheSize);
    }

    return { translations, fromCache, fetched };
  }

  return {
    translateTexts,
    getCachedEntries() {
      return Object.fromEntries(cache.entries());
    },
    getCacheSize() {
      return cache.size;
    },
    flushCacheSync,
    cachePath,
  };
}
