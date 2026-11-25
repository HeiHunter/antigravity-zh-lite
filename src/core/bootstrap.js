import { createMatcher } from './matcher.js';
import { createDynamicQueue } from './dynamic.js';
import { createDomTranslator } from './walker.js';
import { createThrottledObserver } from './observer.js';
import { createCollector } from './collector.js';
import { mountControlPill } from './ui.js';

const STORAGE_KEY = 'ag_zh_lite_state_v1';

function readPersistedState() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { enabled: true, pillHidden: false };
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled !== false,
      pillHidden: Boolean(parsed.pillHidden),
    };
  } catch {
    return { enabled: true, pillHidden: false };
  }
}

function savePersistedState(state) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ enabled: state.enabled, pillHidden: state.pillHidden })
      );
    }
  } catch {
    // ignore storage restriction
  }
}

function triggerFallbackDownload(jsonStr) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(jsonStr).catch(() => {});
    }
    if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof document === 'undefined') {
      return false;
    }
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '_collected.json';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 500);
    return true;
  } catch {
    return false;
  }
}

const ENGINE_VERSION = '1.1.0';
const UNINSTALLED_SESSION_KEY = '__ag_zh_uninstalled__';

export function bootAntigravityZh(globalObj, initialDict) {
  // Top-frame guard: never mount inside embedded child iframes (e.g. MCP Apps / HTML previews / plugin boards)
  if (globalObj && globalObj.self && globalObj.top && globalObj.self !== globalObj.top) {
    return null;
  }

  // Post-uninstall reload guard: if uninstall tore down this tab, prevent any leftover preload script from re-mounting on reload
  try {
    const store = globalObj && globalObj.sessionStorage;
    if (store && typeof store.getItem === 'function' && store.getItem(UNINSTALLED_SESSION_KEY) === '1') {
      return null;
    }
  } catch {
    // ignore storage restriction
  }

  // Idempotent re-injection for same engine version; clean hot-upgrade if engine version changed
  if (globalObj.__AG_ZH__ && typeof globalObj.__AG_ZH__.updateDict === 'function') {
    if (globalObj.__AG_ZH__.version === ENGINE_VERSION) {
      if (typeof globalObj.__AG_ZH__.ensureMounted === 'function') {
        globalObj.__AG_ZH__.ensureMounted();
      }
      globalObj.__AG_ZH__.updateDict(initialDict);
      return globalObj.__AG_ZH__;
    }
    const prevState = readPersistedState();
    try {
      if (typeof globalObj.__AG_ZH__.destroy === 'function') {
        globalObj.__AG_ZH__.destroy();
      } else if (typeof globalObj.__AG_ZH__.disable === 'function') {
        globalObj.__AG_ZH__.disable();
        savePersistedState(prevState);
      }
    } catch {
      // ignore teardown errors from older version
    }
    delete globalObj.__AG_ZH__;
  }

  const persisted = readPersistedState();
  let enabled = persisted.enabled;
  let pillHidden = persisted.pillHidden;
  let uploading = false;
  let uiUpdateTimer = null;

  let matcher = createMatcher(initialDict);
  let translator = null;
  let ui = null;

  const dynamicQueue = createDynamicQueue({
    sendRequest(texts) {
      if (!enabled || !texts || texts.length === 0) return;
      if (typeof globalObj.__AG_ZH_BRIDGE__ !== 'function') return;
      try {
        globalObj.__AG_ZH_BRIDGE__(
          JSON.stringify({
            type: 'translate_dynamic',
            texts,
          })
        );
      } catch {
        // ignore bridge error
      }
    },
    onApplyNodes(nodes) {
      if (!enabled || !translator) return;
      for (let i = 0; i < nodes.length; i++) {
        translator.translateTextNode(nodes[i]);
      }
    },
  });

  translator = createDomTranslator(matcher, {
    ignoreSelectors: initialDict.ignoreSelectors,
    dynamicQueue,
  });

  const collector = createCollector(() => {
    if (!ui || uiUpdateTimer) return;
    uiUpdateTimer = setTimeout(() => {
      uiUpdateTimer = null;
      if (ui) ui.update();
    }, 150);
  });

  const observer = createThrottledObserver(translator, () => collector);

  function getRoot() {
    if (typeof document === 'undefined') return null;
    return document.body || document.documentElement;
  }

  function applyIfReady() {
    const root = getRoot();
    if (!root) return;
    if (enabled && !observer.isRunning()) {
      observer.start(root);
    }
    if (!ui || (typeof document !== 'undefined' && !document.getElementById('ag-zh-host'))) {
      ui = mountControlPill(api);
    } else {
      ui.update();
    }
  }

  const api = {
    version: ENGINE_VERSION,
    ensureMounted() {
      applyIfReady();
    },
    destroy() {
      observer.stop();
      const root = getRoot();
      if (root) translator.restoreSubtree(root);
      if (ui && typeof ui.destroy === 'function') ui.destroy();
      ui = null;
    },
    enable() {
      if (enabled) return true;
      enabled = true;
      dynamicQueue.enabled = true;
      savePersistedState({ enabled, pillHidden });
      const root = getRoot();
      if (root) observer.start(root);
      if (ui) ui.update();
      return true;
    },
    disable() {
      if (!enabled) return false;
      enabled = false;
      dynamicQueue.enabled = false;
      savePersistedState({ enabled, pillHidden });
      observer.stop();
      const root = getRoot();
      if (root) translator.restoreSubtree(root);
      if (ui) ui.update();
      return false;
    },
    toggle() {
      return enabled ? this.disable() : this.enable();
    },
    togglePillVisibility() {
      pillHidden = !pillHidden;
      savePersistedState({ enabled, pillHidden });
      if (ui) ui.update();
      return pillHidden;
    },
    updateDict(nextDict) {
      const prevDynamic = matcher.getDynamicEntries ? matcher.getDynamicEntries() : {};
      matcher = createMatcher(nextDict);
      matcher.addDynamicBatch(prevDynamic);
      const root = getRoot();
      if (enabled && root) {
        observer.stop();
        translator.restoreSubtree(root);
        translator.setMatcher(matcher, nextDict.ignoreSelectors);
        observer.start(root);
      } else {
        translator.setMatcher(matcher, nextDict.ignoreSelectors);
      }
      if (ui) {
        ui.update();
        ui.showToast('词库已热更新');
      }
    },
    __onDynamicTranslations(translations) {
      if (!translations || typeof translations !== 'object') return 0;
      const added = matcher.addDynamicBatch(translations);
      dynamicQueue.receiveTranslations(translations);
      if (enabled && added > 0) {
        const root = getRoot();
        if (root) translator.translateSubtree(root);
      }
      return added;
    },
    startCollection() {
      collector.clear();
      collector.enabled = true;
      const root = getRoot();
      if (root) {
        translator.translateSubtree(root, collector);
      }
      if (ui) ui.update();
      return true;
    },
    setCollector(on) {
      collector.enabled = Boolean(on);
      const root = getRoot();
      if (collector.enabled && root) {
        translator.translateSubtree(root, collector);
      }
      if (ui) ui.update();
      return collector.enabled;
    },
    finishAndUploadCollection() {
      const payload = collector.exportDictTemplate();
      const count = collector.size();
      collector.enabled = false;

      if (count === 0) {
        if (ui) {
          ui.update();
          ui.showToast('本次未采集到新的未译词条');
        }
        return { ok: true, count: 0 };
      }

      if (typeof globalObj.__AG_ZH_BRIDGE__ === 'function') {
        uploading = true;
        if (ui) {
          ui.update();
          ui.showToast(`正在自动保存并上传 ${count} 条词条…`, 4000);
        }
        try {
          globalObj.__AG_ZH_BRIDGE__(
            JSON.stringify({
              type: 'upload_collected',
              payload,
              meta: {
                url: typeof location !== 'undefined' ? location.href : '',
                count,
              },
            })
          );
          return { ok: true, pending: true, count };
        } catch {
          uploading = false;
        }
      }

      const jsonStr = JSON.stringify(payload, null, 2) + '\n';
      triggerFallbackDownload(jsonStr);
      if (ui) {
        ui.update();
        ui.showToast(`守护未连接，已下载 _collected.json 并复制 (${count} 条)`, 3500);
      }
      return { ok: true, fallback: true, count };
    },
    __onUploadResult(res) {
      uploading = false;
      if (ui) {
        ui.update();
        if (!res || !res.ok) {
          ui.showToast(`上传失败：${(res && res.error) || '未知错误'}`, 4000);
        } else if (res.remoteStatus === 'uploaded') {
          ui.showToast(
            `已自动上传 ${res.incomingCount} 条（本地累计 ${res.totalCount} 条已同步）`,
            3800
          );
        } else if (res.remoteStatus === 'remote-failed') {
          ui.showToast(
            `已保存本地 (${res.incomingCount} 条)，远端上传失败：${res.remoteError}`,
            4200
          );
        } else {
          ui.showToast(
            `采集完成：已自动写入 dicts/_collected.json（新增 ${res.incomingCount} 条，共 ${res.totalCount} 条）`,
            3800
          );
        }
      }
    },
    exportCollected() {
      return collector.exportDictTemplate();
    },
    getCollectedItems() {
      return collector.getItems();
    },
    clearCollected() {
      collector.clear();
      if (ui) ui.update();
    },
    getState() {
      return {
        enabled,
        pillHidden,
        collecting: collector.enabled,
        uploading,
        collectedCount: collector.size(),
        translatedCount: translator.getTranslatedCount(),
        dynamicCacheSize: matcher.getDynamicSize(),
        dictStats: matcher.stats,
      };
    },
  };

  globalObj.__AG_ZH__ = api;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyIfReady, { once: true });
    } else {
      applyIfReady();
    }
  }

  return api;
}
