import { existsSync, openSync, readSync, fstatSync, closeSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SELF_SERVER_NAMES = new Set(['codex-workflow-monitor']);
const SELF_TOOL_NAMES = new Set([
  'open_workflow_monitor',
  'read_workflow_events',
  'clear_workflow_events',
]);

// A turn marked `inProgress` in SQLite is only treated as live-running if the thread or
// rollout file was touched within this window (prevents stale/crashed historical turns from glowing).
const ACTIVE_TURN_FRESHNESS_MS = 10 * 60 * 1000;
const RECENT_ACTIVITY_GLOW_MS = 8 * 1000;

export const CAPABILITY_CATALOG = [
  { id: 'reasoning', label: '深度推理', shortLabel: '推理', accent: 'purple', desc: '模型思考、規劃與推理步驟' },
  { id: 'search', label: '搜尋與讀取', shortLabel: '搜尋', accent: 'cyan', desc: '檔案探索、符號檢索與唯讀檢視' },
  { id: 'shell', label: '終端指令', shortLabel: '終端', accent: 'blue', desc: '執行命令列工具、腳本與測試' },
  { id: 'edit', label: '檔案編修', shortLabel: '編修', accent: 'green', desc: '建立、修改與套用程式碼補丁' },
  { id: 'mcp', label: 'MCP 工具', shortLabel: 'MCP', accent: 'indigo', desc: '呼叫外部 MCP 伺服器工具' },
  { id: 'web', label: '網路檢索', shortLabel: '網搜', accent: 'cyan', desc: '即時網路搜尋與網頁查閱' },
  { id: 'vision', label: '影像處理', shortLabel: '影像', accent: 'gold', desc: '圖片檢視與視覺生成任務' },
  { id: 'compact', label: '脈絡壓縮', shortLabel: '壓縮', accent: 'gold', desc: '自動整理與壓縮長對話脈絡' },
  { id: 'plan', label: '計畫規劃', shortLabel: '計畫', accent: 'purple', desc: '結構化任務步驟與進度更新' },
];

let sqliteModulePromise = null;
async function getDatabaseSync() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import('node:sqlite')
      .then(mod => mod.DatabaseSync || null)
      .catch(() => null);
  }
  return sqliteModulePromise;
}

export function resolveCodexHome(override) {
  if (override) return override;
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function getTelemetryLogPath(override) {
  if (override) return override;
  return process.env.CODEX_WORKFLOW_MONITOR_LOG || path.join(os.homedir(), '.codex-workflow-monitor', 'events.jsonl');
}

function findLatestVersionedSqlite(dir, prefix) {
  if (!dir || !existsSync(dir)) return '';
  try {
    const entries = readdirSync(dir);
    const re = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`, 'i');
    let bestVer = -1;
    let bestFile = '';
    for (const name of entries) {
      const m = name.match(re);
      if (m) {
        const ver = Number(m[1]);
        if (ver > bestVer) {
          bestVer = ver;
          bestFile = path.join(dir, name);
        }
      }
    }
    return bestFile;
  } catch {
    return '';
  }
}

export function formatModelDisplayName(model = '') {
  const raw = String(model || '').trim();
  if (!raw) return 'Codex Model';
  if (/^gpt-/i.test(raw)) {
    return raw
      .split('-')
      .map((part, idx) => {
        if (idx === 0) return 'GPT';
        if (/^\d+(\.\d+)*$/.test(part)) return part;
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join('-');
  }
  return raw;
}

export function inferModelFamily(model = '', role = '') {
  const m = String(model || '').toLowerCase();
  const r = String(role || '').toLowerCase();
  if (r === 'advisor' || r === 'astra' || m.includes('astra')) return 'astra';
  if (r === 'audit' || r === 'terra' || m.includes('terra')) return 'terra';
  if (r === 'search' || r === 'grep' || m.includes('luna')) return 'luna';
  if (m.includes('sol')) return 'sol';
  if (m.includes('review')) return 'gold';
  return 'blue';
}

export function isSelfMonitorTool(serverName = '', toolName = '') {
  const srv = String(serverName || '').toLowerCase();
  const tool = String(toolName || '').toLowerCase();
  if (SELF_SERVER_NAMES.has(srv)) return true;
  if (SELF_TOOL_NAMES.has(tool)) return true;
  if (tool.includes('workflow_monitor') || tool.includes('workflow_events')) return true;
  return false;
}

export function classifyToolToCapability(toolName = '', itemType = '', commandActionType = '', serverName = '') {
  const it = String(itemType || '');
  if (it === 'reasoning') return 'reasoning';
  if (it === 'fileChange') return 'edit';
  if (it === 'webSearch') return 'web';
  if (it === 'imageView' || it === 'imageGeneration') return 'vision';
  if (it === 'contextCompaction') return 'compact';
  if (it === 'plan') return 'plan';
  if (it === 'mcpToolCall') {
    const srv = String(serverName || '').toLowerCase();
    if (srv.includes('codegraph')) return 'search';
    return 'mcp';
  }
  if (it === 'commandExecution') {
    const ca = String(commandActionType || '').toLowerCase();
    if (ca === 'read' || ca === 'search' || ca === 'listfiles') return 'search';
    return 'shell';
  }

  const t = String(toolName || '').toLowerCase();
  if (!t) return '';
  if (['update_plan', 'plan'].some(k => t === k || t.includes('plan'))) return 'plan';
  if (['apply_patch', 'edit', 'write', 'create_file', 'replace'].some(k => t.includes(k))) return 'edit';
  if (['grep', 'rg', 'find', 'glob', 'read', 'search_code', 'codegraph', 'list_dir', 'view'].some(k => t.includes(k))) return 'search';
  if (['web_search', 'websearch', 'webfetch', 'fetch'].some(k => t.includes(k))) return 'web';
  if (['image', 'screenshot', 'vision'].some(k => t.includes(k))) return 'vision';
  if (['exec', 'bash', 'shell', 'command', 'terminal', 'run'].some(k => t.includes(k))) return 'shell';
  if (['spawn_agent', 'send_input', 'followup_task', 'wait', 'close_agent', 'agent'].some(k => t === k || t.includes('subagent'))) return '';
  return 'mcp';
}

function isSubagentOrchestrationTool(toolName = '') {
  const t = String(toolName || '').toLowerCase();
  return ['wait', 'spawn_agent', 'send_input', 'followup_task', 'close_agent', 'resume_agent', 'agent'].includes(t);
}

function safeJsonParse(str) {
  if (!str || typeof str !== 'string') return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function readFileTailText(filePath, maxBytes = 256 * 1024) {
  if (!filePath || !existsSync(filePath)) return { text: '', mtimeMs: 0 };
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const st = fstatSync(fd);
    const mtimeMs = Number(st.mtimeMs || 0);
    if (!st.size) return { text: '', mtimeMs };
    const count = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(count);
    readSync(fd, buf, 0, count, st.size - count);
    let text = buf.toString('utf8');
    if (st.size > count) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return { text, mtimeMs };
  } catch {
    return { text: '', mtimeMs: 0 };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

/**
 * Reads only safe structural metadata from the tail of a Codex rollout JSONL file.
 * Never reads or returns user prompts, tool arguments, command text, outputs or secrets.
 */
export function inspectRolloutTail(rolloutPath, maxBytes = 256 * 1024) {
  const empty = {
    exists: false,
    mtimeMs: 0,
    latestModel: '',
    latestEffort: '',
    inFlightCalls: [],
    waitingOnSubagent: false,
    turnActiveInRollout: false,
    lastTaskStartedMs: 0,
    lastActivityMs: 0,
    lastReasoningMs: 0,
    lastTokenTotal: 0,
    turnTokensByTurnId: {},
    contextWindowTokens: 0,
    recentEvents: [],
  };
  if (!rolloutPath || !existsSync(rolloutPath)) return empty;

  const { text, mtimeMs } = readFileTailText(rolloutPath, maxBytes);
  if (!text) return { ...empty, exists: true, mtimeMs };

  const lines = text.split(/\r?\n/).filter(Boolean);
  const openCalls = new Map();
  let latestModel = '';
  let latestEffort = '';
  let turnActiveInRollout = false;
  let lastTaskStartedMs = 0;
  let lastActivityMs = mtimeMs;
  let lastReasoningMs = 0;
  let lastTokenTotal = 0;
  const turnTokensByTurnId = {};
  let contextWindowTokens = 0;
  const recentEvents = [];

  for (const line of lines) {
    const obj = safeJsonParse(line);
    if (!obj || typeof obj !== 'object') continue;
    const tsMs = obj.timestamp ? Date.parse(obj.timestamp) : 0;
    if (tsMs > lastActivityMs) lastActivityMs = tsMs;
    const topType = obj.type;
    const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : null;

    if (topType === 'turn_context' && payload) {
      if (typeof payload.model === 'string' && payload.model) latestModel = payload.model;
      const effort =
        payload.collaboration_mode?.settings?.reasoning_effort ||
        payload.reasoning_effort ||
        '';
      if (effort) latestEffort = String(effort);
      continue;
    }

    if (topType === 'event_msg' && payload) {
      const pType = payload.type;
      if (pType === 'task_started') {
        turnActiveInRollout = true;
        openCalls.clear();
        const started = typeof payload.started_at === 'number'
          ? (payload.started_at < 1e12 ? payload.started_at * 1000 : payload.started_at)
          : tsMs;
        if (started > lastTaskStartedMs) lastTaskStartedMs = started;
        if (typeof payload.model_context_window === 'number') {
          contextWindowTokens = payload.model_context_window;
        }
      } else if (pType === 'task_complete' || pType === 'turn_aborted') {
        turnActiveInRollout = false;
        openCalls.clear();
      } else if (pType === 'token_count') {
        const total = payload.info?.total_token_usage?.total_tokens;
        if (typeof total === 'number' && total > lastTokenTotal) lastTokenTotal = total;
        const win = payload.info?.model_context_window;
        if (typeof win === 'number' && win > 0) contextWindowTokens = win;
      }
      continue;
    }

    if (topType === 'token_usage_record' && payload) {
      const total = payload.thread_token_usage?.total_tokens;
      if (typeof total === 'number' && total > lastTokenTotal) lastTokenTotal = total;
      const turnTotal = payload.turn_token_usage?.total_tokens;
      const tid = payload.turn_id;
      if (tid && typeof turnTotal === 'number' && turnTotal >= (turnTokensByTurnId[tid] || 0)) {
        turnTokensByTurnId[tid] = turnTotal;
      }
      continue;
    }

    if (topType === 'response_item' && payload) {
      const pType = payload.type;
      if (pType === 'reasoning') {
        if (tsMs > lastReasoningMs) lastReasoningMs = tsMs;
      } else if (pType === 'function_call' || pType === 'custom_tool_call') {
        const name = String(payload.name || '');
        const ns = String(payload.namespace || '');
        const callId = String(payload.call_id || '');
        if (!isSelfMonitorTool(ns, name) && callId) {
          const cap = classifyToolToCapability(name, '', '', ns);
          openCalls.set(callId, {
            call_id: callId,
            tool_name: name || 'tool',
            namespace: ns,
            capability: cap,
            is_subagent_wait: isSubagentOrchestrationTool(name),
            timestamp_ms: tsMs || mtimeMs,
          });
          recentEvents.push({
            timestamp_ms: tsMs || mtimeMs,
            tool_name: name,
            namespace: ns,
            capability: cap,
            phase: 'call',
          });
        }
      } else if (pType === 'function_call_output' || pType === 'custom_tool_call_output') {
        const callId = String(payload.call_id || '');
        if (callId && openCalls.has(callId)) {
          openCalls.delete(callId);
        }
      }
    }
  }

  const inFlightCalls = Array.from(openCalls.values());
  const waitingOnSubagent = inFlightCalls.some(c => c.is_subagent_wait);

  return {
    exists: true,
    mtimeMs,
    latestModel,
    latestEffort,
    inFlightCalls,
    waitingOnSubagent,
    turnActiveInRollout,
    lastTaskStartedMs,
    lastActivityMs,
    lastReasoningMs,
    lastTokenTotal,
    turnTokensByTurnId,
    contextWindowTokens,
    recentEvents: recentEvents.slice(-30),
  };
}

function createCapabilityMap() {
  const map = {};
  for (const def of CAPABILITY_CATALOG) {
    map[def.id] = {
      id: def.id,
      label: def.label,
      short_label: def.shortLabel,
      accent: def.accent,
      desc: def.desc,
      used: false,
      is_running: false,
      count: 0,
      completed_count: 0,
      failed_count: 0,
      in_flight: 0,
      duration_ms: 0,
      avg_duration_ms: null,
      completion_pct: 0,
      last_tool: '',
      last_timestamp_ms: 0,
      servers: new Set(),
    };
  }
  return map;
}

function finalizeCapabilities(capMap, nowMs) {
  return CAPABILITY_CATALOG.map(def => {
    const c = capMap[def.id];
    const total = c.count + c.in_flight;
    const used = total > 0;
    const isRunning = c.in_flight > 0 || c.is_running;
    let completionPct = 0;
    if (used) {
      if (isRunning) {
        const doneRatio = total > 0 ? Math.round((c.completed_count / total) * 100) : 0;
        completionPct = Math.max(15, Math.min(92, doneRatio || 45));
      } else {
        completionPct = c.count > 0 ? Math.round((c.completed_count / c.count) * 100) : 100;
        if (completionPct === 0 && c.count > 0 && c.failed_count === 0) completionPct = 100;
      }
    }
    const completedForAvg = Math.max(1, c.completed_count || c.count);
    const avgDurationMs = c.duration_ms > 0 ? Math.round(c.duration_ms / completedForAvg) : null;
    const servers = Array.from(c.servers).filter(Boolean).slice(0, 6);
    return {
      id: c.id,
      label: c.label,
      short_label: c.short_label,
      accent: c.accent,
      desc: c.desc,
      used,
      is_running: isRunning,
      state: isRunning ? 'running' : (used ? (c.failed_count > 0 && c.completed_count === 0 ? 'failed' : 'done') : 'idle'),
      count: total,
      completed_count: c.completed_count,
      failed_count: c.failed_count,
      in_flight: c.in_flight,
      duration_ms: c.duration_ms,
      avg_duration_ms: avgDurationMs,
      completion_pct: completionPct,
      last_tool: c.last_tool,
      last_timestamp_ms: c.last_timestamp_ms,
      servers,
      age_ms: c.last_timestamp_ms ? Math.max(0, nowMs - c.last_timestamp_ms) : null,
    };
  });
}

function readHookEventsFile(logPath) {
  if (!logPath || !existsSync(logPath)) return [];
  const { text } = readFileTailText(logPath, 512 * 1024);
  if (!text) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const obj = safeJsonParse(line);
    if (obj && obj.event_type) {
      if (isSelfMonitorTool('', obj.tool_name)) continue;
      out.push(obj);
    }
  }
  return out;
}

function isThreadRunningNow(latestTurn, updatedAtMs, rollout, nowMs) {
  const latestActivityMs = Math.max(
    Number(updatedAtMs || 0),
    Number(rollout?.mtimeMs || 0),
    Number(rollout?.lastActivityMs || 0),
    latestTurn?.started_at ? Number(latestTurn.started_at) * 1000 : 0
  );
  const ageMs = nowMs - latestActivityMs;
  if (latestTurn && latestTurn.status === 'inProgress' && ageMs < ACTIVE_TURN_FRESHNESS_MS) {
    return true;
  }
  if (rollout?.turnActiveInRollout && ageMs < ACTIVE_TURN_FRESHNESS_MS) {
    return true;
  }
  if ((rollout?.inFlightCalls?.length || 0) > 0 && ageMs < ACTIVE_TURN_FRESHNESS_MS) {
    return true;
  }
  return false;
}

function normalizeTurnStartedMs(turn) {
  if (!turn || !turn.started_at) return 0;
  const v = Number(turn.started_at);
  return v < 1e12 ? v * 1000 : v;
}

function normalizeTurnCompletedMs(turn) {
  if (!turn || !turn.completed_at) return 0;
  const v = Number(turn.completed_at);
  return v < 1e12 ? v * 1000 : v;
}

function extractSubagentLabel(threadRow) {
  if (threadRow.agent_nickname) return threadRow.agent_nickname;
  if (threadRow.agent_role) {
    const roleMap = {
      search: 'Luna Search',
      grep: 'Luna Grep',
      audit: 'Terra Audit',
      advisor: 'Astra Advisor',
    };
    return roleMap[threadRow.agent_role] || threadRow.agent_role;
  }
  if (threadRow.agent_path) {
    const seg = String(threadRow.agent_path).split('/').filter(Boolean).pop();
    if (seg) return seg;
  }
  return formatModelDisplayName(threadRow.model || 'Subagent');
}

function buildRoleLabel(role, agentPath) {
  const r = String(role || '').toLowerCase();
  if (r === 'search') return '快速探索 · search';
  if (r === 'grep') return '精準檢索 · grep';
  if (r === 'audit') return '獨立審查 · audit';
  if (r === 'advisor') return '架構顧問 · advisor';
  if (agentPath) return String(agentPath).replace(/^\/root\//, '');
  return '動態子代理';
}

function formatSafeItemEvent(row, actorName, actorKind) {
  const tsMs = Number(row.completed_at_ms || row.started_at_ms || row.created_at_ms || 0);
  const durMs = Number(row.duration_ms || 0) || (row.started_at_ms && row.completed_at_ms ? Math.max(0, row.completed_at_ms - row.started_at_ms) : 0);
  const type = row.item_type;
  let label = type;
  let cap = classifyToolToCapability(row.tool_name || '', type, row.cmd_action || '', row.mcp_server || '');

  if (type === 'reasoning') {
    label = '完成一段深度推理';
  } else if (type === 'commandExecution') {
    const st = row.item_status === 'failed' ? '（失敗）' : '';
    label = row.cmd_action === 'read' ? `讀取／查詢工作區檔案${st}` : `執行終端指令${st}`;
  } else if (type === 'fileChange') {
    label = `編修工作區檔案${row.item_status === 'failed' ? '（失敗）' : ''}`;
  } else if (type === 'mcpToolCall') {
    const srv = row.mcp_server || 'mcp';
    const tl = row.tool_name || 'tool';
    label = `呼叫 MCP：${srv}/${tl}`;
  } else if (type === 'webSearch') {
    label = '執行網路檢索';
  } else if (type === 'imageView') {
    label = '檢視影像檔案';
  } else if (type === 'imageGeneration') {
    label = '生成影像資源';
  } else if (type === 'contextCompaction') {
    label = '完成上下文脈絡壓縮';
  } else if (type === 'plan') {
    label = '更新工作計畫';
  } else if (type === 'subAgentActivity') {
    const target = (row.sub_path || '').replace(/^\/root\//, '') || 'subagent';
    if (row.sub_kind === 'started') label = `派發子代理：${target}`;
    else if (row.sub_kind === 'completed') label = `子代理完成回傳：${target}`;
    else label = `與子代理通訊：${target}`;
    cap = 'subagent';
  } else {
    return null;
  }

  return {
    timestamp: tsMs ? new Date(tsMs).toISOString() : '',
    timestamp_ms: tsMs,
    event_type: type,
    actor: actorName,
    kind: actorKind,
    capability: cap,
    duration_ms: durMs || null,
    status: row.item_status || 'completed',
    label,
  };
}

function buildHookOnlyPayload(hookEvents, { session_id = '', scope = 'session', limit = 80, nowMs = Date.now() } = {}) {
  const normalizedScope = scope === 'turn' ? 'turn' : 'session';
  const sessionMap = new Map();
  for (const e of hookEvents) {
    const sid = e.session_id || 'default';
    const prev = sessionMap.get(sid);
    sessionMap.set(sid, {
      session_id: sid,
      model: e.model && !e.agent_id ? e.model : (prev?.model || ''),
      model_display: formatModelDisplayName(e.model && !e.agent_id ? e.model : (prev?.model || 'gpt-6.2-sol')),
      is_running: !['Stop', 'Interrupt', 'SessionEnd'].includes(e.event_type),
      updated_at_ms: Number(e.timestamp_ms || nowMs),
      subagent_count: prev?.subagent_count || 0,
      event_count: (prev?.event_count || 0) + 1,
      source: 'hooks',
    });
  }

  const sessions = Array.from(sessionMap.values())
    .sort((a, b) => b.updated_at_ms - a.updated_at_ms)
    .slice(0, 15);
  const requested = session_id && sessionMap.has(session_id) ? session_id : '';
  const activeSid = requested || sessions[0]?.session_id || '';
  const allSessionEvs = hookEvents.filter(e => !activeSid || (e.session_id || 'default') === activeSid);

  // Preserve primary model & total turn count across the session even when slicing to current turn
  let sessionPrimaryModel = '';
  let sessionTurnsTotal = 0;
  let lastTurnId = '';
  let lastPromptIdx = -1;
  allSessionEvs.forEach((e, idx) => {
    if (e.model && !e.agent_id) sessionPrimaryModel = e.model;
    if (e.event_type === 'UserPromptSubmit') {
      sessionTurnsTotal++;
      lastPromptIdx = idx;
    }
    if (e.turn_id) lastTurnId = e.turn_id;
  });

  let evs = allSessionEvs;
  if (normalizedScope === 'turn' && allSessionEvs.length > 0) {
    if (lastPromptIdx >= 0) {
      evs = allSessionEvs.slice(lastPromptIdx);
    } else if (lastTurnId) {
      evs = allSessionEvs.filter(e => e.turn_id === lastTurnId);
    }
  }

  const capMap = createCapabilityMap();
  const subMap = new Map();
  const inFlightTools = new Map();
  let primaryModel = sessionPrimaryModel;
  let totalTokens = 0;
  let turnsTotal = 0;
  let turnsCompleted = 0;
  let toolTotal = 0;
  let toolCompleted = 0;
  let firstTs = 0;
  let lastTs = 0;
  let pendingPermission = false;
  let sessionEnded = false;

  for (const e of evs) {
    const ts = Number(e.timestamp_ms || 0);
    if (ts && (!firstTs || ts < firstTs)) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
    if (e.model && !e.agent_id) primaryModel = e.model;
    if (e.token_usage?.total_tokens) totalTokens += Number(e.token_usage.total_tokens);

    if (e.event_type === 'UserPromptSubmit' || e.event_type === 'SessionStart') {
      if (e.event_type === 'UserPromptSubmit') turnsTotal++;
      sessionEnded = false;
    } else if (e.event_type === 'Stop' || e.event_type === 'Interrupt' || e.event_type === 'SessionEnd') {
      sessionEnded = true;
      turnsCompleted = Math.max(turnsCompleted, turnsTotal || 1);
      inFlightTools.clear();
      pendingPermission = false;
      for (const s of subMap.values()) {
        if (s.is_running) {
          s.is_running = false;
          s.state = 'done';
          s.completion_pct = 100;
        }
      }
    } else if (e.event_type === 'PermissionRequest') {
      pendingPermission = true;
    }

    if (e.event_type === 'SubagentStart' || e.event_type === 'SubagentStop' || e.agent_id) {
      const subId = e.agent_id || `role:${e.agent_type || 'subagent'}`;
      let sub = subMap.get(subId);
      if (!sub) {
        const model = e.model || '';
        const role = e.agent_type || '';
        sub = {
          id: subId,
          name: e.who || e.agent_type || subId.slice(0, 10),
          role: role || 'subagent',
          role_label: buildRoleLabel(role, ''),
          agent_path: '',
          model: model || 'subagent',
          model_display: formatModelDisplayName(model || role || 'Subagent'),
          family: inferModelFamily(model, role),
          reasoning_effort: '',
          state: 'running',
          is_running: true,
          invocations: 0,
          tool_calls: 0,
          completed_turns: 0,
          total_turns: 0,
          completion_pct: 35,
          elapsed_ms: 0,
          current_turn_started_ms: ts || nowMs,
          tokens_used: 0,
          current_activity: e.label || '子代理執行中',
          in_flight_tools: [],
        };
        subMap.set(subId, sub);
      }
      if (e.event_type === 'SubagentStart') {
        sub.invocations++;
        sub.total_turns++;
        sub.is_running = true;
        sub.state = 'running';
        sub.current_turn_started_ms = ts || nowMs;
        sub.completion_pct = 35;
        sub.current_activity = e.label || '子代理啟動';
      } else if (e.event_type === 'SubagentStop') {
        sub.is_running = false;
        sub.state = 'done';
        sub.completed_turns++;
        sub.completion_pct = 100;
        if (sub.current_turn_started_ms && ts >= sub.current_turn_started_ms) {
          sub.elapsed_ms += ts - sub.current_turn_started_ms;
        }
        sub.current_turn_started_ms = 0;
        sub.current_activity = e.label || '已完成並交回主代理';
      } else if (e.event_type === 'PreToolUse') {
        sub.tool_calls++;
        sub.current_activity = `執行工具：${e.tool_name || 'tool'}`;
      }
      continue;
    }

    if (e.event_type === 'PreModelRequest') {
      capMap.reasoning.in_flight++;
      capMap.reasoning.is_running = true;
      capMap.reasoning.last_timestamp_ms = ts;
    } else if (e.event_type === 'PostModelRequest') {
      capMap.reasoning.in_flight = Math.max(0, capMap.reasoning.in_flight - 1);
      capMap.reasoning.is_running = capMap.reasoning.in_flight > 0;
      capMap.reasoning.count++;
      capMap.reasoning.completed_count++;
      capMap.reasoning.last_timestamp_ms = ts;
    } else if (e.event_type === 'PreToolUse') {
      toolTotal++;
      const capId = classifyToolToCapability(e.tool_name || '', '', '', '');
      const key = e.tool_use_id || `${e.tool_name}:${toolTotal}`;
      inFlightTools.set(key, { capId, tool_name: e.tool_name || 'tool', ts });
      if (capId && capMap[capId]) {
        capMap[capId].in_flight++;
        capMap[capId].last_tool = e.tool_name || '';
        capMap[capId].last_timestamp_ms = ts;
      }
    } else if (e.event_type === 'PostToolUse') {
      toolCompleted++;
      pendingPermission = false;
      const key = e.tool_use_id || '';
      let info = key ? inFlightTools.get(key) : null;
      if (info) {
        inFlightTools.delete(key);
      } else {
        for (const [k, v] of inFlightTools.entries()) {
          if (v.tool_name === (e.tool_name || 'tool')) {
            info = v;
            inFlightTools.delete(k);
            break;
          }
        }
      }
      const capId = info?.capId || classifyToolToCapability(e.tool_name || '', '', '', '');
      if (capId && capMap[capId]) {
        capMap[capId].in_flight = Math.max(0, capMap[capId].in_flight - 1);
        capMap[capId].count++;
        capMap[capId].completed_count++;
        capMap[capId].last_tool = e.tool_name || capMap[capId].last_tool;
        capMap[capId].last_timestamp_ms = ts;
        if (info?.ts && ts >= info.ts) capMap[capId].duration_ms += ts - info.ts;
      }
    } else if (e.event_type === 'PreCompact') {
      capMap.compact.in_flight++;
    } else if (e.event_type === 'PostCompact') {
      capMap.compact.in_flight = Math.max(0, capMap.compact.in_flight - 1);
      capMap.compact.count++;
      capMap.compact.completed_count++;
    }
  }

  const subagents = Array.from(subMap.values());
  const anySubRunning = subagents.some(s => s.is_running);
  const isRunning = evs.length > 0 && !sessionEnded && (nowMs - lastTs < ACTIVE_TURN_FRESHNESS_MS);
  const capabilities = finalizeCapabilities(capMap, nowMs);
  const modelName = primaryModel || 'gpt-6.2-sol';
  const elapsedMs = firstTs ? Math.max(0, (isRunning ? nowMs : lastTs) - firstTs) : 0;

  let completionPct = 0;
  if (evs.length > 0) {
    if (!isRunning) completionPct = 100;
    else {
      const doneUnits = toolCompleted + subagents.filter(s => !s.is_running).length;
      const totalUnits = Math.max(1, toolTotal + subagents.length + 1);
      completionPct = Math.max(12, Math.min(92, Math.round((doneUnits / totalUnits) * 100)));
    }
  }

  let currentPhase = '待機中 · 等待 Codex 任務';
  if (pendingPermission) currentPhase = '等待權限授權確認';
  else if (isRunning) {
    if (anySubRunning) currentPhase = `正在協作子代理（${subagents.filter(s => s.is_running).length} 個運行中）`;
    else if (inFlightTools.size > 0) currentPhase = `執行工具：${Array.from(inFlightTools.values()).map(x => x.tool_name).join(', ')}`;
    else currentPhase = '深度推理與生成中';
  } else if (evs.length > 0) {
    currentPhase = '回合已完成';
  }

  const events = evs.slice(-Math.max(1, Math.min(120, Number(limit) || 60))).map(e => ({
    timestamp: e.timestamp || '',
    timestamp_ms: Number(e.timestamp_ms || 0),
    event_type: e.event_type,
    actor: e.who || (e.agent_id ? e.agent_type || 'Subagent' : formatModelDisplayName(modelName)),
    kind: e.kind || (e.agent_id ? 'cyan' : 'purple'),
    capability: classifyToolToCapability(e.tool_name || '', '', '', ''),
    duration_ms: null,
    status: 'completed',
    label: e.label || e.event_type,
  }));

  const effectiveSessionTurns = Math.max(sessionTurnsTotal, turnsTotal, evs.length ? 1 : 0);

  return {
    connected: true,
    source: 'local-codex-hooks',
    scope: normalizedScope,
    active_turn_id: lastTurnId,
    active_turn_index: effectiveSessionTurns,
    session_turns_total: effectiveSessionTurns,
    timestamp_ms: nowMs,
    active_session_id: activeSid,
    mode: subagents.length > 0 ? 'multi-agent' : 'single-model',
    sessions,
    primary: {
      id: activeSid,
      model: modelName,
      display_name: formatModelDisplayName(modelName),
      family: inferModelFamily(modelName, ''),
      reasoning_effort: '',
      state: pendingPermission ? 'waiting_permission' : (isRunning ? (anySubRunning ? 'waiting_subagent' : 'running') : (evs.length ? 'done' : 'idle')),
      is_running: isRunning,
      current_phase: currentPhase,
      turns_total: normalizedScope === 'turn' ? (evs.length ? 1 : 0) : effectiveSessionTurns,
      turns_completed: normalizedScope === 'turn' ? (!isRunning && evs.length ? 1 : 0) : turnsCompleted,
      turn_index: effectiveSessionTurns,
      session_turns_total: effectiveSessionTurns,
      turns_in_progress: isRunning ? 1 : 0,
      tool_calls_total: toolTotal,
      tool_calls_completed: toolCompleted,
      tool_calls_in_flight: inFlightTools.size,
      invocations: toolTotal + (normalizedScope === 'turn' ? (evs.length ? 1 : 0) : effectiveSessionTurns),
      completion_pct: completionPct,
      current_turn_started_ms: isRunning ? firstTs : 0,
      current_turn_elapsed_ms: elapsedMs,
      total_runtime_ms: elapsedMs,
      tokens_used: totalTokens,
      context_window_tokens: 0,
      pending_permission: pendingPermission,
    },
    capabilities,
    subagents,
    events,
    summary: {
      active_models_count: (isRunning ? 1 : 0) + subagents.filter(s => s.is_running).length,
      used_capabilities_count: capabilities.filter(c => c.used).length,
      running_capabilities_count: capabilities.filter(c => c.is_running).length,
      total_subagents: subagents.length,
      running_subagents: subagents.filter(s => s.is_running).length,
      total_invocations: toolTotal + subagents.reduce((acc, s) => acc + s.invocations, 0),
      total_runtime_ms: elapsedMs,
      session_ended: !isRunning,
      has_data: evs.length > 0,
    },
  };
}

/**
 * Primary read-only telemetry reader.
 * Combines Codex local SQLite (state_*.sqlite + thread_history_*.sqlite) + rollout tail +
 * optional Codex Hook events.jsonl so ANY single model or multi-agent workflow is live anytime.
 */
export async function readLiveWorkflowState({
  session_id = '',
  preferred_session_id = '',
  scope = 'session',
  limit = 60,
  codexHome,
  telemetryLogPath,
  forceHooksOnly = false,
} = {}) {
  const normalizedScope = scope === 'turn' ? 'turn' : 'session';
  const nowMs = Date.now();
  const logPath = getTelemetryLogPath(telemetryLogPath);
  const hookEvents = readHookEventsFile(logPath);

  // If explicitly using a custom CODEX_WORKFLOW_MONITOR_LOG without codexHome override in tests,
  // or when node:sqlite / Codex DBs are unavailable, seamlessly use Hook-only mode.
  const home = resolveCodexHome(codexHome);
  const stateDbPath = forceHooksOnly ? '' : findLatestVersionedSqlite(home, 'state');
  const historyDbPath = forceHooksOnly ? '' : findLatestVersionedSqlite(home, 'thread_history');
  const DatabaseSync = stateDbPath ? await getDatabaseSync() : null;

  if (!DatabaseSync || !stateDbPath || !existsSync(stateDbPath)) {
    return buildHookOnlyPayload(hookEvents, {
      session_id: session_id || preferred_session_id,
      scope: normalizedScope,
      limit,
      nowMs,
    });
  }

  let stateDb = null;
  let historyDb = null;
  try {
    stateDb = new DatabaseSync(stateDbPath, { readOnly: true, timeout: 1000 });
    if (historyDbPath && existsSync(historyDbPath)) {
      historyDb = new DatabaseSync(historyDbPath, { readOnly: true, timeout: 1000 });
    }

    // 1. Load recent primary user threads
    const candidateThreads = stateDb.prepare(`
      SELECT id, rollout_path, model, reasoning_effort, tokens_used,
             created_at_ms, updated_at_ms, source, thread_source, agent_nickname, agent_role
      FROM threads
      WHERE archived = 0
        AND (
          thread_source = 'user'
          OR (thread_source IS NULL AND agent_role IS NULL AND (source IS NULL OR source NOT LIKE '%"subagent"%'))
        )
      ORDER BY updated_at_ms DESC
      LIMIT 20
    `).all();

    if (!candidateThreads.length) {
      return buildHookOnlyPayload(hookEvents, { session_id: session_id || preferred_session_id, limit, nowMs });
    }

    // Prepare reusable queries
    const latestTurnStmt = historyDb
      ? historyDb.prepare(`
          SELECT turn_id, status, started_at, completed_at, duration_ms
          FROM thread_turns
          WHERE thread_id = ?
          ORDER BY rollout_ordinal DESC
          LIMIT 1
        `)
      : null;

    const childCountStmt = stateDb.prepare(`
      SELECT COUNT(DISTINCT child_thread_id) AS c
      FROM thread_spawn_edges
      WHERE parent_thread_id = ?
    `);

    // Evaluate running status for recent sessions list
    const enrichedSessions = candidateThreads.map(t => {
      const latestTurn = latestTurnStmt ? latestTurnStmt.get(t.id) : null;
      const updatedMs = Number(t.updated_at_ms || 0);
      const latestTs = Math.max(updatedMs, normalizeTurnStartedMs(latestTurn));
      const looksRunning = Boolean(
        latestTurn &&
        latestTurn.status === 'inProgress' &&
        (nowMs - latestTs) < ACTIVE_TURN_FRESHNESS_MS
      );
      const childRow = childCountStmt.get(t.id);
      return {
        thread: t,
        latestTurn,
        session_id: t.id,
        model: t.model || 'gpt-6.2-sol',
        model_display: formatModelDisplayName(t.model || 'gpt-6.2-sol'),
        reasoning_effort: t.reasoning_effort || '',
        is_running: looksRunning,
        updated_at_ms: updatedMs,
        subagent_count: Number(childRow?.c || 0),
        tokens_used: Number(t.tokens_used || 0),
        source: 'codex-sqlite',
      };
    });

    // 2. Choose active thread:
    //    explicit user selection -> host preferred thread -> most recent running thread -> most recent thread
    let selectedEntry = null;
    if (session_id) {
      selectedEntry = enrichedSessions.find(s => s.session_id === session_id) || null;
      if (!selectedEntry) {
        const directRow = stateDb.prepare(`
          SELECT id, rollout_path, model, reasoning_effort, tokens_used,
                 created_at_ms, updated_at_ms, source, thread_source, agent_nickname, agent_role
          FROM threads WHERE id = ?
        `).get(session_id);
        if (directRow) {
          const latestTurn = latestTurnStmt ? latestTurnStmt.get(directRow.id) : null;
          selectedEntry = {
            thread: directRow,
            latestTurn,
            session_id: directRow.id,
            model: directRow.model || 'gpt-6.2-sol',
            model_display: formatModelDisplayName(directRow.model || 'gpt-6.2-sol'),
            reasoning_effort: directRow.reasoning_effort || '',
            is_running: Boolean(latestTurn?.status === 'inProgress' && (nowMs - Number(directRow.updated_at_ms || 0)) < ACTIVE_TURN_FRESHNESS_MS),
            updated_at_ms: Number(directRow.updated_at_ms || 0),
            subagent_count: 0,
            tokens_used: Number(directRow.tokens_used || 0),
            source: 'codex-sqlite',
          };
        }
      }
    }
    if (!selectedEntry && preferred_session_id) {
      selectedEntry = enrichedSessions.find(s => s.session_id === preferred_session_id) || null;
    }
    if (!selectedEntry) {
      selectedEntry = enrichedSessions.find(s => s.is_running) || enrichedSessions[0];
    }

    const activeThread = selectedEntry.thread;
    const activeThreadId = activeThread.id;
    const primaryRollout = inspectRolloutTail(activeThread.rollout_path);

    // 3. Query turns for active thread
    const turns = historyDb
      ? historyDb.prepare(`
          SELECT turn_id, status, started_at, completed_at, duration_ms
          FROM thread_turns
          WHERE thread_id = ?
          ORDER BY rollout_ordinal ASC
        `).all(activeThreadId)
      : [];

    const latestTurn = turns.at(-1) || selectedEntry.latestTurn || null;
    const primaryTurnRunning = isThreadRunningNow(latestTurn, activeThread.updated_at_ms, primaryRollout, nowMs);

    let turnsCompleted = 0;
    let turnsFailed = 0;
    let totalRuntimeMs = 0;
    for (const tr of turns) {
      if (tr.status === 'completed') turnsCompleted++;
      else if (tr.status === 'failed' || tr.status === 'interrupted') turnsFailed++;
      if (typeof tr.duration_ms === 'number' && tr.duration_ms > 0) {
        totalRuntimeMs += tr.duration_ms;
      } else if (tr.started_at && tr.completed_at) {
        const sMs = normalizeTurnStartedMs(tr);
        const eMs = normalizeTurnCompletedMs(tr);
        if (eMs > sMs) totalRuntimeMs += (eMs - sMs);
      }
    }

    const currentTurnStartedMs = primaryTurnRunning
      ? (normalizeTurnStartedMs(latestTurn) || primaryRollout.lastTaskStartedMs || Number(activeThread.updated_at_ms || nowMs))
      : normalizeTurnStartedMs(latestTurn);
    const currentTurnElapsedMs = primaryTurnRunning
      ? Math.max(0, nowMs - currentTurnStartedMs)
      : (Number(latestTurn?.duration_ms || 0) || (latestTurn?.completed_at && latestTurn?.started_at ? Math.max(0, normalizeTurnCompletedMs(latestTurn) - normalizeTurnStartedMs(latestTurn)) : 0));

    if (primaryTurnRunning && latestTurn && !latestTurn.duration_ms) {
      totalRuntimeMs += currentTurnElapsedMs;
    }

    // 4. Query primary thread items (safe JSON fields extracted in SQLite — zero private text!)
    const capMap = createCapabilityMap();
    const rawEvents = [];
    const subActivityStats = new Map();
    let primaryToolTotal = 0;
    let primaryToolCompleted = 0;
    let currentTurnItemsTotal = 0;
    let currentTurnItemsCompleted = 0;
    const activeTurnId = latestTurn?.turn_id || '';
    const isTurnScope = normalizedScope === 'turn' && Boolean(activeTurnId);

    const primaryModel = primaryRollout.latestModel || activeThread.model || 'gpt-6.2-sol';
    const primaryEffort = primaryRollout.latestEffort || activeThread.reasoning_effort || '';
    const primaryDisplay = formatModelDisplayName(primaryModel);
    const primaryFamily = inferModelFamily(primaryModel, '');

    if (historyDb) {
      const itemsSql = `
        SELECT
          turn_id,
          item_type,
          created_at_ms,
          started_at_ms,
          completed_at_ms,
          json_extract(item_json, '$.status') AS item_status,
          json_extract(item_json, '$.server') AS mcp_server,
          json_extract(item_json, '$.tool') AS tool_name,
          json_extract(item_json, '$.durationMs') AS duration_ms,
          json_extract(item_json, '$.commandActions[0].type') AS cmd_action,
          json_extract(item_json, '$.kind') AS sub_kind,
          json_extract(item_json, '$.agentThreadId') AS sub_thread_id,
          json_extract(item_json, '$.agentPath') AS sub_path
        FROM thread_items
        WHERE thread_id = ?
          ${isTurnScope ? 'AND turn_id = ?' : ''}
          AND item_type NOT IN ('userMessage', 'agentMessage')
        ORDER BY rollout_ordinal ASC
      `;
      const items = isTurnScope
        ? historyDb.prepare(itemsSql).all(activeThreadId, activeTurnId)
        : historyDb.prepare(itemsSql).all(activeThreadId);

      for (const row of items) {
        if (row.item_type === 'mcpToolCall' && isSelfMonitorTool(row.mcp_server, row.tool_name)) {
          continue;
        }

        if (row.item_type === 'subAgentActivity') {
          const sid = row.sub_thread_id || row.sub_path || '';
          if (sid) {
            const st = subActivityStats.get(sid) || { started: 0, interacted: 0, completed: 0, lastKind: '', lastMs: 0 };
            if (row.sub_kind === 'started') st.started++;
            else if (row.sub_kind === 'completed') st.completed++;
            else st.interacted++;
            st.lastKind = row.sub_kind || st.lastKind;
            const ts = Number(row.completed_at_ms || row.started_at_ms || row.created_at_ms || 0);
            if (ts > st.lastMs) st.lastMs = ts;
            subActivityStats.set(sid, st);
          }
          const ev = formatSafeItemEvent(row, primaryDisplay, primaryFamily);
          if (ev) rawEvents.push(ev);
          continue;
        }

        const capId = classifyToolToCapability(row.tool_name || '', row.item_type, row.cmd_action || '', row.mcp_server || '');
        const isCurrentTurn = activeTurnId && row.turn_id === activeTurnId;
        const isToolItem = ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageView', 'imageGeneration', 'dynamicToolCall'].includes(row.item_type);
        const itemDone = row.item_status !== 'inProgress' && (row.completed_at_ms !== null || row.item_status === 'completed' || row.item_status === 'failed' || !primaryTurnRunning);

        if (isToolItem) {
          primaryToolTotal++;
          if (itemDone) primaryToolCompleted++;
        }
        if (isCurrentTurn) {
          currentTurnItemsTotal++;
          if (itemDone) currentTurnItemsCompleted++;
        }

        if (capId && capMap[capId]) {
          const c = capMap[capId];
          const dur = Number(row.duration_ms || 0) || (row.started_at_ms && row.completed_at_ms ? Math.max(0, row.completed_at_ms - row.started_at_ms) : 0);
          const ts = Number(row.completed_at_ms || row.started_at_ms || row.created_at_ms || 0);
          if (!itemDone && primaryTurnRunning) {
            c.in_flight++;
          } else {
            c.count++;
            if (row.item_status === 'failed') c.failed_count++;
            else c.completed_count++;
          }
          if (dur > 0) c.duration_ms += dur;
          if (ts > c.last_timestamp_ms) c.last_timestamp_ms = ts;
          if (row.mcp_server) {
            c.servers.add(row.mcp_server);
            c.last_tool = `${row.mcp_server}/${row.tool_name || ''}`.replace(/\/$/, '');
          } else if (row.tool_name) {
            c.last_tool = row.tool_name;
          } else if (row.item_type === 'commandExecution') {
            c.last_tool = row.cmd_action === 'read' ? 'read/search' : 'exec';
          } else if (row.item_type === 'fileChange') {
            c.last_tool = 'patch';
          }
        }

        const ev = formatSafeItemEvent(row, primaryDisplay, primaryFamily);
        if (ev) rawEvents.push(ev);
      }
    }

    // Overlay live in-flight rollout calls onto capabilities
    let primaryInFlightToolsCount = 0;
    const primaryInFlightNames = [];
    for (const call of primaryRollout.inFlightCalls) {
      if (call.is_subagent_wait) continue;
      primaryInFlightToolsCount++;
      primaryInFlightNames.push(call.tool_name);
      if (call.capability && capMap[call.capability]) {
        capMap[call.capability].in_flight++;
        capMap[call.capability].last_tool = call.tool_name;
        capMap[call.capability].last_timestamp_ms = Math.max(capMap[call.capability].last_timestamp_ms, call.timestamp_ms || nowMs);
      }
    }

    // 5. Discover ALL dynamically spawned subagents for the selected thread
    const childRows = stateDb.prepare(`
      SELECT DISTINCT
        t.id, t.rollout_path, t.model, t.reasoning_effort, t.agent_nickname,
        t.agent_role, t.agent_path, t.tokens_used, t.created_at_ms, t.updated_at_ms,
        t.source, t.thread_source,
        e.status AS edge_status
      FROM threads t
      LEFT JOIN thread_spawn_edges e
        ON e.child_thread_id = t.id AND e.parent_thread_id = ?
      WHERE e.parent_thread_id = ?
         OR (t.thread_source = 'subagent' AND t.source LIKE ?)
      ORDER BY t.created_at_ms ASC
    `).all(activeThreadId, activeThreadId, `%"parent_thread_id":"${activeThreadId}"%`);

    const subagents = [];
    const childTurnsStmt = historyDb
      ? historyDb.prepare(`
          SELECT turn_id, root_turn_id, status, started_at, completed_at, duration_ms
          FROM thread_turns
          WHERE thread_id = ?
          ORDER BY rollout_ordinal ASC
        `)
      : null;

    const childItemAggStmt = historyDb
      ? historyDb.prepare(`
          SELECT
            COUNT(*) AS total_items,
            SUM(CASE WHEN item_type IN ('commandExecution','fileChange','mcpToolCall','webSearch','imageView','imageGeneration','dynamicToolCall') THEN 1 ELSE 0 END) AS tool_calls,
            SUM(CASE WHEN completed_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS completed_items,
            MAX(COALESCE(completed_at_ms, started_at_ms, created_at_ms)) AS last_item_ms
          FROM thread_items
          WHERE thread_id = ?
            AND item_type NOT IN ('userMessage', 'agentMessage')
        `)
      : null;

    const childLastItemStmt = historyDb
      ? historyDb.prepare(`
          SELECT
            item_type,
            created_at_ms,
            started_at_ms,
            completed_at_ms,
            json_extract(item_json, '$.status') AS item_status,
            json_extract(item_json, '$.server') AS mcp_server,
            json_extract(item_json, '$.tool') AS tool_name,
            json_extract(item_json, '$.durationMs') AS duration_ms,
            json_extract(item_json, '$.commandActions[0].type') AS cmd_action
          FROM thread_items
          WHERE thread_id = ?
            AND item_type NOT IN ('userMessage', 'agentMessage')
          ORDER BY rollout_ordinal DESC
          LIMIT 6
        `)
      : null;

    for (const ch of childRows) {
      const allChTurns = childTurnsStmt ? childTurnsStmt.all(ch.id) : [];
      const actStat = subActivityStats.get(ch.id) || subActivityStats.get(ch.agent_path) || null;
      const chTurns = isTurnScope
        ? allChTurns.filter(tr => tr.root_turn_id === activeTurnId)
        : allChTurns;

      // In 'turn' scope, skip subagents that were not invoked or active during the current turn
      if (isTurnScope && chTurns.length === 0 && !actStat) {
        continue;
      }

      const chLastTurn = chTurns.at(-1) || null;
      const chRollout = inspectRolloutTail(ch.rollout_path, 96 * 1024);
      const chRunning = isThreadRunningNow(chLastTurn, ch.updated_at_ms, chRollout, nowMs);

      let chAgg = null;
      let chRecentItems = [];
      if (historyDb) {
        if (isTurnScope && chTurns.length > 0) {
          const placeholders = chTurns.map(() => '?').join(',');
          const turnIds = chTurns.map(t => t.turn_id);
          chAgg = historyDb.prepare(`
            SELECT
              COUNT(*) AS total_items,
              SUM(CASE WHEN item_type IN ('commandExecution','fileChange','mcpToolCall','webSearch','imageView','imageGeneration','dynamicToolCall') THEN 1 ELSE 0 END) AS tool_calls,
              SUM(CASE WHEN completed_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS completed_items,
              MAX(COALESCE(completed_at_ms, started_at_ms, created_at_ms)) AS last_item_ms
            FROM thread_items
            WHERE thread_id = ?
              AND turn_id IN (${placeholders})
              AND item_type NOT IN ('userMessage', 'agentMessage')
          `).get(ch.id, ...turnIds);
          chRecentItems = historyDb.prepare(`
            SELECT
              item_type,
              created_at_ms,
              started_at_ms,
              completed_at_ms,
              json_extract(item_json, '$.status') AS item_status,
              json_extract(item_json, '$.server') AS mcp_server,
              json_extract(item_json, '$.tool') AS tool_name,
              json_extract(item_json, '$.durationMs') AS duration_ms,
              json_extract(item_json, '$.commandActions[0].type') AS cmd_action
            FROM thread_items
            WHERE thread_id = ?
              AND turn_id IN (${placeholders})
              AND item_type NOT IN ('userMessage', 'agentMessage')
            ORDER BY rollout_ordinal DESC
            LIMIT 6
          `).all(ch.id, ...turnIds);
        } else if (!isTurnScope) {
          chAgg = childItemAggStmt ? childItemAggStmt.get(ch.id) : null;
          chRecentItems = childLastItemStmt ? childLastItemStmt.all(ch.id) : [];
        }
      }

      let chCompletedTurns = 0;
      let chFailedTurns = 0;
      let chTotalDurMs = 0;
      for (const tr of chTurns) {
        if (tr.status === 'completed') chCompletedTurns++;
        else if (tr.status === 'failed' || tr.status === 'interrupted') chFailedTurns++;
        if (typeof tr.duration_ms === 'number' && tr.duration_ms > 0) chTotalDurMs += tr.duration_ms;
        else if (tr.started_at && tr.completed_at) {
          const d = normalizeTurnCompletedMs(tr) - normalizeTurnStartedMs(tr);
          if (d > 0) chTotalDurMs += d;
        }
      }

      const chStartedMs = chRunning
        ? (normalizeTurnStartedMs(chLastTurn) || chRollout.lastTaskStartedMs || Number(ch.updated_at_ms || nowMs))
        : normalizeTurnStartedMs(chLastTurn);
      const chActiveElapsedMs = chRunning ? Math.max(0, nowMs - chStartedMs) : 0;
      if (chRunning && chLastTurn && !chLastTurn.duration_ms) {
        chTotalDurMs += chActiveElapsedMs;
      }

      const chModel = chRollout.latestModel || ch.model || 'subagent';
      const chEffort = chRollout.latestEffort || ch.reasoning_effort || '';
      const chName = extractSubagentLabel(ch);
      const chFamily = inferModelFamily(chModel, ch.agent_role);
      const chState = chRunning
        ? 'running'
        : (chLastTurn?.status === 'failed' || chLastTurn?.status === 'interrupted' ? 'failed' : (chTurns.length > 0 ? 'done' : 'idle'));

      const invocations = Math.max(
        chTurns.length,
        actStat ? (actStat.started + actStat.interacted) : 0,
        1
      );
      const toolCalls = Number(chAgg?.tool_calls || 0) + chRollout.inFlightCalls.length;

      let completionPct = 0;
      if (chState === 'done') completionPct = 100;
      else if (chState === 'failed') {
        completionPct = chTurns.length > 0 ? Math.round((chCompletedTurns / chTurns.length) * 100) : 0;
      } else if (chRunning) {
        const doneTurnsRatio = chTurns.length > 1 ? (chCompletedTurns / chTurns.length) : 0;
        const itemBonus = Math.min(0.65, Number(chAgg?.completed_items || 0) * 0.08);
        completionPct = Math.max(15, Math.min(92, Math.round((doneTurnsRatio * 0.5 + itemBonus) * 100) || 28));
      }

      const inFlightToolNames = chRollout.inFlightCalls.map(c => c.tool_name).filter(Boolean);
      let currentActivity = '待機中';
      if (chRunning) {
        if (inFlightToolNames.length > 0) currentActivity = `執行工具：${inFlightToolNames.join(', ')}`;
        else currentActivity = '深度推理與分析中';
      } else if (chState === 'failed') {
        currentActivity = '回合中止或失敗';
      } else if (chState === 'done') {
        currentActivity = `已完成 · ${toolCalls} 次工具呼叫`;
      }

      for (const item of chRecentItems.slice().reverse()) {
        if (item.item_type === 'mcpToolCall' && isSelfMonitorTool(item.mcp_server, item.tool_name)) continue;
        const ev = formatSafeItemEvent(item, chName, chFamily);
        if (ev) rawEvents.push(ev);
      }

      const chTurnTokens = isTurnScope
        ? chTurns.reduce((acc, tr) => acc + Number(chRollout.turnTokensByTurnId?.[tr.turn_id] || 0), 0)
        : Number(ch.tokens_used || 0);

      subagents.push({
        id: ch.id,
        name: chName,
        role: ch.agent_role || (ch.agent_path ? String(ch.agent_path).split('/').pop() : 'subagent'),
        role_label: buildRoleLabel(ch.agent_role, ch.agent_path),
        agent_path: ch.agent_path || '',
        model: chModel,
        model_display: formatModelDisplayName(chModel),
        family: chFamily,
        reasoning_effort: chEffort,
        edge_status: ch.edge_status || 'open',
        state: chState,
        is_running: chRunning,
        invocations,
        tool_calls: toolCalls,
        completed_turns: chCompletedTurns,
        failed_turns: chFailedTurns,
        total_turns: chTurns.length,
        completion_pct: completionPct,
        elapsed_ms: chTotalDurMs,
        current_turn_started_ms: chRunning ? chStartedMs : 0,
        tokens_used: chTurnTokens,
        current_activity: currentActivity,
        in_flight_tools: inFlightToolNames,
        updated_at_ms: Number(ch.updated_at_ms || 0),
      });
    }

    // Sort subagents: running first, then most recently updated
    subagents.sort((a, b) => {
      if (a.is_running !== b.is_running) return a.is_running ? -1 : 1;
      return (b.updated_at_ms || 0) - (a.updated_at_ms || 0);
    });

    // 6. Merge any matching live Codex Hook events for this session (e.g. PermissionRequest, instant PreToolUse)
    let pendingPermission = false;
    const matchingHooks = hookEvents.filter(e =>
      e.session_id === activeThreadId && (!isTurnScope || !e.turn_id || e.turn_id === activeTurnId)
    );
    for (const he of matchingHooks) {
      if (he.event_type === 'PermissionRequest') pendingPermission = true;
      else if (he.event_type === 'PostToolUse' || he.event_type === 'Stop' || he.event_type === 'Interrupt') pendingPermission = false;
      rawEvents.push({
        timestamp: he.timestamp || '',
        timestamp_ms: Number(he.timestamp_ms || 0),
        event_type: he.event_type,
        actor: he.who || primaryDisplay,
        kind: he.kind || primaryFamily,
        capability: classifyToolToCapability(he.tool_name || '', '', '', ''),
        duration_ms: null,
        status: 'completed',
        label: he.label || he.event_type,
      });
    }

    // 7. Determine primary live glow & active capability glow accurately
    const runningSubagents = subagents.filter(s => s.is_running);
    const anySubRunning = runningSubagents.length > 0;
    const waitingSubagent = primaryTurnRunning && (primaryRollout.waitingOnSubagent || anySubRunning);
    const primaryIsRunning = primaryTurnRunning || anySubRunning || pendingPermission;

    // When primary is actively running and NOT blocked waiting on tools or subagents,
    // mark `reasoning` as actively glowing (or whichever capability was touched in the last few seconds).
    if (primaryTurnRunning && primaryInFlightToolsCount === 0 && !waitingSubagent) {
      const recentCap = Object.values(capMap)
        .filter(c => c.id !== 'reasoning' && c.last_timestamp_ms && (nowMs - c.last_timestamp_ms) < RECENT_ACTIVITY_GLOW_MS)
        .sort((a, b) => b.last_timestamp_ms - a.last_timestamp_ms)[0];
      if (recentCap) {
        recentCap.is_running = true;
      } else {
        capMap.reasoning.is_running = true;
        if (capMap.reasoning.count === 0) capMap.reasoning.in_flight = 1;
      }
    }

    const capabilities = finalizeCapabilities(capMap, nowMs);

    // Compute honest completion percentage for primary model
    let completionPct = 0;
    if (!primaryIsRunning) {
      if (turns.length > 0) {
        completionPct = latestTurn?.status === 'failed'
          ? Math.round((turnsCompleted / Math.max(1, turns.length)) * 100)
          : 100;
      }
    } else {
      const doneSub = subagents.filter(s => !s.is_running).length;
      const totalUnits = Math.max(1, currentTurnItemsTotal + subagents.length + (primaryInFlightToolsCount || 1));
      const doneUnits = currentTurnItemsCompleted + doneSub;
      completionPct = Math.max(10, Math.min(94, Math.round((doneUnits / totalUnits) * 100)));
    }

    let currentPhase = '待機中';
    if (pendingPermission) {
      currentPhase = '等待權限授權確認';
    } else if (primaryIsRunning) {
      if (anySubRunning) {
        const names = runningSubagents.map(s => s.name).slice(0, 2).join('、');
        currentPhase = `子代理協作中：${names}${runningSubagents.length > 2 ? ` 等 ${runningSubagents.length} 個` : ''}`;
      } else if (waitingSubagent) {
        currentPhase = '等待子代理回傳結果';
      } else if (primaryInFlightNames.length > 0) {
        currentPhase = `正在執行工具：${primaryInFlightNames.slice(0, 2).join(', ')}`;
      } else {
        const glowingCap = capabilities.find(c => c.is_running);
        currentPhase = glowingCap ? `正在執行：${glowingCap.label}` : '深度推理與生成中';
      }
    } else if (latestTurn?.status === 'failed' || latestTurn?.status === 'interrupted') {
      currentPhase = latestTurn.status === 'interrupted' ? '回合已中斷' : '回合執行失敗';
    } else if (turns.length > 0) {
      currentPhase = '回合已完成 · 待命中';
    }

    // Sort combined timeline events chronologically and keep tail
    rawEvents.sort((a, b) => (a.timestamp_ms || 0) - (b.timestamp_ms || 0));
    const boundedLimit = Math.max(1, Math.min(120, Number(limit) || 60));
    const events = rawEvents.slice(-boundedLimit);

    // Keep sessions payload clean (strip raw thread row objects)
    const cleanSessions = enrichedSessions.map(s => ({
      session_id: s.session_id,
      model: s.model,
      model_display: s.model_display,
      reasoning_effort: s.reasoning_effort,
      is_running: s.session_id === activeThreadId ? primaryIsRunning : s.is_running,
      updated_at_ms: s.updated_at_ms,
      subagent_count: s.session_id === activeThreadId ? subagents.length : s.subagent_count,
      tokens_used: s.tokens_used,
      source: s.source,
    }));

    const scopedTurnsTotal = isTurnScope ? (latestTurn ? 1 : 0) : turns.length;
    const scopedTurnsCompleted = isTurnScope ? (latestTurn?.status === 'completed' ? 1 : 0) : turnsCompleted;
    const scopedTurnsFailed = isTurnScope ? ((latestTurn?.status === 'failed' || latestTurn?.status === 'interrupted') ? 1 : 0) : turnsFailed;
    const scopedRuntimeMs = isTurnScope ? currentTurnElapsedMs : totalRuntimeMs;
    const totalTokensSession = Math.max(Number(activeThread.tokens_used || 0), primaryRollout.lastTokenTotal || 0);
    const scopedTokens = isTurnScope
      ? Number(primaryRollout.turnTokensByTurnId?.[activeTurnId] || 0)
      : totalTokensSession;
    const primaryInvocations = primaryToolTotal + primaryInFlightToolsCount + scopedTurnsTotal;
    const totalInvocations = primaryInvocations + subagents.reduce((acc, s) => acc + s.invocations, 0);

    return {
      connected: true,
      source: matchingHooks.length > 0 ? 'codex-sqlite+hooks' : 'codex-sqlite',
      scope: normalizedScope,
      active_turn_id: activeTurnId,
      active_turn_index: turns.length,
      session_turns_total: turns.length,
      timestamp_ms: nowMs,
      active_session_id: activeThreadId,
      mode: subagents.length > 0 ? 'multi-agent' : 'single-model',
      sessions: cleanSessions,
      primary: {
        id: activeThreadId,
        model: primaryModel,
        display_name: primaryDisplay,
        family: primaryFamily,
        reasoning_effort: primaryEffort,
        state: pendingPermission
          ? 'waiting_permission'
          : (primaryIsRunning
              ? (waitingSubagent ? 'waiting_subagent' : 'running')
              : (latestTurn?.status === 'failed' ? 'failed' : (turns.length > 0 ? 'done' : 'idle'))),
        is_running: primaryIsRunning,
        current_phase: currentPhase,
        turns_total: scopedTurnsTotal,
        turns_completed: scopedTurnsCompleted,
        turns_failed: scopedTurnsFailed,
        turn_index: turns.length,
        session_turns_total: turns.length,
        turns_in_progress: primaryTurnRunning ? 1 : 0,
        tool_calls_total: primaryToolTotal + primaryInFlightToolsCount,
        tool_calls_completed: primaryToolCompleted,
        tool_calls_in_flight: primaryInFlightToolsCount,
        invocations: primaryInvocations,
        completion_pct: completionPct,
        current_turn_started_ms: primaryTurnRunning ? currentTurnStartedMs : 0,
        current_turn_elapsed_ms: currentTurnElapsedMs,
        total_runtime_ms: scopedRuntimeMs,
        session_total_runtime_ms: totalRuntimeMs,
        tokens_used: scopedTokens,
        session_tokens_used: totalTokensSession,
        context_window_tokens: primaryRollout.contextWindowTokens || 0,
        pending_permission: pendingPermission,
      },
      capabilities,
      subagents,
      events,
      summary: {
        active_models_count: (primaryTurnRunning ? 1 : 0) + runningSubagents.length,
        used_capabilities_count: capabilities.filter(c => c.used).length,
        running_capabilities_count: capabilities.filter(c => c.is_running).length,
        total_subagents: subagents.length,
        running_subagents: runningSubagents.length,
        total_invocations: totalInvocations,
        total_runtime_ms: scopedRuntimeMs,
        session_ended: !primaryIsRunning,
        has_data: turns.length > 0 || capabilities.some(c => c.used) || subagents.length > 0,
      },
    };
  } catch (error) {
    // Graceful fallback to Hook-only telemetry if SQLite read hits an unexpected lock or schema mismatch
    const fallback = buildHookOnlyPayload(hookEvents, {
      session_id: session_id || preferred_session_id,
      scope: normalizedScope,
      limit,
      nowMs,
    });
    fallback.warning = String(error?.message || error);
    return fallback;
  } finally {
    if (historyDb) {
      try { historyDb.close(); } catch {}
    }
    if (stateDb) {
      try { stateDb.close(); } catch {}
    }
  }
}

export function clearHookEventsLog(overridePath) {
  const logPath = getTelemetryLogPath(overridePath);
  try {
    if (existsSync(logPath)) {
      writeFileSync(logPath, '', 'utf8');
    }
    return { ok: true, cleared: true };
  } catch (error) {
    return { ok: false, cleared: false, error: String(error?.message || error) };
  }
}
