import fs from 'node:fs';
import path from 'node:path';
import { smartFetch } from './proxy.js';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_CACHE = 2000;
const MAX_CONCURRENCY = 3;

const LLM_SYSTEM_PROMPT =
  'You translate short English UI prompts, command approval titles, and security risk descriptions in an AI coding IDE into concise, natural Simplified Chinese. Preserve CLI commands, file paths, flags, and technical terms (e.g., macOS, LaunchAgent, CDP, JSON, DOM, localStorage, MutationObserver) as-is. Return ONLY a JSON object mapping each exact input string to its Chinese translation.';

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS, proxy = '') {
  return await smartFetch(url, options, { timeoutMs, proxy });
}

function normalizeTranslation(str) {
  return String(str || '')
    .trim()
    .replace(/反重力/g, 'Antigravity');
}

function isValidDynamicKey(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t || t.length > 600) return false;
  const words = t.split(/\s+/);
  if (/^(?:Gemini|Claude|GPT|OpenAI|Anthropic|Google|Llama|DeepSeek|Qwen|Mistral|Orchestrator)\b/i.test(t) && words.length < 6) {
    return false;
  }
  if (/^Allow\s+.+\?$/.test(t) && words.length >= 3) return true;
  return t.length >= 28 && words.length >= 5;
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
  return translated.trim();
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
 * Create a daemon-side dynamic translator with persistent local disk cache
 * (dicts/_dynamic_cache.json), in-flight deduplication, and multi-provider support.
 */
export function createDynamicTranslator({ rootDir, config = {}, customTranslateFn = null }) {
  const cachePath = path.join(rootDir, 'dicts', '_dynamic_cache.json');
  const cache = new Map();
  const inFlight = new Map();
  let saveTimer = null;

  // Load existing local cache (auto-pruning any legacy short/model-name entries)
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
    flushCacheSync();
  }

  function scheduleSave(maxCacheSize = DEFAULT_MAX_CACHE) {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushCacheSync(maxCacheSize);
    }, 350);
  }

  function flushCacheSync(maxCacheSize = DEFAULT_MAX_CACHE) {
    while (cache.size > maxCacheSize) {
      const oldestKey = cache.keys().next().value;
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

  async function translateSingleFree(text, cfg) {
    const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
    const proxy = cfg.proxy || '';
    if (customTranslateFn) {
      return await customTranslateFn(text);
    }
    try {
      return await translateViaGoogle(text, timeoutMs, proxy);
    } catch {
      return await translateViaMyMemory(text, timeoutMs, proxy);
    }
  }

  async function translateTexts(rawTexts, runtimeConfig = config) {
    const cfg = runtimeConfig?.dynamicTranslate || {};
    if (cfg.enabled === false) {
      return { translations: {}, fromCache: 0, fetched: 0 };
    }

    const maxCacheSize = cfg.maxCacheSize || DEFAULT_MAX_CACHE;
    const unique = [];
    const seen = new Set();
    for (const t of Array.isArray(rawTexts) ? rawTexts : []) {
      if (typeof t !== 'string') continue;
      const trimmed = t.trim();
      if (!trimmed || trimmed.length > 600 || seen.has(trimmed)) continue;
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

    // Batch LLM path when configured with API key
    if ((provider === 'openai' || provider === 'gemini') && cfg.apiKey && !customTranslateFn) {
      try {
        const batchResult =
          provider === 'gemini'
            ? await translateBatchViaGemini(misses, cfg)
            : await translateBatchViaOpenAI(misses, cfg);
        for (const text of misses) {
          const val = batchResult[text];
          if (typeof val === 'string' && val.trim() && val.trim() !== text) {
            cache.set(text, val.trim());
            translations[text] = val.trim();
            fetched++;
          }
        }
        if (fetched > 0) scheduleSave(maxCacheSize);
        return { translations, fromCache, fetched };
      } catch (err) {
        console.warn(`[ag-zh] ${provider} 翻译失败，回退至免费轻量接口: ${err.message}`);
      }
    }

    // Concurrent single-text path with in-flight deduplication (Google -> MyMemory fallback)
    const queue = [...misses];
    async function worker() {
      while (queue.length > 0) {
        const text = queue.shift();
        if (!text) continue;
        let promise = inFlight.get(text);
        if (!promise) {
          promise = translateSingleFree(text, cfg)
            .catch(() => null)
            .finally(() => inFlight.delete(text));
          inFlight.set(text, promise);
        }
        const translated = await promise;
        if (typeof translated === 'string' && translated.trim() && translated.trim() !== text) {
          cache.set(text, translated.trim());
          translations[text] = translated.trim();
          fetched++;
        }
      }
    }

    const workers = [];
    const workerCount = Math.min(MAX_CONCURRENCY, misses.length);
    for (let i = 0; i < workerCount; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    if (fetched > 0) {
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
