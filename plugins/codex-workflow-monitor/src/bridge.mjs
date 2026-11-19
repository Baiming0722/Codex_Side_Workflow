import { App } from '@modelcontextprotocol/ext-apps';

const app = new App(
  { name: 'codex-workflow-monitor', version: '0.3.3' },
  {},
  { autoResize: true }
);

const POLL_INTERVAL_MS = 1500;
let polling = false;
let pendingRepoll = false;
let pollSeq = 0;
let pollTimer = null;
let selectedSessionId = '__auto__';
let selectedScope = 'session';
let hostConnected = false;

try {
  const savedScope = window.localStorage?.getItem('codex_wf_scope');
  if (savedScope === 'turn' || savedScope === 'session') selectedScope = savedScope;
} catch {}

function unpack(result) {
  if (!result) return null;
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const item = Array.isArray(result.content)
    ? result.content.find(x => x && x.type === 'text' && typeof x.text === 'string')
    : null;
  if (!item) return null;
  try {
    return JSON.parse(item.text);
  } catch {
    return null;
  }
}

function deliverState(payload) {
  if (!payload || typeof payload !== 'object') return;
  try {
    if (typeof window.receiveWorkflowState === 'function') {
      window.receiveWorkflowState(payload);
    } else if (typeof window.receiveWorkflowEvents === 'function') {
      window.receiveWorkflowEvents(payload);
    }
  } catch (err) {
    console.error('Codex Workflow UI render error:', err);
  }
}

async function callHostTool(name, args) {
  if (hostConnected) {
    return await app.callServerTool({ name, arguments: args });
  }
  if (typeof window !== 'undefined' && window.openai && typeof window.openai.callTool === 'function') {
    return await window.openai.callTool(name, args);
  }
  throw new Error('MCP App host unavailable');
}

async function poll() {
  if (document.hidden) return;
  if (polling) {
    pendingRepoll = true;
    return;
  }
  polling = true;
  const reqSeq = ++pollSeq;
  try {
    const args = {
      session_id: selectedSessionId || '__auto__',
      scope: selectedScope,
      limit: 60,
    };
    const result = await callHostTool('read_workflow_events', args);
    const payload = unpack(result);
    if (payload && reqSeq === pollSeq) {
      deliverState(payload);
    }
  } catch (error) {
    if (reqSeq === pollSeq) {
      const banner = document.getElementById('modeText');
      if (banner) banner.textContent = '重連中…';
    }
    console.error('Codex Workflow Monitor poll failed:', error);
  } finally {
    polling = false;
    if (pendingRepoll && !document.hidden) {
      pendingRepoll = false;
      void poll();
    }
  }
}

function triggerImmediatePoll() {
  pollSeq++;
  if (polling) {
    pendingRepoll = true;
  } else {
    void poll();
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!polling && !document.hidden) {
      void poll();
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (hostConnected || (typeof window !== 'undefined' && window.openai))) {
    void poll();
  }
});

window.selectWorkflowSession = function (sessionId) {
  selectedSessionId = sessionId || '__auto__';
  triggerImmediatePoll();
};

window.selectWorkflowScope = function (scope) {
  selectedScope = scope === 'turn' ? 'turn' : 'session';
  try {
    window.localStorage?.setItem('codex_wf_scope', selectedScope);
  } catch {}
  triggerImmediatePoll();
};

window.requestRefreshWorkflow = function () {
  triggerImmediatePoll();
};

window.requestClearWorkflowEvents = async function () {
  try {
    await callHostTool('clear_workflow_events', {});
    triggerImmediatePoll();
  } catch (error) {
    console.error('清空 Hook 紀錄失敗:', error);
  }
};

// Register ALL lifecycle handlers BEFORE app.connect() so host handshake completes immediately.
app.ontoolinput = params => {
  try {
    const sid = params?.arguments?.session_id;
    if (typeof sid === 'string' && sid.trim()) {
      selectedSessionId = sid.trim();
    }
    const sc = params?.arguments?.scope;
    if (sc === 'turn' || sc === 'session') {
      selectedScope = sc;
      try {
        window.localStorage?.setItem('codex_wf_scope', selectedScope);
      } catch {}
    }
  } catch {}
};

app.ontoolresult = params => {
  try {
    const payload = unpack(params);
    if (payload && (payload.primary || Array.isArray(payload.events))) {
      deliverState(payload);
    } else {
      void poll();
    }
  } catch (err) {
    console.error('Codex Workflow toolresult error:', err);
  }
};

app.onhostcontextchanged = () => {
  try {
    window.dispatchEvent(new Event('resize'));
  } catch {}
};

app.onteardown = async () => {
  stopPolling();
  return {};
};

app
  .connect()
  .then(() => {
    hostConnected = true;
    try {
      const ctx = typeof app.getHostContext === 'function' ? app.getHostContext() : null;
      const hint = ctx?.threadId || ctx?.conversationId || '';
      if (typeof hint === 'string' && hint.trim() && selectedSessionId === '__auto__') {
        selectedSessionId = hint.trim();
      }
    } catch {}
    window.dispatchEvent(new Event('resize'));
    void poll();
    startPolling();
  })
  .catch(error => {
    if (typeof window !== 'undefined' && window.openai) {
      if (window.openai.toolOutput) {
        deliverState(window.openai.toolOutput);
      }
      void poll();
      startPolling();
      return;
    }
    const banner = document.getElementById('modeText');
    if (banner) banner.textContent = '無法連接外掛宿主';
    console.error('無法連接 MCP App 宿主', error);
  });
