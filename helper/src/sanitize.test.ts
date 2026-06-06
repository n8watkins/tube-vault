import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidYouTubeUrl, sanitizeFilename, wslToWindowsPath, windowsToWslPath } from './sanitize';

test('isValidYouTubeUrl accepts the supported page types', () => {
  const valid = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=abc123&list=PLxyz',
    'https://youtu.be/dQw4w9WgXcQ',                          // short link: id in the path
    'https://youtu.be/dQw4w9WgXcQ?si=abc123&t=42',           // short link with tracking params
    'http://www.youtube.com/watch?v=abc123',                 // http allowed (local-only)
    'https://www.youtube.com/shorts/abc123DEF',
    'https://www.youtube.com/live/abc123DEF',
    'https://www.youtube.com/playlist?list=PLabc',
    'https://www.youtube.com/@SomeChannel',
    'https://www.youtube.com/@SomeChannel/videos',
    'https://www.youtube.com/channel/UCabc-123/streams',
    'https://www.youtube.com/c/SomeName/shorts',
    'https://www.youtube.com/user/SomeName',
  ];
  for (const url of valid) assert.ok(isValidYouTubeUrl(url), `expected valid: ${url}`);
});

test('isValidYouTubeUrl rejects bad hosts, protocols, and non-URLs', () => {
  const invalid = [
    'https://evil.com/watch?v=abc',                          // wrong host
    'https://www.youtube.com.evil.com/watch?v=abc',          // lookalike host
    'ftp://www.youtube.com/watch?v=abc',                     // wrong protocol
    'javascript:alert(1)',                                   // not http(s)
    'https://www.youtube.com/watch',                         // /watch without ?v
    'https://www.youtube.com/playlist',                      // /playlist without ?list
    'https://www.youtube.com/',                              // bare host
    'https://www.youtube.com/results?search_query=x',        // unsupported path
    'https://youtu.be/',                                     // short link with no id
    '-rf',                                                   // flag-shaped junk, not a URL
    '--exec=rm',                                             // flag-shaped junk
    '',                                                      // empty
  ];
  for (const url of invalid) assert.ok(!isValidYouTubeUrl(url), `expected invalid: ${url}`);
});

test('sanitizeFilename strips path-unsafe characters', () => {
  assert.equal(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j'), 'abcdefghij');
  assert.equal(sanitizeFilename('hello\x00\x1fworld'), 'helloworld');
});

test('sanitizeFilename collapses whitespace and trims', () => {
  assert.equal(sanitizeFilename('  a   b   c  '), 'a b c');
  // Tabs are control chars (\x09) so they're stripped, not collapsed to a space.
  assert.equal(sanitizeFilename('a\tb'), 'ab');
});

test('sanitizeFilename caps length at 200 chars', () => {
  assert.equal(sanitizeFilename('x'.repeat(300)).length, 200);
});

test('wslToWindowsPath converts /mnt drive paths', () => {
  assert.equal(wslToWindowsPath('/mnt/c/Users/natha/Videos'), 'C:\\Users\\natha\\Videos');
  assert.equal(wslToWindowsPath('/mnt/d'), 'D:');
});

test('wslToWindowsPath passes through non-/mnt paths unchanged', () => {
  assert.equal(wslToWindowsPath('/home/natkins/x'), '/home/natkins/x');
});

test('windowsToWslPath converts drive-letter paths (back- and forward-slash)', () => {
  assert.equal(windowsToWslPath('C:\\Users\\natha\\Videos'), '/mnt/c/Users/natha/Videos');
  assert.equal(windowsToWslPath('D:/foo/bar'), '/mnt/d/foo/bar');
});

test('windowsToWslPath passes through non-Windows paths unchanged', () => {
  assert.equal(windowsToWslPath('/already/wsl/path'), '/already/wsl/path');
});

test('path conversion round-trips a real output root', () => {
  const wsl = '/mnt/c/Users/natha/Videos/Youtube Downloads';
  assert.equal(windowsToWslPath(wslToWindowsPath(wsl)), wsl);
});
