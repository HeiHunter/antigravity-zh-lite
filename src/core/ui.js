/**
 * Minimal dual-button floating control capsule mounted inside an isolated Shadow DOM
 * attached to document.documentElement (outside React's #root tree).
 *
 * Buttons:
 *   [● 中 / EN] | [采集 / 结束(N)]
 *   - Left button: toggle Chinese / English losslessly
 *   - Right button: click to start collecting untranslated strings -> click to finish & auto-upload
 */
export function mountControlPill(controller) {
  if (typeof document === 'undefined' || !document.documentElement) {
    return { update() {}, showToast() {}, destroy() {} };
  }

  const HOST_ID = 'ag-zh-host';
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-ag-zh-ignore', 'true');
  host.style.cssText =
    'position:fixed;right:14px;bottom:14px;z-index:2147483646;pointer-events:auto;';

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .bar {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        border: 1px solid rgba(128, 128, 128, 0.28);
        background: rgba(24, 24, 27, 0.76);
        color: #f4f4f5;
        font: 500 11px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
        letter-spacing: 0.2px;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        user-select: none;
        opacity: 0.48;
        overflow: hidden;
        transition: opacity 0.16s ease, transform 0.16s ease, background 0.16s ease, border-color 0.16s ease;
      }
      .bar:hover,
      .bar.collecting,
      .bar.uploading {
        opacity: 1;
        background: rgba(24, 24, 27, 0.94);
      }
      .bar.collecting {
        border-color: rgba(245, 158, 11, 0.65);
      }
      .bar.hidden {
        display: none;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 5px 9px;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.14s ease;
      }
      .btn:hover {
        background: rgba(255, 255, 255, 0.1);
      }
      .divider {
        width: 1px;
        height: 12px;
        background: rgba(255, 255, 255, 0.16);
      }
      .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #22c55e;
        flex-shrink: 0;
      }
      .btn-lang.off .dot {
        background: #71717a;
      }
      .btn-collect {
        color: #d4d4d8;
      }
      .btn-collect.active {
        color: #fbbf24;
      }
      .pulse {
        display: none;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #f59e0b;
        animation: ag-zh-pulse 1.2s ease-in-out infinite;
      }
      .btn-collect.active .pulse {
        display: inline-block;
      }
      @keyframes ag-zh-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.45; transform: scale(0.8); }
      }
      .toast {
        position: fixed;
        right: 14px;
        bottom: 46px;
        max-width: 340px;
        padding: 7px 11px;
        border-radius: 8px;
        background: rgba(24, 24, 27, 0.94);
        color: #f4f4f5;
        font: 400 12px/1.35 -apple-system, BlinkMacSystemFont, sans-serif;
        border: 1px solid rgba(255, 255, 255, 0.14);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.18s ease;
      }
      .toast.show {
        opacity: 1;
      }
    </style>
    <div class="bar">
      <button class="btn btn-lang" type="button" title="切换中/英文 (Option/Alt+Shift+L)">
        <span class="dot"></span>
        <span class="lang-label">中</span>
      </button>
      <span class="divider"></span>
      <button class="btn btn-collect" type="button" title="点击开始采集未译词条，再次点击结束并自动上传 (Option/Alt+Shift+C)">
        <span class="pulse"></span>
        <span class="collect-label">采集</span>
      </button>
    </div>
    <div class="toast"></div>
  `;

  const bar = shadow.querySelector('.bar');
  const langBtn = shadow.querySelector('.btn-lang');
  const langLabel = shadow.querySelector('.lang-label');
  const collectBtn = shadow.querySelector('.btn-collect');
  const collectLabel = shadow.querySelector('.collect-label');
  const toast = shadow.querySelector('.toast');
  let toastTimer = null;

  function showToast(msg, duration = 2600) {
    toast.textContent = msg;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
  }

  function update() {
    const state = controller.getState();
    bar.classList.toggle('hidden', state.pillHidden);
    bar.classList.toggle('collecting', state.collecting);
    bar.classList.toggle('uploading', state.uploading);
    langBtn.classList.toggle('off', !state.enabled);
    langLabel.textContent = state.enabled ? '中' : 'EN';

    collectBtn.classList.toggle('active', state.collecting);
    if (state.uploading) {
      collectLabel.textContent = '上传中…';
    } else if (state.collecting) {
      collectLabel.textContent = `结束 (${state.collectedCount})`;
    } else {
      collectLabel.textContent = '采集';
    }
  }

  function handleCollectClick() {
    const state = controller.getState();
    if (state.uploading) return;
    if (!state.collecting) {
      controller.startCollection();
      showToast('已开始采集：浏览需要汉化的页面后，点击「结束」即可自动上传');
    } else {
      controller.finishAndUploadCollection();
    }
    update();
  }

  langBtn.addEventListener('click', () => {
    const enabled = controller.toggle();
    showToast(enabled ? '已切换为中文界面' : '已恢复英文原版');
    update();
  });

  collectBtn.addEventListener('click', handleCollectClick);

  function onKeyDown(e) {
    if (!e.altKey || !e.shiftKey) return;
    if (e.code === 'KeyL') {
      e.preventDefault();
      const enabled = controller.toggle();
      showToast(enabled ? '已切换为中文界面' : '已恢复英文原版');
      update();
    } else if (e.code === 'KeyC') {
      e.preventDefault();
      handleCollectClick();
    } else if (e.code === 'KeyH') {
      e.preventDefault();
      const hidden = controller.togglePillVisibility();
      if (!hidden) showToast('已显示汉化悬浮开关');
      update();
    }
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.documentElement.appendChild(host);
  update();

  return {
    update,
    showToast,
    destroy() {
      document.removeEventListener('keydown', onKeyDown, true);
      host.remove();
    },
  };
}
