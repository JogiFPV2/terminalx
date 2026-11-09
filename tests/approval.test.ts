// Lista „zawsze pytaj” agenta: warianty tej samej komendy też wymagają zgody.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesPattern, needsApproval, stricter } from '../src/lib/approval.ts';

const LIST = ['rm -rf', 'Remove-Item -Recurse', 'format', 'mkfs', 'dd if=', 'shutdown', 'git push --force', 'DROP TABLE'];
const asks = (c: string) => needsApproval('auto', c, LIST);

test('dokładne komendy z listy', () => {
  for (const c of ['rm -rf /tmp/x', 'Remove-Item -Recurse C:\\x', 'dd if=/dev/zero of=/dev/sda', 'git push --force', 'DROP TABLE users;']) assert.ok(asks(c), c);
});

test('warianty: spacje, wielkość liter, kolejność i rozdzielenie flag', () => {
  for (const c of ['rm  -rf /', 'RM -RF /', 'rm -fr /', 'rm -r -f /', 'rm -rfv build', 'sudo rm -rf /', 'drop   table users']) assert.ok(asks(c), c);
});

test('PowerShell: aliasy i skrócone parametry', () => {
  for (const c of ['Remove-Item -R C:\\x', 'remove-item -rec C:\\x', 'ri -Recurse x', 'del -r x', 'rm -Recurse -Force x', 'C:\\Windows\\System32\\shutdown.exe /s', 'Stop-Computer', 'Remove-Item "x" -Recurse:$true']) assert.ok(asks(c), c);
});

test('git: krótka postać --force', () => {
  assert.ok(asks('git push -f origin main'));
  assert.ok(asks('git   push origin main --force'));
  assert.ok(!asks('git push origin main'));
});

test('komendy bezpieczne nie pytają w trybie auto', () => {
  for (const c of ['ls -la', 'git status', 'npm test', 'Remove-Item x.txt', 'rm x.txt', 'echo rm', 'Get-ChildItem -Recurse']) assert.ok(!asks(c), c);
});

test('łańcuch komend: parametr z innej komendy nie łączy się ze wzorcem', () => {
  assert.ok(!asks('Remove-Item a.txt; Get-ChildItem -Recurse'));
  assert.ok(asks('cd x; Remove-Item -Recurse y'));
});

test('tryb pytaj zawsze pyta, tryby łączą się na ostrzejszy', () => {
  assert.ok(needsApproval('ask', 'ls', LIST));
  assert.equal(stricter('read', 'auto'), 'read');
  assert.equal(stricter('auto', 'ask'), 'ask');
  assert.equal(stricter('auto', 'auto'), 'auto');
});
