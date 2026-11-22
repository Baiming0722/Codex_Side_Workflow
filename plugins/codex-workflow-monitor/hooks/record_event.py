#!/usr/bin/env python3
"""Read-only diagnostic hook; stdout intentionally empty. No secrets, raw prompts or tool args."""
import sys
import os
import json
import time
from pathlib import Path

EVENTS = {
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'PreModelRequest',
    'PostModelRequest',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SubagentStart',
    'SubagentStop',
    'Stop',
    'Interrupt',
}

MAX_LOG_BYTES = 1024 * 1024
KEEP_LOG_LINES = 600


def classify_tool_category(tool_name: str) -> str:
    t = (tool_name or '').lower()
    if not t:
        return ''
    if any(k in t for k in ('test', 'pytest', 'jest', 'vitest', 'audit', 'review', 'diff', 'check')):
        return 'tests'
    if any(k in t for k in ('grep', 'codegraph', 'search_code', 'symbol', 'reference', 'definition')):
        return 'grep'
    if any(k in t for k in ('find', 'glob', 'list', 'files', 'tree', 'ls', 'explore', 'search')):
        return 'search'
    if any(k in t for k in ('patch', 'edit', 'write', 'create', 'replace')):
        return 'edit'
    if any(k in t for k in ('bash', 'shell', 'exec', 'command', 'terminal')):
        return 'shell'
    if any(k in t for k in ('read', 'view', 'open', 'cat')):
        return 'grep'
    return 'other'


def classify_node_and_actor(event: str, agent_type: str, agent_id: str, model: str, tool_name: str):
    at = (agent_type or '').strip().lower()
    md = (model or '').strip().lower()
    tool_cat = classify_tool_category(tool_name)

    if at in ('advisor', 'astra') or (agent_id and 'astra' in md):
        return 'astra', 'Astra:advisor', 'gold', tool_cat
    if at in ('explorer', 'pr_explorer'):
        return 'search', 'Luna:explorer', 'cyan', tool_cat or 'search'
    if at == 'search':
        return 'search', 'Luna:search', 'cyan', tool_cat or 'search'
    if at in ('grep', 'code_mapper'):
        return 'grep', 'Luna:grep', 'cyan', tool_cat or 'grep'
    if at in ('audit', 'terra', 'tests', 'reviewer', 'review') or (agent_id and 'terra' in md):
        return 'tests', 'Terra:audit', 'cyan', tool_cat or 'tests'
    if 'luna' in at or (agent_id and 'luna' in md):
        if tool_cat == 'grep':
            return 'grep', 'Luna:grep', 'cyan', 'grep'
        return 'search', 'Luna:search', 'cyan', tool_cat or 'search'

    if event == 'PermissionRequest':
        return 'astra', 'Astra:審核', 'gold', tool_cat
    if event in ('PreCompact', 'PostCompact'):
        return 'runtime', '執行資源', 'gold', tool_cat
    if agent_id:
        display = agent_type or f'子代理:{agent_id[:8]}'
        if tool_cat in ('search', 'grep', 'tests'):
            return tool_cat, display, 'cyan', tool_cat
        return 'router', display, 'cyan', tool_cat

    return 'sol', 'Sol', '', tool_cat


def extract_token_usage(raw_usage):
    if not isinstance(raw_usage, dict):
        return None
    out = {}
    for k in ('input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'reasoning_tokens'):
        v = raw_usage.get(k)
        if isinstance(v, (int, float)) and v >= 0:
            out[k] = int(v)
    if 'cached_input_tokens' not in out:
        alt = raw_usage.get('cache_read_input_tokens')
        if isinstance(alt, (int, float)) and alt >= 0:
            out['cached_input_tokens'] = int(alt)
    return out or None


def build_label(event: str, tool: str, agent: str, model: str, reason: str, token_usage):
    actor_desc = agent or ('主代理 Sol' if not agent else agent)
    if event == 'SessionStart':
        return f'工作階段開始（模型：{model or "預設"}）'
    if event == 'SessionEnd':
        return f'工作階段結束{f"（{reason}）" if reason else ""}'
    if event == 'UserPromptSubmit':
        return '收到新回合任務指令'
    if event == 'PreModelRequest':
        return f'{actor_desc} 發起模型推理（{model or "未指定模型"}）'
    if event == 'PostModelRequest':
        tok = f' · 消耗 {token_usage.get("total_tokens")} tokens' if isinstance(token_usage, dict) and token_usage.get('total_tokens') else ''
        return f'{actor_desc} 完成模型推理（{model or "未指定模型"}{tok}）'
    if event == 'PreToolUse':
        return f'開始使用工具：{tool or "未命名"}'
    if event == 'PermissionRequest':
        return f'等待授權審核：{tool or "敏感操作"}'
    if event == 'PostToolUse':
        return f'工具執行結束：{tool or "未命名"}'
    if event == 'PreCompact':
        return f'開始上下文壓縮{f"（{reason}）" if reason else ""}'
    if event == 'PostCompact':
        return '完成上下文壓縮'
    if event == 'SubagentStart':
        return f'子代理啟動：{agent or "未命名"}{f"（{model}）" if model else ""}'
    if event == 'SubagentStop':
        return f'子代理結束並交回成果：{agent or "未命名"}'
    if event == 'Stop':
        return '代理回合完成並停止'
    if event == 'Interrupt':
        return '使用者中斷執行'
    return event


def resolve_log_file() -> Path:
    override = os.environ.get('CODEX_WORKFLOW_MONITOR_LOG')
    if override:
        p = Path(override)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    directory = Path.home() / '.codex-workflow-monitor'
    directory.mkdir(parents=True, exist_ok=True)
    return directory / 'events.jsonl'


def append_with_rotation(file: Path, line: str):
    with file.open('a', encoding='utf8') as f:
        f.write(line)
    try:
        if file.stat().st_size > MAX_LOG_BYTES:
            lines = file.read_text(encoding='utf8', errors='ignore').splitlines()
            trimmed = '\n'.join(lines[-KEEP_LOG_LINES:]) + '\n'
            tmp = file.with_suffix('.jsonl.tmp')
            tmp.write_text(trimmed, encoding='utf8')
            tmp.replace(file)
    except Exception:
        pass


def main():
    raw = sys.stdin.read(128 * 1024)
    if not raw or not raw.strip():
        return
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        return
    event = obj.get('hook_event_name')
    if event not in EVENTS:
        return

    tool = str(obj.get('tool_name') or '')[:80]
    agent = str(obj.get('agent_type') or '')[:80]
    agent_id = str(obj.get('agent_id') or '')[:128]
    model = str(obj.get('model') or '')[:80]
    permission_mode = str(obj.get('permission_mode') or '')[:40]
    tool_use_id = str(obj.get('tool_use_id') or '')[:128]
    reason = str(obj.get('reason') or obj.get('trigger') or '')[:80]
    token_usage = extract_token_usage(obj.get('token_usage'))

    node_id, who, kind, tool_category = classify_node_and_actor(
        event, agent, agent_id, model, tool
    )
    label = build_label(event, tool, agent, model, reason, token_usage)

    # Do not store tool arguments / outputs / assistant content / user content.
    item = {
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'timestamp_ms': int(time.time() * 1000),
        'event_type': event,
        'session_id': str(obj.get('session_id') or '')[:128],
        'turn_id': str(obj.get('turn_id') or '')[:128],
        'agent_id': agent_id,
        'agent_type': agent,
        'model': model,
        'permission_mode': permission_mode,
        'tool_name': tool,
        'tool_use_id': tool_use_id,
        'tool_category': tool_category,
        'node_id': node_id,
        'who': who,
        'kind': kind,
        'label': label,
    }
    if reason:
        item['reason'] = reason
    if token_usage:
        item['token_usage'] = token_usage

    file = resolve_log_file()
    line = json.dumps(item, ensure_ascii=False, separators=(',', ':')) + '\n'
    append_with_rotation(file, line)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass  # monitoring must never break agent tasks
