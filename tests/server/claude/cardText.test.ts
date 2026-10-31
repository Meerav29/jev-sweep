import { expect, test, vi } from 'vitest';
import { ClaudeWriter, FakeWriter, withTimeout } from '../../../server/claude/cardText';
import type { CardText } from '../../../server/claude/cardText';
import { ans, email } from '../jev/fixtures';

const reply = (text: string) => vi.fn().mockResolvedValue({ content: [{ type: 'text', text }] });
const writer = (create: unknown) => new ClaudeWriter('k', 'claude-haiku-5-5', { messages: { create } } as any);

test('withTimeout returns {} when slow', async () => {
  const slow = { write: () => new Promise<CardText>(r => setTimeout(() => r({ why: 'late' }), 50)) };
  expect(await withTimeout(slow, 10).write(email, ans({}), 'filing')).toEqual({});
});
test('withTimeout passes through fast results and swallows errors', async () => {
  expect(await withTimeout({ write: async () => ({ why: 'ok' }) }, 1000).write(email, ans({}), 'filing')).toEqual({ why: 'ok' });
  expect(await withTimeout({ write: async () => { throw new Error('boom'); } }, 1000).write(email, ans({}), 'filing')).toEqual({});
});
test('ClaudeWriter parses JSON and asks for summary only on important', async () => {
  const create = reply('{"why":"Split between two folders.","summary":["a"]}');
  const w = writer(create);
  expect(await w.write(email, ans({}), 'important')).toEqual({ why: 'Split between two folders.', summary: ['a'] });
  expect(create.mock.calls[0][0].model).toBe('claude-haiku-5-5');
  expect(create.mock.calls[0][0].max_tokens).toBe(300);
  expect(JSON.stringify(create.mock.calls[0][0].messages)).toMatch(/summary/);
  await w.write(email, ans({}), 'filing');
  expect(JSON.stringify(create.mock.calls[1][0].messages)).not.toMatch(/summary/);
});
test('ClaudeWriter strips a json fence and filters bad types', async () => {
  expect(await writer(reply('```json\n{"why":"x","summary":"nope"}\n```')).write(email, ans({}), 'important')).toEqual({ why: 'x' });
  expect(await writer(reply('{"why":3,"summary":["a",2]}')).write(email, ans({}), 'important')).toEqual({});
});
test('ClaudeWriter returns {} on parse failure; errors propagate', async () => {
  expect(await writer(reply('not json')).write(email, ans({}), 'filing')).toEqual({});
  await expect(writer(vi.fn().mockRejectedValue(new Error('net'))).write(email, ans({}), 'filing')).rejects.toThrow('net');
});
test('FakeWriter', async () => {
  const f = new FakeWriter({ t1: ['s'] });
  expect(await f.write(email, ans({}), 'important')).toEqual({ why: "Jev wasn't sure about this one.", summary: ['s'] });
  expect(await f.write(email, ans({}), 'filing')).toEqual({ why: "Jev wasn't sure about this one." });
});
