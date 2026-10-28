// Ścieżki zgłaszane przez powłoki (PowerShell, WSL) w OSC 7. Uruchomienie: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOsc7 } from '../src/lib/terminal/osc.ts';

test('PowerShell: zakodowana ścieżka Windows', () => {
  assert.deepEqual(parseOsc7('file:///C%3A/Users/Pawe%C5%82/Moje%20dokumenty'), { cwd: 'C:\\Users\\Paweł\\Moje dokumenty', dir: 'C:\\Users\\Paweł\\Moje dokumenty' });
  assert.deepEqual(parseOsc7('file:///C%3A/'), { cwd: 'C:\\', dir: 'C:\\' });
  assert.deepEqual(parseOsc7('file:///D%3A'), { cwd: 'D:\\', dir: 'D:\\' });
});

test('PowerShell: ścieżka sieciowa', () => {
  assert.deepEqual(parseOsc7('file://///serwer/udzial/x'), { cwd: '\\\\serwer\\udzial\\x', dir: '\\\\serwer\\udzial\\x' });
});

test('WSL: ścieżka Linuksa i odpowiednik do odczytu z Windows', () => {
  assert.deepEqual(parseOsc7('file://wsl.localhost/Ubuntu/home/jan/my dir'), { cwd: '/home/jan/my dir', dir: '\\\\wsl.localhost\\Ubuntu\\home\\jan\\my dir' });
  assert.deepEqual(parseOsc7('file://wsl.localhost/Ubuntu/'), { cwd: '/', dir: '\\\\wsl.localhost\\Ubuntu\\' });
  assert.deepEqual(parseOsc7('file://wsl.localhost/Ubuntu/mnt/c/Users/Ala'), { cwd: '/mnt/c/Users/Ala', dir: 'C:\\Users\\Ala' });
  assert.deepEqual(parseOsc7('file://wsl.localhost/Ubuntu/mnt/d'), { cwd: '/mnt/d', dir: 'D:\\' });
  assert.deepEqual(parseOsc7('file://wsl.localhost/Ubuntu/tmp/100%'), { cwd: '/tmp/100%', dir: '\\\\wsl.localhost\\Ubuntu\\tmp\\100%' });
});

test('zwykły OSC 7 (bash, zsh) i śmieci', () => {
  assert.deepEqual(parseOsc7('file://laptop/home/jan'), { cwd: '/home/jan', dir: '/home/jan' });
  assert.equal(parseOsc7('nie-url'), null);
});
