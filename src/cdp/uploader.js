import fs from 'node:fs';
import path from 'node:path';

/**
 * Load optional user configuration from ag-zh.config.json
 */
export function loadConfig(rootDir) {
  const defaults = {
    port: Number(process.env.AG_ZH_PORT || 9229),
    app: process.env.AG_ZH_APP || '',
    autoFollow: true,
    watchDicts: true,
    dynamicTranslate: {
      enabled: true,
      provider: 'google', // 'google' | 'openai' | 'gemini'
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
    console.warn(`[ag-zh] 读取配置文件失败，使用默认配置: ${err.message}`);
    return defaults;
  }
}

/**
 * Save collected untranslated strings locally (with optional merge into dicts/_collected.json)
 * and optionally auto-upload to a configured Webhook / GitHub Issue / GitHub Gist.
 */
export async function handleCollectedUpload({ rootDir, payload, meta = {}, config }) {
  const exact = payload && typeof payload.exact === 'object' ? payload.exact : {};
  const incomingCount = Object.keys(exact).length;
  const uploadCfg = (config && config.upload) || {};

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

  // Optional remote upload
  const mode = uploadCfg.mode || (uploadCfg.webhookUrl ? 'webhook' : 'local');
  const uploadBody = {
    source: 'antigravity-zh-lite',
    collectedAt: new Date().toISOString(),
    pageUrl: meta.url || '',
    incomingCount,
    exact,
  };

  try {
    if ((mode === 'webhook' || uploadCfg.webhookUrl) && uploadCfg.webhookUrl) {
      const res = await fetch(uploadCfg.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(uploadCfg.webhookHeaders || {}),
        },
        body: JSON.stringify(uploadBody),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      result.remoteStatus = 'uploaded';
      result.remoteUrl = uploadCfg.webhookUrl;
    } else if (mode === 'github-issue' && uploadCfg.githubRepo && uploadCfg.githubToken) {
      const res = await fetch(`https://api.github.com/repos/${uploadCfg.githubRepo}/issues`, {
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
      });
      if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
      const data = await res.json();
      result.remoteStatus = 'uploaded';
      result.remoteUrl = data.html_url || null;
    } else if (mode === 'github-gist' && uploadCfg.githubToken) {
      const res = await fetch('https://api.github.com/gists', {
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
      });
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
