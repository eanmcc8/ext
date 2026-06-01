// ============================================================
// background.js – Service Worker with all backend logic
// ============================================================

// ---------- Proxy Manager ----------
class ProxyManager {
  constructor() {
    this.proxies = [];
    this.activeIndex = 0;
  }
  init(list) { this.proxies = list || []; }
  updateList(list) {
    this.proxies = list;
    chrome.storage.sync.set({ proxyList: list });
  }
  getActive() {
    if (this.proxies.length === 0) return null;
    const p = this.proxies[this.activeIndex];
    this.activeIndex = (this.activeIndex + 1) % this.proxies.length;
    return p;
  }
  async applyProxy(proxy) {
    if (!proxy) { await chrome.proxy.settings.clear({}); return; }
    await chrome.proxy.settings.set({
      value: {
        mode: "fixed_servers",
        rules: {
          singleProxy: { scheme: proxy.scheme || "http", host: proxy.host, port: proxy.port },
          bypassList: ["<local>"]
        }
      }
    });
  }
}

// ---------- Step Runner ----------
class StepRunner {
  constructor() { this.sequences = {}; }
  init(config) { this.sequences = config || {}; }
  updateConfig(config) {
    this.sequences = config;
    chrome.storage.sync.set({ stepsConfig: config });
  }
  getSequence(url) {
    for (const pattern in this.sequences)
      if (url.includes(pattern)) return this.sequences[pattern];
    return null;
  }
  async run(steps, context) {
    let acc = {};
    for (const step of steps) {
      const r = await this.executeStep(step, context, acc);
      acc = { ...acc, ...r.extracted };
    }
    return { success: true, data: acc };
  }
  async executeStep(step, context, prevData) {
    const url = this.mergeValues(step.url, prevData);
    const headers = this.mergeHeaders(step.headers, prevData);
    let body = this.mergeValues(step.body, prevData);

    // External actions
    if (step.externalAction === '2fa') {
      const code = await context.external.get2FACode(step.totpSecret);
      if (typeof body === 'object') body[step.fieldName] = code;
    }
    if (step.externalAction === 'captcha') {
      const token = await context.external.solveCaptcha(url);
      if (typeof body === 'object') body[step.captchaField] = token;
    }

    // Apply proxy for this step
    const proxy = context.proxyManager.getActive();
    if (proxy) await context.proxyManager.applyProxy(proxy);

    const opts = {
      method: step.method || 'GET',
      headers: { ...headers },
      credentials: 'omit'
    };
    if (body && step.method !== 'GET') opts.body = JSON.stringify(body);

    const resp = await fetch(url, opts);
    const text = await resp.text();
    const extracted = {};

    // Extract cookies from response headers
    if (step.extractCookies) {
      const sc = resp.headers.get('set-cookie');
      if (sc) {
        const cookies = {};
        sc.split(',').forEach(pair => {
          const p = pair.split(';')[0].trim();
          const i = p.indexOf('=');
          if (i !== -1) cookies[p.substring(0,i).trim()] = p.substring(i+1).trim();
        });
        extracted.cookies = cookies;
      }
    }
    // Extract regex
    if (step.extractRegex) {
      const m = text.match(new RegExp(step.extractRegex));
      if (m) extracted[step.extractName] = m[1];
    }
    // Extract JSON path
    if (step.extractJsonPath) {
      try {
        const json = JSON.parse(text);
        let v = json;
        for (const k of step.extractJsonPath.split('.')) { if (v) v = v[k]; else break; }
        if (v !== undefined) extracted[step.extractName] = v;
      } catch(e) {}
    }
    return { data: text, extracted };
  }
  mergeValues(template, data) {
    if (!template) return template;
    if (typeof template === 'string') return template.replace(/\{\{(\w+)\}\}/g, (_,k) => data[k] !== undefined ? data[k] : _);
    if (typeof template === 'object') {
      const r = {};
      for (const [k,v] of Object.entries(template)) r[k] = this.mergeValues(v, data);
      return r;
    }
    return template;
  }
  mergeHeaders(headers, data) {
    if (!headers) return {};
    const r = {};
    for (const [k,v] of Object.entries(headers)) r[k] = this.mergeValues(v, data);
    return r;
  }
}

// ---------- External Services ----------
class ExternalService {
  constructor() { this.endpoints = {}; }
  init(config) { this.endpoints = config || {}; }
  async get2FACode(secret) {
    if (!this.endpoints.totp) throw new Error('No TOTP endpoint');
    const r = await fetch(`${this.endpoints.totp}?secret=${encodeURIComponent(secret)}`);
    const j = await r.json();
    return j.code;
  }
  async solveCaptcha(pageUrl) {
    if (!this.endpoints.captcha) throw new Error('No captcha endpoint');
    const r = await fetch(this.endpoints.captcha, {
      method: 'POST',
      body: JSON.stringify({ url: pageUrl }),
      headers: { 'Content-Type': 'application/json' }
    });
    const j = await r.json();
    return j.token;
  }
}

// ---------- Instantiate modules ----------
const proxy = new ProxyManager();
const steps = new StepRunner();
const ext = new ExternalService();

// Load stored configs
chrome.storage.sync.get(['proxyList', 'stepsConfig', 'externalConfig'], (data) => {
  proxy.init(data.proxyList);
  steps.init(data.stepsConfig);
  ext.init(data.externalConfig);
});

// ---------- Message handler ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'performLogin':
      handleLogin(msg.params).then(sendResponse).catch(e => sendResponse({error: e.message}));
      return true;
    case 'updateProxy':
      proxy.updateList(msg.list);
      sendResponse({ok:true});
      break;
    case 'updateSteps':
      steps.updateConfig(msg.config);
      sendResponse({ok:true});
      break;
    case 'updateExternal':
      ext.init(msg.config);
      chrome.storage.sync.set({ externalConfig: msg.config });
      sendResponse({ok:true});
      break;
    case 'updateFingerprint':
      // fingerprint config is saved to storage, content script picks it up on page load / reload
      chrome.storage.sync.set({ fingerprintConfig: msg.config });
      // Reload active tab to apply new fingerprint
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (tabs[0]) chrome.tabs.reload(tabs[0].id);
      });
      sendResponse({ok:true});
      break;
    default:
      sendResponse({error: 'Unknown message type'});
  }
});

// ---------- Login execution ----------
async function handleLogin(params) {
  const { url, cookies, headers, method, body } = params;

  // Check multi-step sequence
  const seq = steps.getSequence(url);
  if (seq && seq.steps && seq.steps.length > 0) {
    return await steps.run(seq.steps, { proxyManager: proxy, external: ext });
  }

  // Single request
  const activeProxy = proxy.getActive();
  if (activeProxy) await proxy.applyProxy(activeProxy);

  const cookieString = Object.entries(cookies).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('; ');
  const fetchHeaders = { ...headers };
  if (cookieString) fetchHeaders.Cookie = cookieString;

  const opts = {
    method: method || 'GET',
    headers: fetchHeaders,
    credentials: 'omit'
  };
  if (body && method !== 'GET') opts.body = body;

  const resp = await fetch(url, opts);
  const ct = resp.headers.get('content-type') || '';
  let data;
  if (ct.includes('application/json')) data = await resp.json();
  else data = await resp.text();
  return { success: true, status: resp.status, data };
}