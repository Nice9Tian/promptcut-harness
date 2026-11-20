import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { isBuiltin } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Agent,
  MessageHistory,
  buildTools,
  createCodeCacheStore,
  resolveCodeCacheRefs,
  salvageTruncation,
  parseSkillMd,
  loadSkillCatalog,
  skillCatalogPrompt,
  loadSkillTool,
  compactHistory,
  splitMessagesForCompact,
  mergeDeltas,
  expandEntry,
  createFenceFilter,
  parseToolBlocks,
  executeToolBlocks,
  sanitizeSchema,
  toolToVendor,
} from '../index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function commentRanges(src) {
  const ranges = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i += 1;
      ranges.push([start, i]);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      ranges.push([start, i]);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        if (quote !== '`' && src[i] === '\n') break;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return ranges;
}

const inComment = (ranges, idx) => ranges.some(([a, b]) => idx >= a && idx < b);

function listMjsFiles(dir = ROOT, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) listMjsFiles(full, out);
    else if (ent.name.endsWith('.mjs')) out.push(full);
  }
  return out.sort();
}

test('zero external dependencies: all imports stay within package root or node:* built-ins', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'promptcut-harness');
  assert.equal(pkg.dependencies, undefined);

  const SPEC_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
  const violations = [];

  for (const file of listMjsFiles()) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');
    const comments = commentRanges(src);
    SPEC_RE.lastIndex = 0;
    for (let m = SPEC_RE.exec(src); m; m = SPEC_RE.exec(src)) {
      if (inComment(comments, m.index)) continue;
      const spec = m[1] || m[2] || m[3];
      if (spec.startsWith('node:')) {
        if (!isBuiltin(spec)) violations.push(`${rel}: invalid node builtin ${spec}`);
        continue;
      }
      if (!spec.startsWith('.')) {
        violations.push(`${rel}: external package import ${spec}`);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), spec);
      const relTarget = path.relative(ROOT, resolved);
      if (!relTarget || relTarget.startsWith('..') || path.isAbsolute(relTarget) || !fs.existsSync(resolved)) {
        violations.push(`${rel}: broken or escaping relative import ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('smoke runners: smoke.mjs and examples/smoke.mjs both exit 0 with verified tool calls', () => {
  for (const scriptRel of ['smoke.mjs', path.join('examples', 'smoke.mjs')]) {
    const out = execFileSync(process.execPath, [scriptRel], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.toolCalls, ['load_skill', 'calculator', 'code_cache_write', 'echo']);
  }
});

test('skills: SKILL.md parsing, catalog priority, and path traversal protection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-skills-'));
  try {
    const parsed = parseSkillMd('---\nname: demo-skill\ndescription: "Demo purpose"\n---\n\nFollow steps 1 and 2.\n');
    assert.equal(parsed.fields.name, 'demo-skill');
    assert.equal(parsed.fields.description, 'Demo purpose');
    assert.equal(parsed.body, 'Follow steps 1 and 2.');

    const skillDir = path.join(dir, 'demo-skill');
    fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo purpose\n---\n\nMain body\n');
    fs.writeFileSync(path.join(skillDir, 'references', 'guide.md'), 'Reference details');

    const { skills, skipped } = loadSkillCatalog({ dirs: [dir] });
    assert.equal(skipped.length, 0);
    assert.equal(skills.length, 1);
    assert.ok(skillCatalogPrompt(skills).includes('- demo-skill:Demo purpose'));

    const tool = loadSkillTool(skills);
    const full = await tool.execute({ name: 'demo-skill' });
    assert.equal(full.ok, true);
    assert.equal(full.text, 'Main body');
    assert.deepEqual(full.files, ['references/guide.md']);

    const sub = await tool.execute({ name: 'demo-skill', file: 'references/guide.md' });
    assert.equal(sub.text, 'Reference details');

    await assert.rejects(() => tool.execute({ name: 'demo-skill', file: '../outside.md' }), { code: 'skill-file-denied' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code-cache & truncation salvage: stores chunks, expands @code_cache refs, and salvages partial JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cache-'));
  try {
    const store = createCodeCacheStore({ dir, writer: 'unit' });
    store.write('snippet', 'line 1\n');
    store.append('snippet', 'line 2');
    assert.equal(store.read('snippet'), 'line 1\nline 2');

    const expanded = resolveCodeCacheRefs({ code: '@code_cache:snippet', untouched: 'hello' }, store);
    assert.equal(expanded.code, 'line 1\nline 2');
    assert.equal(expanded.untouched, 'hello');

    const salvaged = salvageTruncation(
      [{ id: 't1', name: 'render_doc', args: '{"title":"Doc","body":"half written markdown' }],
      store,
      { cause: 'length' },
    );
    assert.equal(salvaged.progress, true);
    assert.equal(salvaged.saved.length, 1);
    assert.equal(store.read(salvaged.saved[0].block), 'half written markdown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compact & tool-protocol & schema: delta merge, history compaction, fence stripping, and vendor schemas', async () => {
  const deltas = [
    { type: 'text', delta: 'Part A ', seq: 1 },
    { type: 'text', delta: 'Part B', seq: 2 },
  ];
  const merged = mergeDeltas(deltas);
  assert.equal(merged.length, 1);
  assert.deepEqual([...expandEntry(merged[0])], deltas);

  const history = MessageHistory.fromJSON([
    { role: 'user', content: [{ type: 'text', text: 'First task' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'check', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"ok":true}' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'First task done.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Second task' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Second task done.' }] },
  ]);
  const split = splitMessagesForCompact(history.get(), { keepRecent: 2 });
  assert.equal(split.head.length, 4);
  assert.equal(split.tail.length, 2);

  const compacted = await compactHistory(history, {
    keepRecent: 2,
    minMessages: 4,
    summarize: async () => 'First task completed.',
  });
  assert.equal(compacted.compacted, true);
  assert.equal(history.get().length, 4);

  const filter = createFenceFilter();
  const visible = filter.push('Before ```promptcut-tool\n{"name":"ping","input":{}}\n``` After') + filter.flush();
  assert.equal(visible, 'Before  After');
  const blocks = parseToolBlocks('```promptcut-tool\n{"name":"ping","input":{"x":1}}\n```');
  const execRes = await executeToolBlocks(blocks, async (_n, inp) => ({ pong: inp.x }), { tools: ['ping'] });
  assert.equal(execRes[0].ok, true);

  const clean = sanitizeSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, 'gemini');
  assert.equal(clean.additionalProperties, undefined);
  const openAiTool = toolToVendor({ name: 'ping', description: 'd', inputSchema: clean }, 'openai');
  assert.equal(openAiTool.type, 'function');
  assert.equal(openAiTool.function.name, 'ping');

  const built = await buildTools({
    localTools: false,
    tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object', properties: {} }, async execute() { return { ok: true }; } }],
  });
  let step = 0;
  const agent = new Agent({
    provider: {
      async *stream() {
        step += 1;
        if (step === 1) {
          yield { type: 'tool_use', id: 't1', name: 'old_ping', input: {} };
          yield { type: 'stop', reason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: 'Done!' };
          yield { type: 'stop', reason: 'end_turn' };
        }
      },
    },
    system: 'test',
    tools: built,
    toolNameMapper: (n) => (n === 'old_ping' ? 'ping' : n),
  });
  const out = await agent.run('go');
  assert.equal(out.completed, 1);
  assert.equal(out.text, 'Done!');
});
