/** Structured CLI output is a public automation contract, not formatted human text. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppleTV } from '../appletv.js';
import { NowPlayingInfo, PlaybackState } from '../now-playing-info.js';

vi.mock('node:fs', () => ({ realpathSync: (path: string) => path, existsSync: vi.fn(() => true), readFileSync: vi.fn(() => '{"device":"credentials"}'), writeFileSync: vi.fn(), createReadStream: vi.fn() }));
vi.mock('../credentials.js', () => ({ Credentials: { deserialize: () => ({}) } }));
vi.mock('../cli/device-cache.js', () => ({ withCachedDevice: async (_file: string, _id: string, _scan: unknown, connect: (device: object) => Promise<unknown>) => connect({ name: 'TV', deviceId: 'device', address: '127.0.0.1', port: 1 }) }));
vi.mock('../discovery.js', () => ({ scan: vi.fn() }));
import { main } from '../cli/index.js';
import { scan } from '../discovery.js';

let lines: string[];
beforeEach(() => {
  lines = [];
  vi.clearAllMocks();
  vi.stubEnv('ATV_SETTLE_MS', '0');
  vi.stubEnv('ATV_POST_SEND_MS', '0');
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
  vi.spyOn(AppleTV.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(AppleTV.prototype, 'close').mockResolvedValue(undefined);
  process.exitCode = undefined;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

function record(): Record<string, unknown> { return JSON.parse(lines.join('')); }

it('writes a typed empty scan result without human progress', async () => {
  vi.mocked(scan).mockResolvedValue([]);
  await main(['--json', 'scan']);
  expect(record()).toMatchObject({ version: 1, type: 'result', command: 'scan', data: { devices: [] } });
});

it('serializes normalized playback rather than NowPlayingInfo human text', async () => {
  vi.spyOn(AppleTV.prototype, 'getNowPlaying').mockResolvedValue(new NowPlayingInfo(
    { hasPlayback: true, playbackState: PlaybackState.Playing, displayName: 'Music' },
    { title: 'Song', elapsedTime: 4 },
  ));
  await main(['state', '--json', 'device']);
  expect(record()).toMatchObject({
    version: 1, type: 'result', command: 'state', deviceId: 'device',
    data: { hasPlayback: true, title: 'Song', playbackState: 'playing', appDisplayName: 'Music' },
  });
});

it('reports invalid arguments as one safe JSON error before connection', async () => {
  await main(['--json', 'seek', 'invalid']);
  expect(record()).toMatchObject({ version: 1, type: 'error', command: 'seek', data: { code: 'invalid_arguments' } });
  expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
});

it('rejects prompt and raw diagnostic commands before connection', async () => {
  await main(['--json', 'pair']);
  expect(record()).toMatchObject({ type: 'error', command: 'pair', data: { code: 'unsupported' } });
  expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
});
