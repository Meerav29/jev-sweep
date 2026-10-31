import { expect, test } from 'vitest';
import { extractBody, truncate, type GmailPayload } from '../../../server/mail/provider';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const part = (mimeType: string, text: string): GmailPayload => ({ mimeType, body: { data: b64(text) } });
const multipart = (plain: string, html: string): GmailPayload => ({ mimeType: 'multipart/alternative', parts: [part('text/plain', plain), part('text/html', html)] });
const htmlOnly = (html: string): GmailPayload => ({ mimeType: 'multipart/alternative', parts: [part('text/html', html)] });

test('extractBody prefers text/plain', () => expect(extractBody(multipart('plain text', '<p>html</p>'))).toBe('plain text'));
test('extractBody strips html-only bodies', () => expect(extractBody(htmlOnly('<div>Hi&nbsp;<b>there</b></div><style>x{}</style>'))).toBe('Hi there'));
test('extractBody of empty payload is empty string', () => expect(extractBody({ mimeType: 'text/plain', body: {} })).toBe(''));
test('extractBody walks nested multiparts', () => {
  const p: GmailPayload = { mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/related', parts: [multipart('deep plain', '<p>x</p>')] }, { mimeType: 'application/pdf', body: {} }] };
  expect(extractBody(p)).toBe('deep plain');
});
test('extractBody drops script contents, decodes entities and collapses whitespace', () => {
  expect(extractBody(htmlOnly('<script>alert(1)</script><p>A &amp; B &lt;ok&gt; &quot;q&quot; &#39;s&#39;</p>\n\n<p>next   line</p>'))).toBe('A & B <ok> "q" \'s\' next line');
});
test('extractBody decodes utf8 and collapses plain whitespace', () => expect(extractBody(part('text/plain', 'café\n\n  au   lait'))).toBe('café au lait'));
test('truncate', () => expect(truncate('abcdef', 4)).toBe('abc…'));
test('truncate keeps short strings and result length equals max', () => {
  expect(truncate('abcd', 4)).toBe('abcd');
  expect(truncate('x'.repeat(900), 600)).toHaveLength(600);
});
