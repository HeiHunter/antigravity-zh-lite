const COLLECT_MAX_LEN = 260;
const COLLECT_MIN_LEN = 2;
const HAS_WORD_RE = /[A-Za-z]{2,}/;
const HAS_CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const NOISE_RE =
  /^(?:https?:\/\/|file:\/\/|\/[\w.-]+\/|~\/)|^(?:0x[0-9a-f]+|[0-9a-f]{8,}|[\w.-]+@[\w.-]+\.[a-z]{2,}|[\d\s:.,/%+-]+)$/i;
const CODE_LIKE_RE = /[{};=<>]|=>|\(\s*\)|^\s*[$#>]/;

/**
 * Dev-mode collector: gathers untranslated UI English phrases from live screens
 * and exports a ready-to-translate JSON skeleton sorted by frequency.
 */
export function createCollector(onChange) {
  const entries = new Map();
  let enabled = false;

  function isCandidate(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < COLLECT_MIN_LEN || t.length > COLLECT_MAX_LEN) return false;
    if (HAS_CJK_RE.test(t)) return false;
    if (!HAS_WORD_RE.test(t)) return false;
    if (NOISE_RE.test(t)) return false;
    if (CODE_LIKE_RE.test(t)) return false;
    return true;
  }

  function describeElement(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = (el.tagName || '').toLowerCase();
    const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
    return role ? `${tag}[role="${role}"]` : tag;
  }

  function record(rawText, element) {
    if (!enabled || !isCandidate(rawText)) return;
    const key = rawText.trim();
    const prev = entries.get(key);
    if (prev) {
      prev.count++;
    } else {
      entries.set(key, {
        count: 1,
        context: describeElement(element),
      });
      if (onChange) onChange(entries.size);
    }
  }

  function getItems() {
    return [...entries.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([text, meta]) => ({ text, ...meta }));
  }

  function exportDictTemplate() {
    const exact = {};
    for (const item of getItems()) {
      exact[item.text] = '';
    }
    return { exact };
  }

  return {
    get enabled() {
      return enabled;
    },
    set enabled(val) {
      enabled = Boolean(val);
    },
    record,
    getItems,
    exportDictTemplate,
    clear() {
      entries.clear();
      if (onChange) onChange(0);
    },
    size() {
      return entries.size;
    },
  };
}
