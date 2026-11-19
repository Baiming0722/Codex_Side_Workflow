import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildHostedHtml, readWorkflowPayload, RESOURCE_URI } from '../server/index.mjs';
import {
  isSelfMonitorTool,
  formatModelDisplayName,
  computeCacheHitRatePct,
  classifyToolToCapability,
  inspectRolloutTail,
} from '../server/telemetry.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function testHostedHtmlIntegrity() {
  const html = buildHostedHtml();
  assert.ok(html.includes('window.__CODEX_MONITOR_HOSTED__=true;'), 'Missing hosted flag injection');
  assert.ok(html.includes('緩存命中率'), 'Expected UI label 緩存命中率 in hosted HTML');
  assert.ok(!html.includes('完成度'), 'Legacy label 完成度 must not remain in hosted HTML');
  assert.ok(html.includes('id="uTotalTime" data-live-start="0"'), 'RUNTIME elapsed timer must support live ticking');

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

    // Case D: Hook-mode Agent + Subagent token aggregation, cache hit rate, subagent_count & Interrupt cap cleanup
    const tokenEvents = [
      { timestamp_ms: now - 10000, event_type: 'SessionStart', session_id: 'sess-tok', model: 'gpt-6.2-sol' },
      { timestamp_ms: now - 9500, event_type: 'UserPromptSubmit', session_id: 'sess-tok', turn_id: 't1', model: 'gpt-6.2-sol' },
      {
        timestamp_ms: now - 8000, event_type: 'PostModelRequest', session_id: 'sess-tok', turn_id: 't1', model: 'gpt-6.2-sol',
        token_usage: { input_tokens: 100000, cached_input_tokens: 90000, output_tokens: 500, total_tokens: 100500 },
      },
      { timestamp_ms: now - 7000, event_type: 'SubagentStart', session_id: 'sess-tok', turn_id: 't1', agent_id: 'ag-adv', agent_type: 'advisor', model: 'gpt-6.2-astra', who: 'Astra Advisor' },
      {
        timestamp_ms: now - 6000, event_type: 'PostModelRequest', session_id: 'sess-tok', turn_id: 't1', agent_id: 'ag-adv', agent_type: 'advisor', model: 'gpt-6.2-astra',
        token_usage: { input_tokens: 50000, cached_input_tokens: 25000, output_tokens: 400, total_tokens: 50400 },
      },
      { timestamp_ms: now - 5000, event_type: 'SubagentStop', session_id: 'sess-tok', turn_id: 't1', agent_id: 'ag-adv', agent_type: 'advisor', model: 'gpt-6.2-astra', who: 'Astra Advisor' },
      { timestamp_ms: now - 4000, event_type: 'PreToolUse', session_id: 'sess-tok', turn_id: 't1', tool_name: 'exec', tool_use_id: 'orphan-1' },
      { timestamp_ms: now - 3000, event_type: 'Interrupt', session_id: 'sess-tok', turn_id: 't1' },
    ];
    writeFileSync(logPath, tokenEvents.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const tokRes = await readWorkflowPayload({
      session_id: 'sess-tok',
      scope: 'session',
      telemetryLogPath: logPath,
      forceHooksOnly: true,
    });
    assert.equal(tokRes.primary.tokens_used, 100500, 'Primary tokens must only include primary model');
    assert.equal(tokRes.primary.cache_hit_rate_pct, 90, 'Primary cache hit rate should be 90%');
    assert.equal(tokRes.subagents.length, 1);
    assert.equal(tokRes.subagents[0].tokens_used, 50400, 'Subagent must track its own tokens');
    assert.equal(tokRes.subagents[0].cache_hit_rate_pct, 50, 'Subagent cache hit rate should be 50%');
    assert.equal(tokRes.summary.total_tokens_used, 150900, 'RUNTIME total tokens must sum Agent + Subagent');
    assert.equal(tokRes.summary.cache_hit_rate_pct, 76.7, 'Weighted combined cache hit rate = (90k+25k)/(100k+50k) = 76.7%');
    assert.equal(tokRes.sessions[0].subagent_count, 1, 'Session list must count distinct subagents');
    assert.equal(tokRes.primary.state, 'interrupted', 'Interrupt must set primary state=interrupted');
    assert.equal(tokRes.capabilities.find(c => c.id === 'shell').is_running, false, 'Interrupt must clear in-flight capabilities');
    assert.ok(tokRes.summary.total_invocations >= tokRes.primary.invocations, 'Summary total invocations must include primary turns');
    assert.equal(computeCacheHitRatePct(0, 0), null);
    assert.equal(classifyToolToCapability('send_message', '', '', 'collaboration'), '');
    assert.equal(classifyToolToCapability('list_agents', '', '', 'collaboration'), '');

    console.log('PASS [Telemetry logic] single-model, subagent tokens/cache hit rate, interrupt cleanup, and scope checks passed');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testSqliteAndRolloutPrecision() {
  const { DatabaseSync } = await import('node:sqlite');
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'codex-wf-sqlite-'));
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  try {
    const mainRolloutPath = path.join(tmpHome, 'rollout-main.jsonl');
    const advRolloutPath = path.join(tmpHome, 'rollout-adv.jsonl');
    const grandRolloutPath = path.join(tmpHome, 'rollout-grand.jsonl');

    // Main rollout: turn-1 + turn-2, an open exec tool call, collaboration:send_message, and a giant >300KB padding line at EOF
    const mainLines = [
      JSON.stringify({ timestamp: new Date(now - 60000).toISOString(), type: 'turn_context', payload: { model: 'gpt-6.2-sol', reasoning_effort: 'xhigh' } }),
      JSON.stringify({ timestamp: new Date(now - 59000).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
      JSON.stringify({
        timestamp: new Date(now - 50000).toISOString(), type: 'token_usage_record',
        payload: {
          turn_id: 'turn-1',
          turn_token_usage: { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 1000, total_tokens: 101000 },
          thread_token_usage: { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 1000, total_tokens: 101000 },
        },
      }),
      JSON.stringify({ timestamp: new Date(now - 49000).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
      JSON.stringify({ timestamp: new Date(now - 20000).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } }),
      JSON.stringify({
        timestamp: new Date(now - 10000).toISOString(), type: 'token_usage_record',
        payload: {
          turn_id: 'turn-2',
          turn_token_usage: { input_tokens: 200000, cached_input_tokens: 190000, output_tokens: 2000, total_tokens: 202000 },
          thread_token_usage: { input_tokens: 300000, cached_input_tokens: 270000, output_tokens: 3000, total_tokens: 303000 },
        },
      }),
      // Giant 320KB single line right after token_usage_record to test backward chunk scan recovery!
      JSON.stringify({ timestamp: new Date(now - 9000).toISOString(), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'old-big', output: 'X'.repeat(320 * 1024) } }),
      // Active open calls: 1 real exec (also present as inProgress in SQLite -> must not double count) + 1 collaboration tool (must not mark MCP)
      JSON.stringify({ timestamp: new Date(now - 2000).toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'exec', call_id: 'call-live-1' } }),
      JSON.stringify({ timestamp: new Date(now - 1500).toISOString(), type: 'response_item', payload: { type: 'function_call', namespace: 'collaboration', name: 'send_message', call_id: 'call-collab-1' } }),
    ];
    let mainOffset = 0;
    const mainTurnOffsets = {};
    let mainContent = '';
    for (let i = 0; i < mainLines.length; i++) {
      const l = mainLines[i] + '\n';
      const byteLen = Buffer.byteLength(l, 'utf8');
      if (i === 1) mainTurnOffsets.t1Start = mainOffset;
      if (i === 3) mainTurnOffsets.t1End = mainOffset + byteLen;
      if (i === 4) mainTurnOffsets.t2Start = mainOffset;
      mainContent += l;
      mainOffset += byteLen;
    }
    writeFileSync(mainRolloutPath, mainContent, 'utf8');

    // Advisor rollout: 2 child turns under root turn-2, separated by >200KB (tests byte-range lookup + compaction preservation)
    const advTurn1Rec = JSON.stringify({
      timestamp: new Date(now - 18000).toISOString(), type: 'token_usage_record',
      payload: {
        turn_id: 'adv-t1',
        turn_token_usage: { input_tokens: 100000, cached_input_tokens: 20000, output_tokens: 500, total_tokens: 100500 },
        thread_token_usage: { input_tokens: 100000, cached_input_tokens: 20000, output_tokens: 500, total_tokens: 100500 },
      },
    }) + '\n';
    const advPad = JSON.stringify({
      timestamp: new Date(now - 15000).toISOString(), type: 'compacted', payload: { pad: 'Y'.repeat(220 * 1024) },
    }) + '\n';
    const advTurn2Rec = JSON.stringify({
      timestamp: new Date(now - 12000).toISOString(), type: 'token_usage_record',
      payload: {
        turn_id: 'adv-t2',
        turn_token_usage: { input_tokens: 150000, cached_input_tokens: 130000, output_tokens: 500, total_tokens: 150500 },
        thread_token_usage: { input_tokens: 250000, cached_input_tokens: 150000, output_tokens: 1000, total_tokens: 251000 },
      },
    }) + '\n';
    const advT1Start = 0;
    const advT1End = Buffer.byteLength(advTurn1Rec, 'utf8');
    const advT2Start = advT1End;
    const advT2End = advT1End + Buffer.byteLength(advPad, 'utf8') + Buffer.byteLength(advTurn2Rec, 'utf8');
    writeFileSync(advRolloutPath, advTurn1Rec + advPad + advTurn2Rec, 'utf8');

    // Grandchild subagent rollout (spawned by advisor, depth=2!)
    const grandRec = JSON.stringify({
      timestamp: new Date(now - 11000).toISOString(), type: 'token_usage_record',
      payload: {
        turn_id: 'grand-t1',
        turn_token_usage: { input_tokens: 50000, cached_input_tokens: 45000, output_tokens: 200, total_tokens: 50200 },
        thread_token_usage: { input_tokens: 50000, cached_input_tokens: 45000, output_tokens: 200, total_tokens: 50200 },
      },
    }) + '\n';
    writeFileSync(grandRolloutPath, grandRec, 'utf8');

    // Create minimal state_1.sqlite & thread_history_1.sqlite
    const stateDb = new DatabaseSync(path.join(tmpHome, 'state_1.sqlite'));
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, rollout_path TEXT, model TEXT, reasoning_effort TEXT,
        tokens_used INTEGER DEFAULT 0, created_at_ms INTEGER, updated_at_ms INTEGER,
        source TEXT, thread_source TEXT, agent_nickname TEXT, agent_role TEXT,
        agent_path TEXT, archived INTEGER DEFAULT 0
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL
      );
    `);
    stateDb.prepare(`INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(
      'main-1', mainRolloutPath, 'gpt-6.2-sol', 'xhigh', 300000, now - 60000, now - 1000, 'user', 'user', null, null, null
    );
    // Simulate SQLite db_tokens_used lower than compacted thread_token_usage (150000 vs 251000)
    stateDb.prepare(`INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(
      'adv-1', advRolloutPath, 'gpt-6.2-astra', 'xhigh', 150000, now - 19000, now - 12000, '{"subagent":{"parent_thread_id":"main-1"}}', 'subagent', 'Astra Advisor', 'advisor', '/root/advisor'
    );
    stateDb.prepare(`INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(
      'grand-1', grandRolloutPath, 'gpt-6-luna', 'high', 50200, now - 12000, now - 11000, '{"subagent":{"parent_thread_id":"adv-1"}}', 'subagent', 'Luna Search', 'search', '/root/advisor/search'
    );
    stateDb.prepare(`INSERT INTO thread_spawn_edges VALUES (?,?,?)`).run('main-1', 'adv-1', 'closed');
    stateDb.prepare(`INSERT INTO thread_spawn_edges VALUES (?,?,?)`).run('adv-1', 'grand-1', 'closed');
    stateDb.close();

    const histDb = new DatabaseSync(path.join(tmpHome, 'thread_history_1.sqlite'));
    histDb.exec(`
      CREATE TABLE thread_turns (
        thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT,
        started_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
        rollout_byte_offset INTEGER, rollout_end_byte_offset INTEGER, root_turn_id TEXT
      );
      CREATE TABLE thread_items (
        thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
        created_at_ms INTEGER, started_at_ms INTEGER, completed_at_ms INTEGER,
        item_type TEXT, item_json TEXT
      );
    `);
    histDb.prepare(`INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      'main-1', 'turn-1', 1, 'completed', nowSec - 59, nowSec - 49, 10000, mainTurnOffsets.t1Start, mainTurnOffsets.t1End, 'turn-1'
    );
    histDb.prepare(`INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      'main-1', 'turn-2', 2, 'inProgress', nowSec - 20, null, null, mainTurnOffsets.t2Start, null, 'turn-2'
    );
    // Add 1 completed tool and 1 inProgress tool in SQLite (matching open exec call in rollout -> must NOT double-count!)
    histDb.prepare(`INSERT INTO thread_items VALUES (?,?,?,?,?,?,?,?,?)`).run(
      'main-1', 'turn-2', 'i-1', 1, now - 15000, now - 15000, now - 14000, 'commandExecution', JSON.stringify({ status: 'completed', durationMs: 1000, commandActions: [{ type: 'search' }] })
    );
    histDb.prepare(`INSERT INTO thread_items VALUES (?,?,?,?,?,?,?,?,?)`).run(
      'main-1', 'turn-2', 'i-2', 2, now - 2000, now - 2000, null, 'commandExecution', JSON.stringify({ status: 'inProgress', commandActions: [{ type: 'exec' }] })
    );
    histDb.prepare(`INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      'adv-1', 'adv-t1', 1, 'completed', nowSec - 19, nowSec - 17, 2000, advT1Start, advT1End, 'turn-2'
    );
    histDb.prepare(`INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      'adv-1', 'adv-t2', 2, 'completed', nowSec - 16, nowSec - 12, 4000, advT2Start, advT2End, 'turn-2'
    );
    histDb.prepare(`INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      'grand-1', 'grand-t1', 1, 'completed', nowSec - 12, nowSec - 11, 1000, 0, Buffer.byteLength(grandRec, 'utf8'), 'turn-2'
    );
    histDb.close();

    // Verify inspectRolloutTail recovered usage past the 320KB giant line!
    const tail = inspectRolloutTail(mainRolloutPath, 128 * 1024);
    assert.equal(tail.threadTokenUsage?.total_tokens, 303000, 'Backward scan must recover thread_token_usage past 320KB line');

    const sessState = await readWorkflowPayload({ session_id: 'main-1', scope: 'session', codexHome: tmpHome, telemetryLogPath: path.join(tmpHome, 'none.jsonl') });
    assert.equal(sessState.primary.tokens_used, 303000);
    assert.equal(sessState.primary.cache_hit_rate_pct, 90, 'Session primary cache hit rate = 270k/300k = 90%');
    assert.equal(sessState.subagents.length, 2, 'Recursive discovery must find advisor + nested grandchild subagent');
    const advSess = sessState.subagents.find(s => s.id === 'adv-1');
    const grandSess = sessState.subagents.find(s => s.id === 'grand-1');
    assert.equal(advSess.tokens_used, 251000, 'Compacted subagent must use rollout thread_token_usage (251k > db 150k)');
    assert.equal(advSess.cache_hit_rate_pct, 60, 'Advisor session cache hit = 150k/250k = 60%');
    assert.equal(grandSess.tokens_used, 50200);
    assert.equal(grandSess.cache_hit_rate_pct, 90, 'Grandchild cache hit = 45k/50k = 90%');
    assert.equal(sessState.summary.total_tokens_used, 303000 + 251000 + 50200, 'Session RUNTIME tokens must sum Agent + ALL Subagents (including nested)');
    assert.equal(sessState.summary.cache_hit_rate_pct, 77.5, 'Combined session cache hit = (270k+150k+45k)/(300k+250k+50k) = 77.5%');

    // Verify in-flight deduplication & collaboration exclusion
    assert.equal(sessState.primary.tool_calls_in_flight, 1, 'In-flight exec in both SQLite & rollout must NOT double count');
    assert.equal(sessState.primary.tool_calls_total, 2, '1 done + 1 in-flight = 2 total tool calls');
    assert.equal(sessState.capabilities.find(c => c.id === 'shell').in_flight, 1, 'Shell in_flight must not double count');
    assert.equal(sessState.capabilities.find(c => c.id === 'mcp').used, false, 'collaboration:send_message must not pollute MCP capability');

    // Verify Turn scope byte-range lookup across 2 child turns separated by 220KB compaction
    const turnState = await readWorkflowPayload({ session_id: 'main-1', scope: 'turn', codexHome: tmpHome, telemetryLogPath: path.join(tmpHome, 'none.jsonl') });
    assert.equal(turnState.primary.tokens_used, 202000, 'Turn-2 primary tokens recovered past 320KB line');
    assert.equal(turnState.primary.cache_hit_rate_pct, 95, 'Turn-2 primary cache hit = 190k/200k = 95%');
    const advTurn = turnState.subagents.find(s => s.id === 'adv-1');
    assert.equal(advTurn.tokens_used, 251000, 'Turn scope must sum BOTH adv-t1 (100.5k via byte range) + adv-t2 (150.5k) = 251k');
    assert.equal(advTurn.cache_hit_rate_pct, 60, 'Advisor turn cache hit = (20k+130k)/(100k+150k) = 60%');
    assert.equal(turnState.summary.total_tokens_used, 202000 + 251000 + 50200, 'Turn RUNTIME tokens must sum Turn-2 primary + subagents');
    assert.equal(turnState.summary.session_total_tokens_used, 303000 + 251000 + 50200, 'Session total tokens preserved in turn scope');
    assert.equal(turnState.summary.cache_hit_rate_pct, 77, 'Combined turn cache hit = (190k+150k+45k)/(200k+250k+50k) = 77%');

    console.log('PASS [SQLite + Rollout precision] byte-range turn lookup, giant-line backward scan, compaction, nested subagent, and dedup passed');
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
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
    assert.ok(typeof parsedRead.summary?.total_tokens_used === 'number', 'Summary must expose total_tokens_used');
    assert.ok(parsedRead.summary.total_tokens_used >= (parsedRead.primary.tokens_used || 0), 'total_tokens_used must include subagents');

    const turnResult = await client.callTool({ name: 'read_workflow_events', arguments: { scope: 'turn', limit: 15 } });
    const parsedTurn = turnResult.structuredContent || JSON.parse(turnResult.content[0].text);
    assert.equal(parsedTurn.connected, true);
    assert.equal(parsedTurn.scope, 'turn');
    assert.ok(parsedTurn.subagents.length <= parsedRead.subagents.length, 'Turn scope subagents must be <= session scope');
    assert.ok(parsedTurn.primary.invocations <= parsedRead.primary.invocations, 'Turn scope invocations must be <= session scope');
    assert.ok(parsedTurn.summary.total_tokens_used >= (parsedTurn.primary.tokens_used || 0), 'Turn total_tokens_used must include subagents');

    const elapsed = Math.round(performance.now() - t0);
    console.log(
      `PASS [Stdio MCP E2E] handshake + resource + session/turn tools completed in ${elapsed}ms ` +
      `(source=${parsedRead.source}, session_subagents=${parsedRead.subagents.length}, turn_subagents=${parsedTurn.subagents.length}, ` +
      `session_tokens=${parsedRead.summary.total_tokens_used}, turn_tokens=${parsedTurn.summary.total_tokens_used}, ` +
      `cache_hit=${parsedRead.summary.cache_hit_rate_pct ?? 'n/a'}%)`
    );
  } finally {
    await client.close();
  }
}

await testHostedHtmlIntegrity();
await testSingleAndMultiAgentHookModes();
await testSqliteAndRolloutPrecision();
await testStdioMcpEndToEnd();
