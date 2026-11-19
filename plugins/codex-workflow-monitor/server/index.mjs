import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readLiveWorkflowState, clearHookEventsLog } from './telemetry.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RESOURCE_URI = 'ui://codex-workflow/monitor.html';
export const PLUGIN_VERSION = '0.3.3';

let hostPreferredSessionId = '';

function safeReplaceOnce(source, needle, replacement) {
  const idx = source.indexOf(needle);
  if (idx === -1) return source;
  return source.slice(0, idx) + replacement + source.slice(idx + needle.length);
}

function extractHostSessionId(args, extra) {
  if (args && typeof args.session_id === 'string' && args.session_id.trim()) {
    return args.session_id.trim();
  }
  const meta = extra?._meta || extra?.requestInfo?.meta || null;
  if (meta && typeof meta === 'object') {
    for (const key of ['threadId', 'openai/threadId', 'codex/threadId', 'conversationId', 'openai/conversationId', 'sessionId']) {
      if (typeof meta[key] === 'string' && meta[key].trim()) {
        return meta[key].trim();
      }
    }
  }
  return '';
}

export function buildHostedHtml() {
  const htmlSource = readFileSync(path.join(pluginRoot, 'public', 'monitor-zh.html'), 'utf8');
  const bridgePath = path.join(pluginRoot, 'dist', 'bridge.js');
  const bridge = existsSync(bridgePath) ? readFileSync(bridgePath, 'utf8') : null;

  // Use literal slicing (safeReplaceOnce) instead of String.prototype.replace so `$&` / `` $` ``
  // inside bundled JS (such as Zod regexes) are NEVER interpreted as replacement patterns.
  const headInjected = safeReplaceOnce(
    htmlSource,
    '</head>',
    '<script>window.__CODEX_MONITOR_HOSTED__=true;</script></head>'
  );

  if (bridge) {
    const safeBridge = bridge.replace(/<\/(script)/gi, '<\\/$1');
    return safeReplaceOnce(headInjected, '</body>', `<script>${safeBridge}</script></body>`);
  }

  const missingBridgeScript = `<script>
    window.addEventListener('DOMContentLoaded', () => {
      const banner = document.getElementById('modeText');
      if (banner) banner.textContent = '尚未編譯 dist/bridge.js（請執行 npm run build）';
    });
  </script>`;
  return safeReplaceOnce(headInjected, '</body>', `${missingBridgeScript}</body>`);
}

export async function readWorkflowPayload(options = {}) {
  const explicitSession = typeof options?.session_id === 'string' ? options.session_id.trim() : '';
  const followAuto = options?.session_id === '__auto__';
  const scope = options?.scope === 'turn' ? 'turn' : 'session';
  return await readLiveWorkflowState({
    session_id: followAuto ? '' : explicitSession,
    preferred_session_id: followAuto ? '' : (options?.preferred_session_id || hostPreferredSessionId),
    scope,
    limit: options?.limit ?? 60,
    codexHome: options?.codexHome,
    telemetryLogPath: options?.telemetryLogPath,
    forceHooksOnly: Boolean(options?.forceHooksOnly),
  });
}

export function clearWorkflowEvents(overridePath) {
  return clearHookEventsLog(overridePath);
}

const server = new McpServer({ name: 'codex-workflow-monitor', version: PLUGIN_VERSION });

registerAppResource(
  server,
  'codex-workflow-monitor-ui',
  RESOURCE_URI,
  {
    description: 'Codex 即時模型與動態子代理工作流監控側邊分頁介面（單模型與多代理皆適用）',
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
  async () => ({
    contents: [
      {
        uri: RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: buildHostedHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  })
);

registerAppTool(
  server,
  'open_workflow_monitor',
  {
    title: 'Codex Workflow',
    description: '在對話側邊分頁（Thread Side Panel）或全域側邊欄開啟繁體中文的 Codex 即時工作流監控介面。單模型與多子代理模式皆隨時可用，僅發光顯示正在運行的模型、功能模組與子代理，並即時呈現緩存命中率、調用次數、總 Token 消耗與運行時間。',
    inputSchema: {
      session_id: z.string().optional().describe('選填：指定要顯示的工作階段 thread / session ID；未指定時自動鎖定目前對話或最新運行中的工作階段。'),
      scope: z.enum(['session', 'turn']).optional().describe('選填：統計範圍，session（整個對話）或 turn（當前輪次），預設 session。'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      ui: { resourceUri: RESOURCE_URI },
      'openai/outputTemplate': RESOURCE_URI,
      'openai/ui': {
        entrypoints: [{ type: 'thread' }, { type: 'global' }],
      },
    },
  },
  async (args = {}, extra = {}) => {
    const detectedSession = extractHostSessionId(args, extra);
    if (detectedSession) hostPreferredSessionId = detectedSession;
    const initialPayload = await readWorkflowPayload({
      session_id: args?.session_id || '',
      preferred_session_id: detectedSession || hostPreferredSessionId,
      scope: args?.scope || 'session',
      limit: 60,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(initialPayload),
        },
      ],
      structuredContent: initialPayload,
    };
  }
);

server.registerTool(
  'read_workflow_events',
  {
    title: '讀取 Codex 即時運行狀態與事件',
    description: '唯讀取得目前 Codex 工作階段的即時模型狀態、啟用的功能模組、動態子代理（若有調用）、緩存命中率、調用次數、總 Token 消耗（主代理與子代理加總）、運行時間與安全事件紀錄（不含對話內容、參數或機密）。',
    inputSchema: {
      session_id: z.string().optional().describe('選填：指定工作階段 ID；留空或傳入 __auto__ 時自動追蹤當前或最新運行中的工作階段。'),
      scope: z.enum(['session', 'turn']).optional().describe('選填：統計範圍，session（整個對話）或 turn（當前輪次），預設 session。'),
      limit: z.number().int().min(1).max(120).optional().describe('選填：回傳的最大活動紀錄筆數（預設 60）。'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args = {}, extra = {}) => {
    const detectedSession = extractHostSessionId(args, extra);
    const payload = await readWorkflowPayload({
      session_id: args?.session_id || '',
      preferred_session_id: detectedSession || hostPreferredSessionId,
      scope: args?.scope || 'session',
      limit: args?.limit ?? 60,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }
);

server.registerTool(
  'clear_workflow_events',
  {
    title: '清空本機 Hook 紀錄檔',
    description: '僅清空本機 ~/.codex-workflow-monitor/events.jsonl 中的 Hook 中繼紀錄，不會改動 Codex 原生對話資料庫。',
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const res = clearWorkflowEvents();
    return {
      content: [{ type: 'text', text: JSON.stringify(res) }],
      structuredContent: res,
    };
  }
);

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await server.connect(new StdioServerTransport());
}
