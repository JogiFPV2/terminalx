import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImport, splitArgs, joinArgs } from '../src/lib/mcpcfg.ts';

test('import z Claude Desktop: stdio i HTTP', () => {
  const list = parseImport(JSON.stringify({ mcpServers: {
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' } },
    docs: { type: 'http', url: 'https://example.com/mcp', headers: { 'X-Key': 1 } },
    off: { command: 'uvx', disabled: true },
    zly: { foo: 1 },
  } }));
  assert.equal(list.length, 3);
  assert.deepEqual([list[0].kind, list[0].args, list[0].env.GITHUB_TOKEN], ['stdio', ['-y', '@modelcontextprotocol/server-github'], 'x']);
  assert.deepEqual([list[1].kind, list[1].url, list[1].headers['X-Key']], ['http', 'https://example.com/mcp', '1']);
  assert.equal(list[2].enabled, false);
});

test('import z VS Code ("servers") i sama mapa', () => {
  assert.equal(parseImport('{"servers": {"a": {"command": "node"}}}')[0].name, 'a');
  assert.equal(parseImport('{"b": {"url": "http://localhost:3000/mcp"}}')[0].kind, 'http');
  assert.throws(() => parseImport('[1]'));
});

test('argumenty z cudzysłowami w obie strony', () => {
  const a = splitArgs('-y @scope/server "C:\Moje Projekty" \'x y\'');
  assert.deepEqual(a, ['-y', '@scope/server', 'C:\Moje Projekty', 'x y']);
  assert.deepEqual(splitArgs(joinArgs(a)), a);
});
