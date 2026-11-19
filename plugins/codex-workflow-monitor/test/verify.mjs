import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildHostedHtml, readWorkflowPayload, RESOURCE_URI } from '../server/index.mjs';
import { isSelfMonitorTool, formatModelDisplayName } from '../server/telemetry.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function testHostedHtmlIntegrity() {
  const html = buildHostedHtml();
  assert.ok(html.includes('window.__CODEX_MONITOR_HOSTED__=true;'), 'Missing hosted flag injection');

  // Verify <!DOCTYPE html> appears strictly ONCE (guards against String.replace $` expansion bug)
  const doctypeCount = (html.match(/<!DOCTYPE html>/gi) || []).length;
  assert.equal(doctypeCount, 1, `Expected exactly 1 <!DOCTYPE html>, got ${doctypeCount}`);

  // Extract and syntax-validate every <script> block in the generated HTML
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert.equal(blocks.length, 3, `Expected exactly 3 <script> blocks (hosted flag, UI, bridge), got ${blocks.length}`);

  for (let i = 0; i < blocks.length; i++) {
    const code = blocks[i][1];
    assert.ok(code.length > 0, `Script block ${i} is empty`);
    // new Function parses full JS syntax without executing
    new Function(code);
  }
  console.log(`PASS [HTML/JS integrity] ${blocks.length} script blocks parsed cleanly, total ${Math.round(html.length / 1024)} KB`);
}

async function testSingleAndMultiAgentHookModes() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'codex-wf-test-'));
  const logPath = path.join(tmpDir, 'events.jsonl');
  const now = Date.now();

  try {
    // Case A: Single-model GPT-6.2-Sol running an active shell tool (NO subagents)
    const singleEvents = [
      { timestamp_ms: now - 15000, event_type: 'SessionStart', session_id: 'sess-single', model: 'gpt-6.2-sol', label: '開始' },
      { timestamp_ms: now - 14000, event_type: 'UserPromptSubmit', session_id: 'sess-single', model: 'gpt-6.2-sol', label: '任務' },
      { timestamp_ms: now - 12000, event_type: 'PreToolUse', session_id: 'sess-single', model: 'gpt-6.2-sol', tool_name: 'open_workflow_monitor', tool_use_id: 'self-1' },
      { timestamp_ms: now - 11500, event_type: 'PostToolUse', session_id: 'sess-single', model: 'gpt-6.2-sol', tool_name: 'open_workflow_monitor', tool_use_id: 'self-1' },
      { timestamp_ms: now - 10000, event_type: 'PreToolUse', session_id: 'sess-single', model: 'gpt-6.2-sol', tool_name: 'apply_patch', tool_use_id: 'edit-1' },
      { timestamp_ms: now - 9000, event_type: 'PostToolUse', session_id: 'sess-single', model: 'gpt-6.2-sol', tool_name: 'apply_patch', tool_use_id: 'edit-1' },
      { timestamp_ms: now - 3000, event_type: 'PreToolUse', session_id: 'sess-single', model: 'gpt-6.2-sol', tool_name: 'exec', tool_use_id: 'cmd-1' },
    ];
    writeFileSync(logPath, singleEvents.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const singleRes = await readWorkflowPayload({
      session_id: 'sess-single',
      telemetryLogPath: logPath,
      forceHooksOnly: true,
    });

    assert.equal(singleRes.mode, 'single-model', 'Single-model session must report mode=single-model');
    assert.equal(singleRes.primary.display_name, 'GPT-6.2-Sol');
    assert.equal(singleRes.primary.is_running, true, 'Active single model should glow (is_running=true)');
    assert.equal(singleRes.subagents.length, 0, 'Single-model session must have 0 subagents');
    assert.equal(singleRes.primary.tool_calls_total, 2, 'Self monitor tool call must be filtered out (2 real tool calls)');

    const shellCap = singleRes.capabilities.find(c => c.id === 'shell');
    const editCap = singleRes.capabilities.find(c => c.id === 'edit');
    const webCap = singleRes.capabilities.find(c => c.id === 'web');
    assert.equal(shellCap.is_running, true, 'In-flight shell capability must glow');
    assert.equal(editCap.used, true, 'Completed edit capability should be marked used');
    assert.equal(editCap.is_running, false, 'Completed edit capability must NOT glow');
    assert.equal(webCap.used, false, 'Unused web capability must stay unused (hidden by default)');

    // Case B: Subagent spawned (Luna Search completed -> unlit, Terra Audit running -> glowing)
    const multiEvents = [
      ...singleEvents,
      { timestamp_ms: now - 2500, event_type: 'PostToolUse', session_id: 'sess-single', model: 'gpt-6.2-sol', tool_name: 'exec', tool_use_id: 'cmd-1' },
      { timestamp_ms: now - 2000, event_type: 'SubagentStart', session_id: 'sess-single', agent_id: 'ag-1', agent_type: 'search', model: 'gpt-6-luna', who: 'Luna Search' },
      { timestamp_ms: now - 1200, event_type: 'SubagentStop', session_id: 'sess-single', agent_id: 'ag-1', agent_type: 'search', model: 'gpt-6-luna', who: 'Luna Search' },
      { timestamp_ms: now - 800, event_type: 'SubagentStart', session_id: 'sess-single', agent_id: 'ag-2', agent_type: 'audit', model: 'gpt-6.1-terra', who: 'Terra Audit' },
    ];
    writeFileSync(logPath, multiEvents.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const multiRes = await readWorkflowPayload({
      session_id: 'sess-single',
      telemetryLogPath: logPath,
      forceHooksOnly: true,
    });

    assert.equal(multiRes.mode, 'multi-agent');
    assert.equal(multiRes.subagents.length, 2);
    const searchSub = multiRes.subagents.find(s => s.id === 'ag-1');
    const auditSub = multiRes.subagents.find(s => s.id === 'ag-2');
    assert.equal(searchSub.is_running, false, 'Stopped subagent must NOT glow');
    assert.equal(searchSub.completion_pct, 100, 'Stopped subagent should be 100%');
    assert.equal(auditSub.is_running, true, 'Running subagent must glow');
    assert.equal(isSelfMonitorTool('codex-workflow-monitor', 'read_workflow_events'), true);
    assert.equal(formatModelDisplayName('gpt-6.2-sol'), 'GPT-6.2-Sol');

    // Case C: Multi-turn scope switching ('session' vs 'turn')
    const twoTurnEvents = [
      { timestamp_ms: now - 30000, event_type: 'SessionStart', session_id: 'sess-scope', model: 'gpt-6.2-sol' },
      { timestamp_ms: now - 29000, event_type: 'UserPromptSubmit', session_id: 'sess-scope', turn_id: 'turn-1', model: 'gpt-6.2-sol' },
      { timestamp_ms: now - 27000, event_type: 'PreToolUse', session_id: 'sess-scope', turn_id: 'turn-1', tool_name: 'web_search', tool_use_id: 'w1' },
      { timestamp_ms: now - 25000, event_type: 'PostToolUse', session_id: 'sess-scope', turn_id: 'turn-1', tool_name: 'web_search', tool_use_id: 'w1' },
      { timestamp_ms: now - 24000, event_type: 'SubagentStart', session_id: 'sess-scope', turn_id: 'turn-1', agent_id: 'ag-old', agent_type: 'search', model: 'gpt-6-luna', who: 'Luna Search' },
      { timestamp_ms: now - 20000, event_type: 'SubagentStop', session_id: 'sess-scope', turn_id: 'turn-1', agent_id: 'ag-old', agent_type: 'search', model: 'gpt-6-luna', who: 'Luna Search' },
      { timestamp_ms: now - 18000, event_type: 'Stop', session_id: 'sess-scope', turn_id: 'turn-1' },
      // Turn 2: purely single-model GPT-6.2-Sol with apply_patch only (no web_search, no subagents)
      { timestamp_ms: now - 5000, event_type: 'UserPromptSubmit', session_id: 'sess-scope', turn_id: 'turn-2', model: 'gpt-6.2-sol' },
      { timestamp_ms: now - 3000, event_type: 'PreToolUse', session_id: 'sess-scope', turn_id: 'turn-2', tool_name: 'apply_patch', tool_use_id: 'e2' },
    ];
    writeFileSync(logPath, twoTurnEvents.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const sessScopeRes = await readWorkflowPayload({
      session_id: 'sess-scope',
      scope: 'session',
      telemetryLogPath: logPath,
      forceHooksOnly: true,
    });
    const turnScopeRes = await readWorkflowPayload({
      session_id: 'sess-scope',
      scope: 'turn',
      telemetryLogPath: logPath,
      forceHooksOnly: true,
    });

    assert.equal(sessScopeRes.scope, 'session');
    assert.equal(sessScopeRes.subagents.length, 1, 'Session scope should include turn-1 subagent');
    assert.equal(sessScopeRes.capabilities.find(c => c.id === 'web').used, true, 'Session scope should include turn-1 web_search');
    assert.equal(turnScopeRes.scope, 'turn');
    assert.equal(turnScopeRes.mode, 'single-model', 'Turn-2 scope must be single-model');
    assert.equal(turnScopeRes.subagents.length, 0, 'Turn-2 scope must exclude turn-1 subagent');
    assert.equal(turnScopeRes.capabilities.find(c => c.id === 'web').used, false, 'Turn-2 scope must exclude turn-1 web_search');
    assert.equal(turnScopeRes.capabilities.find(c => c.id === 'edit').is_running, true, 'Turn-2 scope must glow active apply_patch');

    console.log('PASS [Telemetry logic] single-model, dynamic subagent glow/unlit, self-filter, and session/turn scope checks passed');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testStdioMcpEndToEnd() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, 'server', 'index.mjs')],
    cwd: pluginRoot,
  });
  const client = new Client({ name: 'verify-client', version: '1.0.0' }, { capabilities: {} });

  const t0 = performance.now();
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name);
    assert.ok(names.includes('open_workflow_monitor'), 'Missing open_workflow_monitor tool');
    assert.ok(names.includes('read_workflow_events'), 'Missing read_workflow_events tool');
    assert.ok(names.includes('clear_workflow_events'), 'Missing clear_workflow_events tool');

    const resList = await client.listResources();
    assert.ok(resList.resources.some(r => r.uri === RESOURCE_URI), 'Missing UI app resource');

    const resRead = await client.readResource({ uri: RESOURCE_URI });
    const content = resRead.contents?.[0];
    assert.ok(content && typeof content.text === 'string' && content.text.includes('window.__CODEX_MONITOR_HOSTED__=true;'));
    assert.equal(content.mimeType, 'text/html;profile=mcp-app');

    const openResult = await client.callTool({ name: 'open_workflow_monitor', arguments: {} });
    const parsedOpen = openResult.structuredContent || JSON.parse(openResult.content[0].text);
    assert.equal(parsedOpen.connected, true);
    assert.ok(parsedOpen.primary && typeof parsedOpen.primary.display_name === 'string');

    const readResult = await client.callTool({ name: 'read_workflow_events', arguments: { scope: 'session', limit: 15 } });
    const parsedRead = readResult.structuredContent || JSON.parse(readResult.content[0].text);
    assert.equal(parsedRead.connected, true);
    assert.equal(parsedRead.scope, 'session');
    assert.ok(Array.isArray(parsedRead.capabilities));
    assert.ok(Array.isArray(parsedRead.subagents));

    const turnResult = await client.callTool({ name: 'read_workflow_events', arguments: { scope: 'turn', limit: 15 } });
    const parsedTurn = turnResult.structuredContent || JSON.parse(turnResult.content[0].text);
    assert.equal(parsedTurn.connected, true);
    assert.equal(parsedTurn.scope, 'turn');
    assert.ok(parsedTurn.subagents.length <= parsedRead.subagents.length, 'Turn scope subagents must be <= session scope');
    assert.ok(parsedTurn.primary.invocations <= parsedRead.primary.invocations, 'Turn scope invocations must be <= session scope');

    const elapsed = Math.round(performance.now() - t0);
    console.log(
      `PASS [Stdio MCP E2E] handshake + resource + session/turn tools completed in ${elapsed}ms ` +
      `(source=${parsedRead.source}, session_subagents=${parsedRead.subagents.length}, turn_subagents=${parsedTurn.subagents.length}, ` +
      `session_inv=${parsedRead.primary.invocations}, turn_inv=${parsedTurn.primary.invocations})`
    );
  } finally {
    await client.close();
  }
}

await testHostedHtmlIntegrity();
await testSingleAndMultiAgentHookModes();
await testStdioMcpEndToEnd();
