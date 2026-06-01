// ============================================================
// background.js – Complete backend with all modules
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

    // Apply proxy
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
    if (step.extractRegex) {
      const m = text.match(new RegExp(step.extractRegex));
      if (m) extracted[step.extractName] = m[1];
    }
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

// ---------- Fingerprint Injector ----------
class FingerprintInjector {
  constructor(config) { this.config = config || {}; }
  generateCode() {
    const cfg = this.config;
    return `
      (function() {
        if (${!!cfg.canvas?.enabled}) {
          const seed = ${cfg.canvas?.seed || 12345};
          const orig = CanvasRenderingContext2D.prototype.getImageData;
          CanvasRenderingContext2D.prototype.getImageData = function(...args) {
            const img = orig.apply(this, args);
            for (let i = 0; i < img.data.length; i += 4) {
              img.data[i]   = Math.min(255, Math.max(0, Math.round(img.data[i] + (Math.sin((seed + i) * 1.618) * 0.5 - 0.5) * 2)));
              img.data[i+1] = Math.min(255, Math.max(0, Math.round(img.data[i+1] + (Math.sin((seed + i + 1) * 1.618) * 0.5 - 0.5) * 2)));
            }
            return img;
          };
        }
        if (${!!cfg.audio?.enabled}) {
          const noise = ${cfg.audio?.noise || 0.001};
          const orig2 = AudioBuffer.prototype.getChannelData;
          AudioBuffer.prototype.getChannelData = function(channel) {
            const data = orig2.call(this, channel);
            for (let i = 0; i < data.length; i++) data[i] += (Math.random() - 0.5) * noise;
            return data;
          };
        }
        if (${!!cfg.fonts?.enabled}) {
          const fonts = ${JSON.stringify(cfg.fonts?.list || ['Arial','Times New Roman','Courier New'])};
          Object.defineProperty(document, 'fonts', {
            get: () => ({
              ready: Promise.resolve({
                forEach: (cb) => fonts.forEach(f => cb({ family: f })),
                keys: () => fonts.keys(),
                values: () => fonts.values(),
                entries: () => fonts.entries()
              })
            })
          });
        }
        if (${!!cfg.webgl?.enabled}) {
          const vendor = ${JSON.stringify(cfg.webgl?.vendor || "Google Inc. (Intel)")};
          const renderer = ${JSON.stringify(cfg.webgl?.renderer || "ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)")};
          const orig3 = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function(p) {
            if (p === 37445) return vendor;
            if (p === 37446) return renderer;
            return orig3.call(this, p);
          };
          const orig4 = WebGL2RenderingContext.prototype.getParameter;
          WebGL2RenderingContext.prototype.getParameter = function(p) {
            if (p === 37445) return vendor;
            if (p === 37446) return renderer;
            return orig4.call(this, p);
          };
        }
        if (${!!cfg.navigator?.userAgent}) {
          Object.defineProperty(navigator, 'userAgent', { get: () => ${JSON.stringify(cfg.navigator.userAgent)}, configurable: false });
        }
        if (${!!cfg.navigator?.platform}) {
          Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(cfg.navigator.platform)}, configurable: false });
        }
        if (${!!cfg.navigator?.hardwareConcurrency}) {
          Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${cfg.navigator.hardwareConcurrency}, configurable: false });
        }
        if (${!!cfg.navigator?.deviceMemory}) {
          Object.defineProperty(navigator, 'deviceMemory', { get: () => ${cfg.navigator.deviceMemory}, configurable: false });
        }
        if (${!!cfg.screen?.width}) {
          Object.defineProperty(screen, 'width', { get: () => ${cfg.screen.width} });
        }
        if (${!!cfg.screen?.height}) {
          Object.defineProperty(screen, 'height', { get: () => ${cfg.screen.height} });
        }
        if (${!!cfg.screen?.colorDepth}) {
          Object.defineProperty(screen, 'colorDepth', { get: () => ${cfg.screen.colorDepth} });
        }
      })();
    `;
  }
}

// ---------- Instantiate modules ----------
const proxyManager = new ProxyManager();
const steps = new StepRunner();
const external = new ExternalService();
const fingerprint = new FingerprintInjector();

// Load stored configs
chrome.storage.sync.get(['proxyList', 'stepsConfig', 'externalConfig', 'fingerprintConfig'], (data) => {
  proxyManager.init(data.proxyList);
  steps.init(data.stepsConfig);
  external.init(data.externalConfig);
  fingerprint.config = data.fingerprintConfig || {};
});

// Inject fingerprint on every page load (main frame only)
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId === 0) {
    const code = fingerprint.generateCode();
    try {
      await chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        world: 'MAIN',
        runAt: 'document_start',
        func: new Function(code) // execute as function
      });
    } catch (e) { /* ignore */ }
  }
});

// ---------- Message handler ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'performLogin':
      handleLogin(msg.params).then(sendResponse).catch(e => sendResponse({error: e.message}));
      return true;
    case 'updateProxy':
      proxyManager.updateList(msg.list);
      sendResponse({ok:true});
      break;
    case 'updateSteps':
      steps.updateConfig(msg.config);
      sendResponse({ok:true});
      break;
    case 'updateExternal':
      external.init(msg.config);
      chrome.storage.sync.set({ externalConfig: msg.config });
      sendResponse({ok:true});
      break;
    case 'updateFingerprint':
      fingerprint.config = msg.config;
      chrome.storage.sync.set({ fingerprintConfig: msg.config });
      // Re‑inject into current tab
      chrome.tabs.query({active: true, currentWindow: true}, async (tabs) => {
        if (tabs[0]) {
          const code = fingerprint.generateCode();
          await chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            world: 'MAIN',
            runAt: 'document_start',
            func: new Function(code)
          });
        }
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
    return await steps.run(seq.steps, { proxyManager, external });
  }
  // Single request
  const activeProxy = proxyManager.getActive();
  if (activeProxy) await proxyManager.applyProxy(activeProxy);
  const cookieString = Object.entries(cookies).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('; ');
  const fetchHeaders = { ...headers };
  if (cookieString) fetchHeaders.Cookie = cookieString;
  const opts = { method: method || 'GET', headers: fetchHeaders, credentials: 'omit' };
  if (body && method !== 'GET') opts.body = body;
  const resp = await fetch(url, opts);
  const ct = resp.headers.get('content-type') || '';
  let data;
  if (ct.includes('application/json')) data = await resp.json();
  else data = await resp.text();
  return { success: true, status: resp.status, data };
}
