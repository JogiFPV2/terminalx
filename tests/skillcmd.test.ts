// Komenda `npx skills add …` wklejona w Ustawienia → Skille.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillCommand } from '../src/lib/skillcmd.ts';

const ok = (s: string) => { const r = parseSkillCommand(s); assert.ok(!('error' in r), `${s}: ${'error' in r ? r.error : ''}`); return r as { source: string; skills: string[] }; };
const err = (s: string) => assert.ok('error' in parseSkillCommand(s), s);

test('różne uruchamiacze i samo źródło', () => {
  for (const s of ['npx skills add mattpocock/skills', 'npx -y skills add mattpocock/skills', 'npx skills@latest add mattpocock/skills', 'pnpm dlx skills add mattpocock/skills', 'bunx skills a mattpocock/skills', '$ npx skills add mattpocock/skills', 'mattpocock/skills', 'npx add-skill mattpocock/skills'])
    assert.deepEqual(ok(s), { source: 'mattpocock/skills', skills: [] }, s);
  assert.equal(ok('npx skills add https://github.com/vercel-labs/agent-skills').source, 'https://github.com/vercel-labs/agent-skills');
  assert.equal(ok('https://github.com/vercel-labs/agent-skills').source, 'https://github.com/vercel-labs/agent-skills');
});

test('wybór skilli: -s/--skill po spacji, po przecinku, *', () => {
  assert.deepEqual(ok('npx skills add mattpocock/skills --skill tdd retro -g -y').skills, ['tdd', 'retro']);
  assert.deepEqual(ok('npx skills add mattpocock/skills -s tdd,retro').skills, ['tdd', 'retro']);
  assert.deepEqual(ok('npx skills add mattpocock/skills --skill=tdd').skills, ['tdd']);
  assert.deepEqual(ok("npx skills add mattpocock/skills --skill '*'").skills, []);
  assert.deepEqual(ok('npx skills add mattpocock/skills -a claude-code codex --all').skills, []);
  assert.equal(ok('npx skills add mattpocock/skills -a claude-code codex --skill tdd').source, 'mattpocock/skills');
});

test('błędy: inna komenda, brak źródła, znaki powłoki', () => {
  for (const s of ['', 'npx skills remove tdd', 'npx skills add', 'npx skills add a/b c/d', 'npx skills add "a/b & calc"', 'npx skills add a/b --skill "x;y"', 'npm install foo', 'rm -rf /'])
    err(s);
});
