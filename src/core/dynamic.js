const DYNAMIC_MIN_LEN_SENTENCE = 28;
const DYNAMIC_MIN_WORDS_SENTENCE = 5;
const DYNAMIC_MAX_LEN = 480;
const DYNAMIC_CJK_RE = /[\u4e00-\u9fff]/;
const DYNAMIC_WORDS_RE = /\b[A-Za-z]{2,}\b/g;
const DYNAMIC_NOISE_START_RE = /^(?:https?:\/\/|file:\/\/|\/\/|\/\*|\/[\w.-]|~\/|[$#>{\[]|--)/i;
const DYNAMIC_FILENAME_RE =
  /^[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|py|sh|command|css|html|plist|png|jpg|svg|log|yaml|yml|toml|txt|lock)$/i;
const DYNAMIC_CODE_RE = /=>|===|!==|\(\s*\);|\{\s*\}|;\s*$/;
const DYNAMIC_CMD_START_RE =
  /^(?:node|npm|npx|pnpm|yarn|git|cd|ls|cat|curl|wget|python3?|bash|sh|zsh|chmod|chown|open|brew|sudo|docker|kubectl|launchctl|ps|pgrep)\s+/i;
const DYNAMIC_MODEL_OR_BRAND_RE =
  /^(?:Gemini|Claude|GPT|OpenAI|Anthropic|Google|Llama|DeepSeek|Qwen|Mistral|Orchestrator)\b/i;

const APPROVAL_TITLE_RE = /^Allow\s+.+\?$/;

const DYNAMIC_PROMPT_TEXT_RE =
  /^(?:The command\b|This command\b|This action\b|This tool\b|This script\b|This request\b|This operation\b|This will\b|Running this\b|Executing this\b|Unable to\b|Failed to\b|Cannot\s+[a-z]|Permission\b|Approval\b|Warning:|Error:)/;

const APPROVAL_ANCHOR_RE =
  /^(?:Allow\s+.+\?$|Yes, allow this time$|Yes, and always allow|\(tell the agent what to do instead\)$)/;

const DYNAMIC_UI_CONTAINER_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="alert"]',
  '[role="status"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  '[role="tabpanel"]',
  '[data-radix-popper-content-wrapper]',
  '[aria-label*="Plugins"]',
  '[aria-label*="Marketplace"]',
  '[aria-label*="Customizations"]',
  '[aria-label*="Featured"]',
  '[aria-label*="插件"]',
  'dialog',
].join(', ');

function isNonChatRoute() {
  if (typeof location === 'undefined' || !location || typeof location.pathname !== 'string') {
    return false;
  }
  const p = location.pathname;
  return p.length > 1 && !/^\/c(?:\/|$)/.test(p);
}

/**
 * Browser-side dynamic translation queue with STRICT long-sentence-only guards:
 * - Short labels, model names (Gemini/Claude/GPT), font names, and buttons NEVER use machine translation.
 * - Only missing long English sentences (>= 5 words and >= 28 chars) inside UI overlays/dialogs/approval cards,
 *   plus explicit approval titles ("Allow ...?"), are sent to the daemon translator.
 */
export function createDynamicQueue({ sendRequest, onApplyNodes }) {
  const approvalCards = new WeakSet();
  const pendingByText = new Map();
  const requestedTexts = new Set();
  const queuedTexts = new Set();
  let flushTimer = null;
  let enabled = true;

  function markApprovalCardFromElement(el) {
    if (!el || el.nodeType !== 1) return;
    let cur = el.parentElement;
    let fallback = null;
    for (let depth = 0; depth < 6 && cur; depth++) {
      if (cur.tagName === 'BODY' || cur.tagName === 'HTML') break;
      const text = typeof cur.textContent === 'string' ? cur.textContent : '';
      if (text.length > 2200) break;
      fallback = cur;
      const hasActionControl =
        (typeof cur.querySelector === 'function' && Boolean(cur.querySelector('button'))) ||
        /\b(?:Submit|Skip|Yes,\s*allow|Approve|Deny|Reject)\b/.test(text);
      if (hasActionControl && text.length >= 60) {
        approvalCards.add(cur);
        return;
      }
      cur = cur.parentElement;
    }
    if (fallback) approvalCards.add(fallback);
  }

  function isInsideApprovalCard(el) {
    let cur = el;
    for (let depth = 0; depth < 8 && cur; depth++) {
      if (approvalCards.has(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function isInsideUiOverlay(el) {
    if (!el || typeof el.closest !== 'function') return false;
    try {
      return Boolean(el.closest(DYNAMIC_UI_CONTAINER_SELECTOR));
    } catch {
      return false;
    }
  }

  function inspectForApprovalAnchor(rawText, element) {
    if (!rawText || !element) return;
    const t = rawText.trim();
    if (APPROVAL_ANCHOR_RE.test(t)) {
      markApprovalCardFromElement(element);
    }
  }

  function isEligible(rawText, element) {
    if (!enabled || typeof rawText !== 'string') return false;
    const t = rawText.trim();
    if (t.length < 14 || t.length > DYNAMIC_MAX_LEN) return false;
    if (DYNAMIC_CJK_RE.test(t)) return false;
    if (DYNAMIC_NOISE_START_RE.test(t)) return false;
    if (DYNAMIC_FILENAME_RE.test(t)) return false;
    if (DYNAMIC_CODE_RE.test(t)) return false;
    if (DYNAMIC_CMD_START_RE.test(t)) return false;

    const spaceTokens = t.split(/\s+/);
    const words = t.match(DYNAMIC_WORDS_RE);
    if (!words || words.length < 3) return false;

    // Never machine-translate model/brand names (e.g. "Gemini 4 Neon High", "Claude Sonnet 5.5")
    if (DYNAMIC_MODEL_OR_BRAND_RE.test(t) && spaceTokens.length < 6) {
      return false;
    }

    // Exception 1: Explicit command approval question header ("Allow ...?")
    if (APPROVAL_TITLE_RE.test(t) && spaceTokens.length >= 3) {
      return true;
    }

    // Strict long-sentence gate: must be >= 28 chars AND >= 5 words
    if (t.length < DYNAMIC_MIN_LEN_SENTENCE || spaceTokens.length < DYNAMIC_MIN_WORDS_SENTENCE) {
      return false;
    }

    // Must be a known system/risk prompt sentence, inside a UI dialog/overlay/marketplace/approval card,
    // or on a dedicated non-chat app route (e.g. /plugins, /marketplace, /settings, /customizations)
    if (DYNAMIC_PROMPT_TEXT_RE.test(t)) return true;
    if (element && isInsideApprovalCard(element)) return true;
    if (element && isInsideUiOverlay(element)) return true;
    if (isNonChatRoute()) return true;

    return false;
  }

  function flush() {
    flushTimer = null;
    if (!enabled || queuedTexts.size === 0) {
      queuedTexts.clear();
      return;
    }
    const batch = [...queuedTexts].slice(0, 20);
    for (const t of batch) {
      queuedTexts.delete(t);
      requestedTexts.add(t);
    }
    if (queuedTexts.size > 0) {
      flushTimer = setTimeout(flush, 150);
    }
    if (sendRequest) {
      sendRequest(batch);
    }
  }

  function enqueue(rawText, node, element) {
    if (!isEligible(rawText, element)) return false;
    const key = rawText.trim();

    let nodeSet = pendingByText.get(key);
    if (!nodeSet) {
      nodeSet = new Set();
      pendingByText.set(key, nodeSet);
    }
    if (node) nodeSet.add(node);

    if (!requestedTexts.has(key)) {
      queuedTexts.add(key);
      if (!flushTimer) {
        flushTimer = setTimeout(flush, 100);
      }
    }
    return true;
  }

  function receiveTranslations(translations) {
    if (!translations || typeof translations !== 'object') return 0;
    const nodesToUpdate = new Set();
    let appliedKeys = 0;

    for (const key of Object.keys(translations)) {
      appliedKeys++;
      const nodeSet = pendingByText.get(key);
      if (nodeSet) {
        for (const node of nodeSet) {
          if (node && node.isConnected !== false) {
            nodesToUpdate.add(node);
          }
        }
        pendingByText.delete(key);
      }
    }

    if (onApplyNodes && nodesToUpdate.size > 0) {
      onApplyNodes([...nodesToUpdate]);
    }
    return appliedKeys;
  }

  return {
    get enabled() {
      return enabled;
    },
    set enabled(val) {
      enabled = Boolean(val);
    },
    inspectForApprovalAnchor,
    isEligible,
    enqueue,
    receiveTranslations,
    clearPending() {
      pendingByText.clear();
      queuedTexts.clear();
      requestedTexts.clear();
    },
  };
}
