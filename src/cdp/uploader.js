import fs from 'node:fs';
import path from 'node:path';
import { smartFetch } from './proxy.js';

export const DEFAULT_CDP_PORT = 19229;
const UPLOAD_TIMEOUT_MS = 10000;

/**
 * Load user configuration from ag-zh.config.json.
 * Fail-closed on parse errors: keeps static localization working,
 * but disables online dynamic translation, remote upload, and auto-follow
 * so a typo in JSON never silently re-enables network features.
 */
export function loadConfig(rootDir) {
  const defaults = {
    port: Number(process.env.AG_ZH_PORT || DEFAULT_CDP_PORT),
    app: process.env.AG_ZH_APP || '',
    autoFollow: true,
    watchDicts: true,
    dynamicTranslate: {
      enabled: true,
      provider: 'google', // 'google' | 'mymemory' | 'openai' | 'gemini'
      proxy: process.env.AG_ZH_PROXY || '',
      maxCacheSize: 2000,
      timeoutMs: 5000,
      apiBaseUrl: process.env.AG_ZH_TRANSLATE_URL || '',
      apiKey: process.env.AG_ZH_TRANSLATE_KEY || '',
      model: process.env.AG_ZH_TRANSLATE_MODEL || '',
    },
    upload: {
      mode: 'local', // 'local' | 'webhook' | 'github-issue' | 'github-gist'
      mergeLocal: true,
      webhookUrl: process.env.AG_ZH_UPLOAD_URL || '',
      webhookHeaders: {},
      githubRepo: process.env.AG_ZH_GITHUB_REPO || '',
      githubToken: process.env.AG_ZH_GITHUB_TOKEN || '',
    },
  };

  const configPath = path.join(rootDir, 'ag-zh.config.json');
  if (!fs.existsSync(configPath)) return defaults;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Config root must be a JSON object');
    }
    return {
      ...defaults,
      ...raw,
      dynamicTranslate: {
        ...defaults.dynamicTranslate,
        ...(raw.dynamicTranslate || {}),
      },
      upload: {
        ...defaults.upload,
        ...(raw.upload || {}),
      },
    };
  } catch (err) {
    console.error(
      `[ag-zh] 配置文件 ag-zh.config.json 解析失败 (${err.message})，已进入安全回退模式（仅静态汉化，暂停联网翻译/远程上传/自动接管）。`
    );
    return {
      ...defaults,
      autoFollow: false,
      _configError: err.message,
      dynamicTranslate: {
        ...defaults.dynamicTranslate,
        enabled: false,
      },
      upload: {
        ...defaults.upload,
        mode: 'local',
        webhookUrl: '',
        githubToken: '',
      },
    };
  }
}

export function formatUploadModeLabel(uploadCfg = {}) {
  const mode = uploadCfg.mode || 'local';
  if (mode === 'webhook' && uploadCfg.webhookUrl) {
    return `webhook (${uploadCfg.webhookUrl})`;
  }
  return mode;
}

/**
 * Save collected untranslated strings locally (with optional merge into dicts/_collected.json)
 * and optionally auto-upload ONLY when upload.mode explicitly requests a remote target.
 */
export async function handleCollectedUpload({ rootDir, payload, meta = {}, config }) {
  const exact = payload && typeof payload.exact === 'object' ? payload.exact : {};
  const incomingCount = Object.keys(exact).length;
  const uploadCfg = (config && config.upload) || {};
  const proxy = config?.dynamicTranslate?.proxy || '';

  const localPath = path.join(rootDir, 'dicts', '_collected.json');
  let finalExact = { ...exact };

  if (uploadCfg.mergeLocal !== false && fs.existsSync(localPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      if (prev && typeof prev.exact === 'object') {
        finalExact = { ...prev.exact, ...exact };
      }
    } catch {
      // Overwrite corrupted file
    }
  }

  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, JSON.stringify({ exact: finalExact }, null, 2) + '\n', 'utf8');

  const totalCount = Object.keys(finalExact).length;
  const result = {
    ok: true,
    incomingCount,
    totalCount,
    localPath,
    remoteStatus: 'local-only',
    remoteUrl: null,
    remoteError: null,
  };

  if (incomingCount === 0) {
    return result;
  }

  // Strictly honor upload.mode; never fire webhook when mode === 'local'
  const mode = uploadCfg.mode || 'local';
  if (mode === 'local') {
    return result;
  }

  const uploadBody = {
    source: 'antigravity-zh-lite',
    collectedAt: new Date().toISOString(),
    pageUrl: meta.url || '',
    incomingCount,
    exact,
  };

  try {
    if (mode === 'webhook' && uploadCfg.webhookUrl) {
      const res = await smartFetch(
        uploadCfg.webhookUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(uploadCfg.webhookHeaders || {}),
          },
          body: JSON.stringify(uploadBody),
        },
        { timeoutMs: UPLOAD_TIMEOUT_MS, proxy }
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      result.remoteStatus = 'uploaded';
      result.remoteUrl = uploadCfg.webhookUrl;
    } else if (mode === 'github-issue' && uploadCfg.githubRepo && uploadCfg.githubToken) {
      const res = await smartFetch(
        `https://api.github.com/repos/${uploadCfg.githubRepo}/issues`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${uploadCfg.githubToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity-zh-lite',
          },
          body: JSON.stringify({
            title: `[词条采集] 新增 ${incomingCount} 条未翻译 UI 文案 (${new Date().toISOString().slice(0, 10)})`,
            labels: ['i18n', 'collected'],
            body: `自动上传自 \`antigravity-zh-lite\`（共 ${incomingCount} 条）：\n\n\`\`\`json\n${JSON.stringify({ exact }, null, 2)}\n\`\`\``,
          }),
        },
        { timeoutMs: UPLOAD_TIMEOUT_MS, proxy }
      );
      if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
      const data = await res.json();
      result.remoteStatus = 'uploaded';
      result.remoteUrl = data.html_url || null;
    } else if (mode === 'github-gist' && uploadCfg.githubToken) {
      const res = await smartFetch(
        'https://api.github.com/gists',
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${uploadCfg.githubToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity-zh-lite',
          },
          body: JSON.stringify({
            description: `antigravity-zh-lite collected UI strings (${incomingCount})`,
            public: false,
            files: {
              '_collected.json': {
                content: JSON.stringify({ exact }, null, 2) + '\n',
              },
            },
          }),
        },
        { timeoutMs: UPLOAD_TIMEOUT_MS, proxy }
      );
      if (!res.ok) throw new Error(`GitHub Gist HTTP ${res.status}`);
      const data = await res.json();
      result.remoteStatus = 'uploaded';
      result.remoteUrl = data.html_url || null;
    }
  } catch (err) {
    result.remoteStatus = 'remote-failed';
    result.remoteError = err.message;
  }

  return result;
}
