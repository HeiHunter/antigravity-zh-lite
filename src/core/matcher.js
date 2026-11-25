const ASCII_LETTER_RE = /[A-Za-z]/;
const WS_WRAP_RE = /^(\s*)([\s\S]*?)(\s*)$/;
const MAX_PATTERN_LENGTH = 160;

/**
 * Create a 3-tier matcher + runtime dynamic cache layer:
 *   L1: Scoped exact match (context-aware via CSS selector)
 *   L2: Global exact match + dynamic cache (O(1) Map lookup)
 *   L3: Pattern RegExp match (guarded by length + fast substring hint)
 */
export function createMatcher(dict = {}) {
  const exactMap = new Map();
  const dynamicMap = new Map();

  if (dict.exact && typeof dict.exact === 'object') {
    for (const [k, v] of Object.entries(dict.exact)) {
      exactMap.set(k.trim(), v);
    }
  }
  if (dict.dynamicCache && typeof dict.dynamicCache === 'object') {
    for (const [k, v] of Object.entries(dict.dynamicCache)) {
      if (typeof v === 'string' && v.trim()) {
        dynamicMap.set(k.trim(), v.trim());
      }
    }
  }

  const scopedRules = [];
  if (Array.isArray(dict.scoped)) {
    for (const rule of dict.scoped) {
      if (!rule || !rule.selector || !rule.exact) continue;
      const map = new Map();
      for (const [k, v] of Object.entries(rule.exact)) {
        map.set(k.trim(), v);
      }
      scopedRules.push({ selector: rule.selector, map });
    }
  }

  const patternRules = [];
  if (Array.isArray(dict.patterns)) {
    for (const p of dict.patterns) {
      if (!p || !p.regex || typeof p.replace !== 'string') continue;
      try {
        patternRules.push({
          hintLower: (p.hint || '').toLowerCase(),
          regex: new RegExp(p.regex, p.flags || ''),
          replace: p.replace,
        });
      } catch {
        // Skip invalid pattern safely at runtime
      }
    }
  }

  function addDynamicBatch(entries) {
    if (!entries || typeof entries !== 'object') return 0;
    let added = 0;
    for (const [k, v] of Object.entries(entries)) {
      if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) {
        dynamicMap.set(k.trim(), v.trim());
        added++;
      }
    }
    return added;
  }

  function translate(rawText, element = null) {
    if (typeof rawText !== 'string' || !rawText) return null;
    if (!ASCII_LETTER_RE.test(rawText)) return null;

    const parts = WS_WRAP_RE.exec(rawText);
    if (!parts) return null;
    const [, lead, core, trail] = parts;
    if (!core) return null;

    // L1: Scoped contextual exact match (highest specificity)
    if (scopedRules.length > 0 && element && typeof element.closest === 'function') {
      for (let i = 0; i < scopedRules.length; i++) {
        const rule = scopedRules[i];
        const hit = rule.map.get(core);
        if (hit !== undefined) {
          try {
            if (element.closest(rule.selector)) {
              return lead + hit + trail;
            }
          } catch {
            // Ignore selector errors
          }
        }
      }
    }

    // L2: Global exact match or cached dynamic translation O(1)
    const exactHit = exactMap.get(core);
    if (exactHit !== undefined) {
      return lead + exactHit + trail;
    }
    const dynamicHit = dynamicMap.get(core);
    if (dynamicHit !== undefined) {
      return lead + dynamicHit + trail;
    }

    // L3: Dynamic pattern match (skip long prose paragraphs)
    if (patternRules.length > 0 && core.length <= MAX_PATTERN_LENGTH) {
      const lower = core.toLowerCase();
      for (let i = 0; i < patternRules.length; i++) {
        const rule = patternRules[i];
        if (rule.hintLower && !lower.includes(rule.hintLower)) continue;
        if (rule.regex.test(core)) {
          const replaced = core.replace(rule.regex, rule.replace);
          if (replaced !== core) {
            return lead + replaced + trail;
          }
        }
      }
    }

    return null;
  }

  return {
    translate,
    addDynamicBatch,
    getDynamicEntries: () => Object.fromEntries(dynamicMap.entries()),
    getDynamicSize: () => dynamicMap.size,
    stats: {
      exact: exactMap.size,
      scoped: scopedRules.length,
      patterns: patternRules.length,
    },
  };
}
