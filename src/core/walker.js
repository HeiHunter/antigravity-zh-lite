const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'CODE',
  'PRE',
  'TEXTAREA',
  'SVG',
  'MATH',
  'CANVAS',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'KBD',
  'SAMP',
  'VAR',
]);

const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label'];

const DEFAULT_IGNORE_SELECTORS = [
  '[data-ag-zh-ignore]',
  '#ag-zh-host',
  '.xterm',
  '.monaco-editor',
  '.cm-editor',
  '[contenteditable="true"]',
  '[contenteditable=""]',
];

/**
 * React-safe DOM translator:
 * - Only mutates leaf TextNode.nodeValue and safe attributes (placeholder, title, aria-label).
 * - Never inserts/removes/replaces elements inside React-managed trees.
 * - Tracks original vs. applied values via WeakMap so React re-renders are respected
 *   and toggling back to English is lossless with zero memory leaks.
 */
export function createDomTranslator(matcher, options = {}) {
  let activeMatcher = matcher;
  let ignoreSelectors = buildIgnoreSelectors(options.ignoreSelectors);
  const dynamicQueue = options.dynamicQueue || null;

  const originalTextMap = new WeakMap();
  const appliedTextMap = new WeakMap();
  const originalAttrMap = new WeakMap();
  const appliedAttrMap = new WeakMap();
  const syntheticTitleMap = new WeakMap();

  let isApplying = false;
  let translatedCount = 0;

  function buildIgnoreSelectors(extra = []) {
    const merged = new Set(DEFAULT_IGNORE_SELECTORS);
    if (Array.isArray(extra)) {
      for (const s of extra) {
        if (typeof s === 'string' && s.trim()) merged.add(s.trim());
      }
    }
    return [...merged].join(',');
  }

  function setMatcher(nextMatcher, nextIgnoreSelectors) {
    activeMatcher = nextMatcher;
    if (nextIgnoreSelectors) {
      ignoreSelectors = buildIgnoreSelectors(nextIgnoreSelectors);
    }
  }

  function shouldSkipElement(el, { allowTextareaAttrs = false } = {}) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA' && allowTextareaAttrs) {
      // Allow translating placeholder/aria-label/title on <textarea> without ever walking its user text
    } else if (SKIP_TAGS.has(el.tagName)) {
      return true;
    }
    if (el.isContentEditable) return true;
    if (ignoreSelectors && typeof el.closest === 'function') {
      try {
        if (el.closest(ignoreSelectors)) return true;
      } catch {
        // Ignore invalid selector
      }
    }
    return false;
  }

  function translateTextNode(node, collector) {
    if (!node || node.nodeType !== 3) return false;
    const parent = node.parentElement || null;
    if (parent && shouldSkipElement(parent)) return false;

    const current = node.nodeValue;
    if (!current) return false;

    const lastApplied = appliedTextMap.get(node);
    if (lastApplied !== undefined && current === lastApplied) {
      return false;
    }

    const sourceText =
      originalTextMap.has(node) && current === lastApplied
        ? originalTextMap.get(node)
        : current;
    originalTextMap.set(node, sourceText);

    if (dynamicQueue) {
      dynamicQueue.inspectForApprovalAnchor(sourceText, parent);
    }

    const translated = activeMatcher.translate(sourceText, parent);
    if (translated && translated !== current) {
      isApplying = true;
      try {
        appliedTextMap.set(node, translated);
        node.nodeValue = translated;
        // Tier 2 UX: for machine-translated dynamic sentences, expose original English on hover
        // only when the parent element does not already define its own title attribute.
        if (
          parent &&
          typeof activeMatcher.isDynamicHit === 'function' &&
          activeMatcher.isDynamicHit(sourceText) &&
          typeof parent.getAttribute === 'function' &&
          typeof parent.setAttribute === 'function' &&
          !parent.getAttribute('title') &&
          !syntheticTitleMap.has(parent)
        ) {
          const origHint = sourceText.trim();
          parent.setAttribute('title', origHint);
          syntheticTitleMap.set(parent, origHint);
        }
        translatedCount++;
      } finally {
        isApplying = false;
      }
      return true;
    }

    if (dynamicQueue) {
      dynamicQueue.enqueue(sourceText, node, parent);
    }

    if (collector && collector.enabled) {
      collector.record(sourceText, parent);
    }
    return false;
  }

  function translateElementAttributes(el, collector) {
    if (!el || el.nodeType !== 1 || shouldSkipElement(el, { allowTextareaAttrs: true })) return;
    if (typeof el.getAttribute !== 'function') return;

    let origMap = originalAttrMap.get(el);
    let appMap = appliedAttrMap.get(el);

    for (let i = 0; i < TRANSLATABLE_ATTRS.length; i++) {
      const attr = TRANSLATABLE_ATTRS[i];
      if (attr === 'title' && syntheticTitleMap.has(el)) continue;
      const current = el.getAttribute(attr);
      if (!current) continue;

      const lastApplied = appMap ? appMap.get(attr) : undefined;
      if (lastApplied !== undefined && current === lastApplied) continue;

      if (!origMap) {
        origMap = new Map();
        originalAttrMap.set(el, origMap);
      }
      origMap.set(attr, current);

      const translated = activeMatcher.translate(current, el);
      if (translated && translated !== current) {
        if (!appMap) {
          appMap = new Map();
          appliedAttrMap.set(el, appMap);
        }
        isApplying = true;
        try {
          appMap.set(attr, translated);
          el.setAttribute(attr, translated);
          translatedCount++;
        } finally {
          isApplying = false;
        }
      } else if (collector && collector.enabled) {
        collector.record(current, el);
      }
    }
  }

  function walkAndApply(root, visitor, onShadowRoot) {
    if (!root) return;
    if (root.nodeType === 3) {
      visitor(root);
      return;
    }
    if (root.nodeType === 1) {
      if (root.tagName === 'TEXTAREA') {
        if (!shouldSkipElement(root, { allowTextareaAttrs: true })) {
          visitor(root);
        }
        return;
      }
      if (shouldSkipElement(root)) return;
      visitor(root);
      if (root.shadowRoot && root.id !== 'ag-zh-host') {
        if (onShadowRoot) onShadowRoot(root.shadowRoot);
        walkAndApply(root.shadowRoot, visitor, onShadowRoot);
      }
    }
    const children = root.childNodes;
    if (!children || children.length === 0) return;
    for (let i = 0; i < children.length; i++) {
      walkAndApply(children[i], visitor, onShadowRoot);
    }
  }

  function translateSubtree(root, collector, onShadowRoot) {
    walkAndApply(
      root,
      (node) => {
        if (node.nodeType === 3) {
          translateTextNode(node, collector);
        } else if (node.nodeType === 1) {
          translateElementAttributes(node, collector);
        }
      },
      onShadowRoot
    );
  }

  function restoreSubtree(root) {
    walkAndApply(root, (node) => {
      if (node.nodeType === 3) {
        const orig = originalTextMap.get(node);
        const applied = appliedTextMap.get(node);
        if (orig !== undefined && applied !== undefined && node.nodeValue === applied) {
          isApplying = true;
          try {
            node.nodeValue = orig;
            appliedTextMap.delete(node);
          } finally {
            isApplying = false;
          }
        }
      } else if (node.nodeType === 1) {
        const synTitle = syntheticTitleMap.get(node);
        if (synTitle !== undefined && typeof node.removeAttribute === 'function') {
          if (node.getAttribute('title') === synTitle) {
            isApplying = true;
            try {
              node.removeAttribute('title');
            } finally {
              isApplying = false;
            }
          }
          syntheticTitleMap.delete(node);
        }
        const origMap = originalAttrMap.get(node);
        const appMap = appliedAttrMap.get(node);
        if (!origMap || !appMap) return;
        for (const [attr, origVal] of origMap.entries()) {
          const appliedVal = appMap.get(attr);
          if (appliedVal !== undefined && node.getAttribute(attr) === appliedVal) {
            isApplying = true;
            try {
              node.setAttribute(attr, origVal);
              appMap.delete(attr);
            } finally {
              isApplying = false;
            }
          }
        }
      }
    });
  }

  return {
    translateSubtree,
    translateTextNode,
    translateElementAttributes,
    restoreSubtree,
    setMatcher,
    isApplying: () => isApplying,
    getTranslatedCount: () => translatedCount,
  };
}
