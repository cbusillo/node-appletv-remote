#!/usr/bin/env node
/**
 * `atv` command-line tool: scan, pair, control playback/text, touch, output routing and Companion,
 * inspect now-playing, keyboard, and Companion events, control legacy DMAP Apple TVs, and stream raw
 * PCM to legacy RAOP receivers (experimental). A thin consumer of the public library APIs;
 * credentials are stored as JSON in ~/.atv-credentials.json keyed by device ID, DMAP pairing GUIDs
 * in ~/.atv-dmap.json.
 */
import { scan, normalizeTxt, type DiscoveredDeviceInfo } from '../discovery.js';
import { setTimeout as delay } from 'node:timers/promises';
import { AppleTV, Key, ShuffleState, RepeatState, contentItems, INPUT_ACTIONS } from '../appletv.js';
import { PlaybackState } from '../now-playing-info.js';
import { MessageType, HID_KEY_MAP } from '../mrp/messages.js';
import { Credentials } from '../credentials.js';
import { DmapClient } from '../dmap/client.js';
import { DmapPairing } from '../dmap/pairing.js';
import { RaopStream } from '../raop/stream.js';
import { Bonjour, type Service } from 'bonjour-service';
import { readFileSync, writeFileSync, existsSync, realpathSync, createReadStream } from 'node:fs';
import { isIPv4 } from 'node:net';
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withCachedDevice } from './device-cache.js';
import { createInterface } from 'node:readline';
import type { Message } from '../message.js';
import type { KeyboardInfo, TextInputEvent, CompanionEvent, App, UserAccount, InputAction } from '../appletv.js';
import type { NowPlayingInfo } from '../now-playing-info.js';

/** Where paired credentials are stored (falls back to the current directory if HOME is unset). */
const CREDS_FILE = join(process.env.HOME ?? '.', '.atv-credentials.json');
/** Legacy DMAP pairing GUIDs, kept apart so a DMAP pairing never becomes the default modern device. */
const DMAP_FILE = join(process.env.HOME ?? '.', '.atv-dmap.json');
/** Last-known address of each paired device, so commands can skip the mDNS scan. */
const DEVICES_FILE = join(process.env.HOME ?? '.', '.atv-devices.json');

/** Non-negative ms from an env var, or `fallback` when unset/invalid; `0` disables the wait. */
function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return process.env[name]?.trim() && Number.isFinite(value) && value >= 0 ? value : fallback;
}
// HID keys get no device acknowledgment, so the CLI waits before trusting a send (old fixed values).
// Settle applies to every MRP connect: any first request may be lost before the device is ready.
const settleMs = (): number => envMs('ATV_SETTLE_MS', 500);
const postSendMs = (): number => envMs('ATV_POST_SEND_MS', 1000);

/** Ask one question on stdin and resolve with the raw answer. */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Number `devices` with `label`, then prompt for one; prints `none` or an invalid-selection notice and returns undefined. */
async function selectDevice<T>(devices: T[], none: string, label: (device: T) => string): Promise<T | undefined> {
  if (devices.length === 0) {
    console.log(none);
    return undefined;
  }
  devices.forEach((d, i) => console.log(`  ${i + 1}. ${label(d)}`));
  const device = devices[parseInt(await prompt('Select device number: ')) - 1];
  if (!device) console.log('Invalid selection.');
  return device;
}

/** Every stored value in a JSON credential `file` keyed by device ID, or {} if it does not exist. */
function readStored(file: string): Record<string, string> {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {};
}

/** Set one device's value in a JSON credential `file`, keeping every other device's entry. */
function saveStored(file: string, id: string, value: string): void {
  const stored = readStored(file);
  stored[id] = value;
  writeFileSync(file, JSON.stringify(stored, null, 2));
}

/** `atv scan`: list Apple TVs and AirPlay receivers found via mDNS within 5 s, with each `psi` output ID. */
async function cmdScan() {
  console.log('Scanning for Apple TVs...');
  const devices = await scan({ timeout: 5000 });
  if (devices.length === 0) {
    console.log('No Apple TVs found.');
    return;
  }
  devices.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d.name} (${d.address}:${d.port}) [${d.model}]${d.airplayPsi ? ` psi=${d.airplayPsi}` : ''}`);
  });
}

/** `atv pair`: pick a device, run AirPlay pair-setup with the on-screen PIN, and save the credentials. */
async function cmdPair() {
  console.log('Scanning for Apple TVs...');
  const device = await selectDevice(await scan({ timeout: 5000 }), 'No Apple TVs found.', String);
  if (!device) return;

  const atv = new AppleTV(device);
  console.log(`Pairing with ${atv.name}...`);
  const pairSetup = await atv.startPairing();

  const pin = await prompt('Enter PIN shown on Apple TV: ');
  const hapCreds = await pairSetup.finish(pin);
  saveStored(CREDS_FILE, device.deviceId, new Credentials(hapCreds).serialize());
  console.log(`Paired! Credentials saved to ${CREDS_FILE}`);
}

/**
 * Pull an optional case-insensitive action word out of `args[index]`, which precedes an optional
 * device selector. When both are present (`args.length === index + 2`) the word must be an action.
 */
function splitAction(args: string[], index: number): { action?: InputAction; rest: string[] } {
  const action = INPUT_ACTIONS.find((a) => a.toLowerCase() === args[index]?.toLowerCase());
  if (action) return { action, rest: args.filter((_, i) => i !== index) };
  if (args.length === index + 2) throw new Error(`Invalid action: ${args[index]} (expected ${INPUT_ACTIONS.join(', ')})`);
  return { rest: args };
}

/** Every Key value; these strings are the accepted CLI command names. */
const COMMAND_NAMES = Object.values(Key);
/** Fast membership check for COMMAND_NAMES. */
const COMMAND_SET = new Set<string>(COMMAND_NAMES);

/**
 * Load the stored value for the first device ID in `file` containing `deviceId`
 * (case-insensitive), or the most recently added device only if no selector is given.
 * @throws if the file is missing/empty or an explicit selector is blank or unmatched.
 */
function loadStored(file: string, pairCommand: string, deviceId?: string): { id: string; value: string } {
  if (deviceId !== undefined && !deviceId.trim()) throw new Error('Device selector must be nonblank');
  if (!existsSync(file)) {
    throw new Error(`No credentials found. Run "atv ${pairCommand}" first.`);
  }
  const entries = Object.entries(readStored(file));
  if (entries.length === 0) {
    throw new Error('No paired devices.');
  }

  const entry = deviceId === undefined ? entries[entries.length - 1]
    : entries.find(([k]) => k.toLowerCase().includes(deviceId.toLowerCase()));
  if (!entry) throw new Error(`No paired device matches "${deviceId}"`);
  return { id: entry[0], value: entry[1] };
}

/** Load modern (AirPlay/Companion) credentials; see loadStored for selector rules. */
function loadCredentials(deviceId?: string): { id: string; credentials: Credentials } {
  const { id, value } = loadStored(CREDS_FILE, 'pair', deviceId);
  return { id, credentials: Credentials.deserialize(value) };
}

/**
 * Scan (stopping early once found) and return the device whose ID equals or contains `id`, or whose name contains it (case-insensitive).
 * @throws if nothing matches; the message lists the devices that were found.
 */
async function findDevice(id: string, need: 'mrp' | 'companion' | 'dmap'): Promise<DiscoveredDeviceInfo> {
  console.error('Finding device...');
  const idLower = id.toLowerCase();
  const matches = (d: DiscoveredDeviceInfo) =>
    d.deviceId.toLowerCase() === idLower ||
    d.identifiers?.some(alias => alias.toLowerCase() === idLower) ||
    d.name.toLowerCase().includes(idLower) ||
    d.deviceId.toLowerCase().includes(idLower);
  // Stop as soon as the device has arrived with the port `need` requires: Companion, DMAP, or an
  // AirPlay/usable MRP port.
  const devices = await scan({ timeout: 5000, until: (d) => matches(d) && (need === 'companion' ? !!d.companionPort :
    need === 'dmap' ? !!d.dmapPort : !!d.port || !!d.mrpPort && d.mrpEnabled !== false) });
  const device = devices.find(matches);
  if (!device) {
    throw new Error(`Device not found on network (looking for "${id}"). Found: ${devices.map((d) => `${d.name} [${d.deviceId}]`).join(', ')}`);
  }
  return device;
}

/** Run `connect` against the device's cached address, rescanning once if that fails. */
function connectCached<T>(
  id: string,
  need: 'mrp' | 'companion' | 'dmap',
  connect: (device: DiscoveredDeviceInfo) => Promise<T>,
): Promise<T> {
  return withCachedDevice(DEVICES_FILE, id, () => findDevice(id, need), connect);
}

/** Load credentials, locate the device (cache first, then mDNS), and open an AirPlay/MRP connection. */
async function connectToDevice(deviceId?: string): Promise<AppleTV> {
  const { id, credentials } = loadCredentials(deviceId);
  return connectCached(id, 'mrp', async (device) => {
    console.error(`Connecting to ${device.name} (${device.address}:${device.port})...`);
    const atv = new AppleTV(device);
    atv.on('error', (err: Error) => console.error(`AirPlay error: ${err.message}`));
    try {
      await atv.connect(credentials, { settleMs: settleMs() });
    } catch (e) {
      await atv.close();
      throw e;
    }
    return atv;
  });
}

/** Load Companion credentials and connect only Companion, using the existing address cache. */
async function connectToCompanion(deviceId?: string): Promise<AppleTV> {
  const { id, credentials } = loadCredentials(deviceId);
  if (!credentials.companionCredentials) {
    throw new Error('No companion credentials. Run "atv companion-pair" first.');
  }
  return connectCached(id, 'companion', async (device) => {
    if (!device.companionPort) throw new Error('Device has no companion-link port');
    const atv = new AppleTV(device);
    console.error(`Connecting companion to ${device.name} (${device.address}:${device.companionPort})...`);
    try {
      await atv.connectCompanion(credentials.companionCredentials!);
      return atv;
    } catch (error) {
      await atv.close();
      throw error;
    }
  });
}

/** Companion-only buttons exposed by `command`; no MRP connection is needed. */
const COMPANION_BUTTONS = {
  channel_up: 'channelUp', channel_down: 'channelDown', screensaver: 'screensaver',
  guide: 'guide', page_up: 'pageUp', page_down: 'pageDown',
} as const;

/**
 * Send a validated key or Companion button, optionally with an action mode, then close even if
 * sending fails. Only HID keys and Companion buttons accept an action; media keys, wake/suspend,
 * skips and `home_hold` are rejected before connecting.
 */
async function cmdCommand(command: string, action?: InputAction, deviceId?: string, json = false): Promise<Record<string, unknown> | void> {
  const button = Object.hasOwn(COMPANION_BUTTONS, command)
    ? COMPANION_BUTTONS[command as keyof typeof COMPANION_BUTTONS] : undefined;
  if (!button && !COMMAND_SET.has(command)) throw new Error(`Unknown command: ${command}. Run "atv --help".`);
  if (action && !button && !HID_KEY_MAP[command]) throw new Error(`Action modes are not supported for ${command}`);
  const atv = await (button ? connectToCompanion(deviceId) : connectToDevice(deviceId));
  try {
    if (button) await atv[button](action);
    else await atv.sendKeyCommand(command as Key, action);
    if (!json) console.log(`Sent: ${command}`);
    await delay(postSendMs());
    return json ? { acknowledged: false, command, action: action ?? 'singleTap' } : undefined;
  } finally {
    await atv.close();
  }
}

/** `atv remote [device]`: interactive prompt that sends each typed key name. */
async function cmdRemote(deviceId?: string) {
  const atv = await connectToDevice(deviceId);

  console.log(`Connected. Type commands to send (${COMMAND_NAMES.join(', ')})`);
  console.log('Type "quit" or "exit" to disconnect.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('atv> ');
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim().toLowerCase();
    if (!input) { rl.prompt(); return; }
    if (input === 'quit' || input === 'exit') {
      await atv.close();
      rl.close();
      return;
    }
    if (input === 'help') {
      console.log(`Commands: ${COMMAND_NAMES.join(', ')}`);
      rl.prompt();
      return;
    }
    if (!COMMAND_SET.has(input)) {
      console.log(`Unknown: ${input}. Type "help" for commands.`);
    } else {
      try {
        await atv.sendKeyCommand(input as Key);
      } catch (e) {
        console.log(`Error: ${e}`);
      }
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    await atv.close();
    process.exit(0);
  });
}

/** `atv state [device]`: print title, artist, album, play state, progress, and app for the current item. */
async function cmdState(deviceId?: string, json = false): Promise<Record<string, unknown> | void> {
  const atv = await connectToDevice(deviceId);
  try {
    console.error('Requesting state...');
    const info = await atv.getNowPlaying();
    if (json) return playbackData(info);
    const stopped = info.playbackState === PlaybackState.Stopped;
    const idle = !info.hasPlayback && (stopped || info.playbackState === PlaybackState.Unknown);
    console.log(idle ? `Nothing playing. [${stopped ? 'Stopped' : 'Absent'}]` : info.toString());
  } finally {
    await atv.close();
  }
}

/** `atv queue [device]`: print up to 20 items from the playback queue. */
async function cmdQueue(deviceId?: string, json = false): Promise<Record<string, unknown> | void> {
  const atv = await connectToDevice(deviceId);
  try {
    console.error('Requesting playback queue...');
    const response = await atv.requestPlaybackQueue({ location: 0, length: 20, includeMetadata: true });
    const items = contentItems(response);
    if (json) return { items: items.map((item) => {
      const metadata = item.metadata as Record<string, unknown> | undefined;
      return {
        id: typeof item.identifier === 'string' ? item.identifier : null,
        title: typeof metadata?.title === 'string' ? metadata.title : null,
        artist: typeof metadata?.artist === 'string' ? metadata.artist : null,
        album: typeof metadata?.album === 'string' ? metadata.album : null,
      };
    }) };
    if (items.length > 0) {
      items.forEach((item, i) => {
        const metadata = item.metadata as Record<string, unknown> | undefined;
        const title = metadata?.title ?? item.identifier ?? '(unknown)';
        console.log(`  ${i + 1}. ${title}`);
      });
    } else console.log('No items in playback queue.');
  } finally {
    await atv.close();
  }
}

/** `atv artwork [device] [file]`: save 600x600 now-playing artwork (default artwork.jpg). */
async function cmdArtwork(deviceId?: string, outputFile?: string, json = false): Promise<Record<string, unknown> | void> {
  const atv = await connectToDevice(deviceId);
  try {
    console.error('Requesting artwork...');
    const artwork = await atv.requestArtwork(600, 600);
    if (artwork) {
      const filename = outputFile ?? 'artwork.jpg';
      writeFileSync(filename, artwork);
      if (json) return { path: filename, bytes: artwork.length, available: true };
      console.log(`Artwork saved to ${filename} (${artwork.length} bytes)`);
    } else if (json) return { available: false };
    else console.log('No artwork available.');
  } finally {
    await atv.close();
  }
}

/** `atv messages [device]`: print every incoming MRP message until Ctrl+C. */
async function cmdMessages(deviceId?: string) {
  const atv = await connectToDevice(deviceId);
  console.log('Listening for messages (Ctrl+C to stop)...\n');

  atv.on('message', (msg: Message) => {
    console.log(msg.toString());
  });

  process.on('SIGINT', async () => {
    console.log('\nDisconnecting...');
    await atv.close();
    process.exit(0);
  });
}

/** `atv companion-pair`: Companion pair-setup; merges the result into the device's existing AirPlay credentials, or stores it standalone. */
async function cmdCompanionPair() {
  console.log('Scanning for Apple TVs...');
  const device = await selectDevice((await scan({ timeout: 5000 })).filter((d) => d.companionPort),
    'No Apple TVs with companion-link found.', (d) => `${d} [companion:${d.companionPort}]`);
  if (!device) return;

  const atv = new AppleTV(device);
  console.log(`Companion pairing with ${atv.name} on port ${device.companionPort}...`);
  const pairSetup = await atv.startCompanionPairing();

  const pin = await prompt('Enter PIN shown on Apple TV: ');
  const companionCreds = await pairSetup.finish(pin);

  // Add companion data to the device's existing AirPlay credentials.
  const existingJson = readStored(CREDS_FILE)[device.deviceId];
  let creds: Credentials;
  if (existingJson) {
    creds = Credentials.deserialize(existingJson);
    creds.companionCredentials = companionCreds;
  } else {
    console.log('Warning: No AirPlay credentials found. Pair with AirPlay first (atv pair).');
    console.log('Saving companion credentials standalone.');
    creds = new Credentials(companionCreds, companionCreds);
  }
  saveStored(CREDS_FILE, device.deviceId, creds.serialize());
  console.log(`Companion paired! Credentials saved to ${CREDS_FILE}`);
}

/** `atv companion-test [device]`: connect over Companion with stored credentials and print events until Ctrl+C. */
async function cmdCompanionTest(deviceId?: string) {
  const atv = await connectToCompanion(deviceId);
  console.log('Companion connected! Listening for events (Ctrl+C to stop)...\n');

  atv.on('companionEvent', (event: CompanionEvent) => {
    console.log(`Event: ${event.identifier}`);
    const readable = Object.fromEntries(
      [...event.data].map(([k, v]) => [String(k), v]),
    );
    console.log(`  data: ${JSON.stringify(readable)}`);
  });

  atv.on('companionError', (err: Error) => {
    console.error(`Companion error: ${err.message}`);
  });

  atv.on('companionClose', () => {
    console.log('Companion connection closed.');
  });

  process.on('SIGINT', async () => {
    console.log('\nDisconnecting...');
    await atv.close();
    process.exit(0);
  });
}

/** `atv keyboard [device]`: print keyboard focus and text-input events (plus their raw messages) until Ctrl+C. */
async function cmdKeyboard(deviceId?: string) {
  const atv = await connectToDevice(deviceId);
  console.log('Listening for keyboard/textInput events (Ctrl+C to stop)...\n');

  atv.on('keyboard', (info: KeyboardInfo) => {
    const parts = [`Keyboard: focused=${info.focused}`];
    if (info.title) parts.push(`title="${info.title}"`);
    if (info.prompt) parts.push(`prompt="${info.prompt}"`);
    console.log(parts.join(' '));
  });

  atv.on('textInput', (event: TextInputEvent) => {
    const parts = ['TextInput:'];
    if (event.text !== undefined) parts.push(`text="${event.text}"`);
    if (event.actionType !== undefined) parts.push(`action=${event.actionType}`);
    console.log(parts.join(' '));
  });

  atv.on('message', (msg: Message) => {
    // Also log raw keyboard/text messages for debugging
    const type = msg.type;
    if (type === MessageType.Keyboard || type === MessageType.TextInput) {
      console.log(`  raw: ${JSON.stringify(msg.payload)}`);
    }
  });

  process.on('SIGINT', async () => {
    console.log('\nDisconnecting...');
    await atv.close();
    process.exit(0);
  });
}

/** `atv output` verbs mapped to AppleTV routing methods (`list` is handled separately). */
const OUTPUT_METHODS = { add: 'addOutputDevices', remove: 'removeOutputDevices', set: 'setOutputDevices' } as const;

/** DMAP CLI command names mapped to DmapClient methods (`state` is handled separately). */
const DMAP_COMMANDS = {
  up: 'up', down: 'down', left: 'left', right: 'right', select: 'select', menu: 'menu', top_menu: 'topMenu',
  play: 'play', pause: 'pause', stop: 'stop', play_pause: 'playPause', next: 'next', previous: 'previous',
  volume_up: 'volumeUp', volume_down: 'volumeDown',
} as const;

/**
 * `atv dmap-pair <local-ipv4>`: advertise this computer as a Remote on the given local IPv4 interface,
 * show a random PIN to enter on the selected legacy Apple TV, and store the resulting pairing GUID
 * under the selected device's ID. Fails on lockout or expiry; Ctrl+C cancels and closes the server.
 */
async function cmdDmapPair(localAddress: string) {
  console.log('Scanning for legacy (DMAP) Apple TVs...');
  const device = await selectDevice((await scan({ timeout: 5000 })).filter((d) => d.dmapPort),
    'No DMAP devices found.', (d) => `${d.name} (${d.dmapAddress ?? d.address}:${d.dmapPort}) [${d.deviceId}]`);
  if (!device) return;

  const pin = String(randomInt(10000)).padStart(4, '0');
  const pairing = new DmapPairing({ name: 'atv CLI', address: localAddress, pin });
  // Ctrl+C must still close the callback server and unpublish the _touch-remote advertisement.
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error('DMAP pairing cancelled'));
  process.once('SIGINT', cancel);
  let guid: string;
  try {
    await pairing.start();
    console.log(`On ${device.name}, open Settings > General > Remotes, choose "atv CLI" and enter PIN ${pin}.`);
    // DmapPairing has no completion event; poll until it pairs, locks out after five wrong PINs, or expires.
    for (;;) {
      try { guid = pairing.finish(); break; } catch (error) {
        if (!(error instanceof Error) || error.message !== 'DMAP remote is not paired') throw error;
      }
      try { await delay(500, undefined, { signal: cancellation.signal }); } catch { cancellation.signal.throwIfAborted(); }
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    await pairing.close();
  }

  saveStored(DMAP_FILE, device.deviceId, guid);
  console.log(`Paired! Pairing GUID saved to ${DMAP_FILE}`);
}

/** `atv dmap <command|state> [device]`: log in with the stored GUID, run one DMAP request, then close. */
async function cmdDmap(command: keyof typeof DMAP_COMMANDS | 'state', deviceId?: string) {
  const { id, value: guid } = loadStored(DMAP_FILE, 'dmap-pair', deviceId);
  const client = await connectCached(id, 'dmap', async (device) => {
    console.error(`Connecting DMAP to ${device.name} (${device.dmapAddress ?? device.address}:${device.dmapPort})...`);
    const dmap = new DmapClient(device);
    await dmap.connect(guid); // closes itself if login fails
    return dmap;
  });
  try {
    // Every DMAP request is an HTTP round trip, so no post-send wait is needed.
    if (command === 'state') console.log((await client.getState()).toString());
    else {
      await client[DMAP_COMMANDS[command]]();
      console.log(`Sent: ${command}`);
    }
  } finally {
    client.close();
  }
}

/** Browse `_raop._tcp` for up to 5 s and return the port and normalized TXT of the service at `address`. */
function findRaopService(address: string): Promise<{ port: number; txt: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const bonjour = new Bonjour();
    let found: Service | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      browser.stop();
      bonjour.destroy();
      if (found) resolve({ port: found.port, txt: normalizeTxt(found.txt) });
      else reject(new Error(`No _raop._tcp service found at ${address}`));
    };
    // Stop on the next tick so a callback fired during find() never touches an unassigned browser.
    const browser = bonjour.find({ type: 'raop', protocol: 'tcp' }, (service: Service) => {
      if (!found && service.port && service.addresses?.includes(address)) { found = service; setImmediate(finish); }
    });
    const timer = setTimeout(finish, 5000);
  });
}

/**
 * `atv raop-stream <ipv4> <file.pcm>` (experimental): stream raw PCM16LE stereo 44.1 kHz to a legacy
 * RAOP receiver via RaopStream. Ctrl+C cancels and tears the session down.
 */
async function cmdRaopStream(address: string, file: string) {
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);
  console.error(`Resolving _raop._tcp at ${address}...`);
  const { port, txt } = await findRaopService(address);
  const sender = new RaopStream(address, port, txt);
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error('RAOP aborted'));
  process.once('SIGINT', cancel);
  try {
    console.error(`Streaming ${file} to ${address}:${port} (Ctrl+C to stop)...`);
    await sender.stream(createReadStream(file, { highWaterMark: 65536 }), { signal: cancellation.signal });
    console.log('Stream complete.');
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}

/** Print the CLI syntax; no discovery or credential loading occurs. */
function help(): void {
  console.log(`Usage:
  atv scan | pair | companion-pair
  atv command <key> [action] [device]  Send an MRP key or Companion button (alias: cmd);
                                       action: singleTap (default), doubleTap, hold
                                       (case-insensitive)
  atv stop [device]
  atv seek <seconds> [device]          Absolute position, >= 0
  atv skip-forward <seconds> [device]  Positive interval
  atv skip-backward <seconds> [device] Positive interval
  atv shuffle <off|albums|songs> [device]
  atv repeat <off|track|all> [device]
  atv volume <0..100> [device]
  atv text <set|append> <text> [device] Quote text, including "" for empty text
  atv text clear [device]
  atv text focus [device]              Print focused, unfocused, or unknown
  atv app list [device]
  atv app launch <bundle-id-or-url> [device]
  atv account list [device]
  atv account switch <account-id> [device]
  atv power [device]                   Print on, off, or unknown
  atv click [action] [device]          Companion touch click; action as for command
  atv swipe <x1> <y1> <x2> <y2> <ms> [device]
                                       Companion swipe; integer coordinates 0..1000, 1..60000 ms
  atv output list [device]             Selected outputs (tab-separated ID and name)
  atv output <add|remove|set> <id[,id...]> [device]
                                       ID = the receiver's AirPlay "psi" UUID, shown by "atv scan";
                                       its deviceid (MAC) or pi will time out
  atv dmap-pair <local-ipv4>           Pair a legacy (DMAP) Apple TV; address is THIS computer's
  atv dmap <command|state> [device]    Legacy DMAP control: ${Object.keys(DMAP_COMMANDS).join(', ')}
  atv raop-stream <ipv4> <file.pcm>    Experimental: stream raw PCM16LE stereo 44.1 kHz to a legacy
                                       RAOP receiver (no WAV header, no PIN/HAP receivers)
  atv --json <command> ...          Emit versioned JSON Lines (supports watch [device])
  atv watch [device]                Stream normalized state until interrupted
  atv remote | state | queue | messages | keyboard | companion-test [device]
  atv artwork [device] [output.jpg]
  atv help | --help | -h

MRP keys: ${COMMAND_NAMES.join(', ')}
Companion buttons: ${Object.keys(COMPANION_BUTTONS).join(', ')}`);
}

/** Enforce required arguments and a single optional device before any I/O. */
function argumentsFor(args: string[], required: number, usage: string): void {
  if (args.length < required || args.length > required + 1 ||
      args.some((arg) => !arg.trim())) {
    throw new Error(`Usage: atv ${usage}`);
  }
}

/** Parse a complete finite decimal, rejecting partial numbers and out-of-range values. */
function numberArgument(value: string, min: number, max = Infinity, positive = false): number {
  const number = Number(value);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(number) ||
      number < min || number > max || (positive && number === 0)) {
    throw new Error(`Invalid numeric argument: ${value}`);
  }
  return number;
}

const JSON_VERSION = 1;

type JsonRecord = {
  version: typeof JSON_VERSION;
  type: 'result' | 'event' | 'error';
  command: string;
  timestamp: string;
  deviceId?: string;
  data: Record<string, unknown>;
};

/**
 * Writes complete JSON lines without changing console. State updates may replace an older queued
 * update of the same kind; terminal records are never coalesced or discarded.
 */
class JsonLineWriter {
  private queue: { record: JsonRecord; key?: string }[] = [];
  private writing = false;
  private closed = false;
  private readonly limit = 128;

  write(record: JsonRecord, key?: string): void {
    if (this.closed) return;
    if (key) {
      const existing = this.queue.find((entry) => entry.key === key);
      if (existing) { existing.record = record; return; }
    }
    if (this.queue.length >= this.limit && key) return;
    this.queue.push({ record, key });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.queue.length && !this.closed) {
        const { record } = this.queue.shift()!;
        try {
          if (!process.stdout.write(`${JSON.stringify(record)}\n`)) {
            await new Promise<void>((resolve, reject) => {
              const complete = () => {
                process.stdout.removeListener('error', failed);
                resolve();
              };
              const failed = (error: Error) => {
                process.stdout.removeListener('drain', complete);
                reject(error);
              };
              process.stdout.once('drain', complete);
              process.stdout.once('error', failed);
            });
          }
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'EPIPE') this.closed = true;
          else throw error;
        }
      }
    } finally {
      this.writing = false;
    }
  }

  async finish(): Promise<void> {
    await this.drain();
  }

  close(): void { this.closed = true; this.queue = []; }
}

function jsonRecord(type: JsonRecord['type'], command: string, data: Record<string, unknown>, deviceId?: string): JsonRecord {
  return { version: JSON_VERSION, type, command, timestamp: new Date().toISOString(), ...(deviceId ? { deviceId } : {}), data };
}

function playbackData(info: NowPlayingInfo): Record<string, unknown> {
  const states: Record<number, string> = {
    [PlaybackState.Unknown]: 'unknown', [PlaybackState.Playing]: 'playing',
    [PlaybackState.Paused]: 'paused', [PlaybackState.Stopped]: 'stopped',
    [PlaybackState.Interrupted]: 'interrupted', [PlaybackState.Seeking]: 'seeking',
  };
  return {
    hasPlayback: info.hasPlayback, playerIdentifier: info.playerIdentifier || null,
    title: info.title || null, artist: info.artist || null, album: info.album || null,
    genre: info.genre || null, duration: info.duration, elapsedTime: info.elapsedTime,
    playbackRate: info.playbackRate, playbackState: states[info.playbackState] ?? 'unknown',
    appDisplayName: info.appDisplayName || null, appBundleIdentifier: info.appBundleIdentifier || null,
  };
}

function jsonError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const protocol = error && typeof error === 'object' && 'errorCode' in error
    ? error.errorCode : error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  let code = 'operation_failed';
  if (/Unsupported in JSON mode/i.test(message)) code = 'unsupported';
  else if (/Usage:|Unknown command|Invalid |must be |nonblank|unsupported/i.test(message)) code = 'invalid_arguments';
  else if (/credentials|paired device|companion credentials/i.test(message)) code = 'credentials_unavailable';
  else if (/No text field is focused|not focused/i.test(message)) code = 'text_unfocused';
  return { code, message, ...(typeof protocol === 'number' ? { protocolCode: protocol } : {}) };
}

async function cmdJsonWatch(deviceId: string | undefined, writer: JsonLineWriter): Promise<void> {
  const { id, credentials } = loadCredentials(deviceId);
  // A watch is one session: discovery is intentionally not retried after it begins emitting.
  const device = await findDevice(id, 'mrp');
  const atv = new AppleTV(device);
  let terminal = false;
  let observedPlayback = false;
  let complete: (() => void) | undefined;
  const emit = (name: string, data: Record<string, unknown>, key?: string) => {
    if (!terminal) writer.write(jsonRecord('event', name, data, id), key);
  };
  const finish = async (name: string, data: Record<string, unknown>, exitCode = 0) => {
    if (terminal) return;
    terminal = true;
    writer.write(jsonRecord('event', name, data, id));
    complete?.();
    await atv.close();
    process.exitCode = exitCode;
  };
  const onSignal = () => { void finish('watch-close', { reason: 'signal' }, 130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  atv.on('nowPlaying', (info) => { observedPlayback = true; emit('playback', playbackData(info), 'playback'); });
  atv.on('volume', (volume) => emit('volume', { value: volume }, 'volume'));
  atv.on('outputDevices', (outputs: { identifier: string; name: string }[]) => emit('output-devices', { devices: outputs.map((d) => ({ id: d.identifier, name: d.name })) }, 'outputs'));
  atv.on('keyboard', (info: KeyboardInfo) => emit('text-focus', { state: info.focused ? 'focused' : 'unfocused', title: info.title ?? null, prompt: info.prompt ?? null }, 'focus'));
  atv.on('close', () => { if (!terminal) void finish('connection-close', { intentional: false, transport: 'mrp' }, 1); });
  atv.on('error', (error: Error) => { if (!terminal) emit('connection-error', jsonError(error)); });
  try {
    await atv.connect(credentials, { settleMs: settleMs() });
    emit('connection', { transport: 'mrp', state: 'connected' });
    if (observedPlayback) emit('playback', playbackData(atv.nowPlaying), 'playback');
    else emit('playback', { state: 'unknown' }, 'playback');
    emit('volume', { value: atv.volume ?? null, state: atv.volume === undefined ? 'unknown' : 'known' }, 'volume');
    emit('output-devices', { devices: atv.outputDevices.map((d) => ({ id: d.identifier, name: d.name })) }, 'outputs');
    if (credentials.companionCredentials && device.companionPort) {
      atv.on('powerState', (state) => emit('power', { state }, 'power'));
      atv.on('textFocusState', (state) => emit('text-focus', { state }, 'focus'));
      atv.on('companionError', (error: Error) => { if (!terminal) emit('connection-error', jsonError(error)); });
      atv.on('companionClose', () => { if (!terminal) void finish('connection-close', { intentional: false, transport: 'companion' }, 1); });
      await atv.connectCompanion(credentials.companionCredentials);
      atv.subscribePowerState();
      emit('connection', { transport: 'companion', state: 'connected' });
      emit('power', { state: atv.powerState }, 'power');
      emit('text-focus', { state: atv.textFocusState }, 'focus');
    } else emit('source', { source: 'companion', state: 'unavailable' });
    await new Promise<void>((resolve) => { complete = resolve; });
  } catch (error) {
    // The outer JSON command writer owns the single setup failure record.
    terminal = true;
    throw error;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await atv.close();
  }
}

async function mainJson(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const writer = new JsonLineWriter();
  if (!command || ['help', '--help', '-h'].includes(command)) {
    writer.write(jsonRecord('result', 'help', { schemaVersion: JSON_VERSION }));
    await writer.finish();
    return;
  }
  if (['pair', 'companion-pair', 'dmap-pair', 'dmap', 'remote', 'messages', 'keyboard', 'companion-test', 'raop-stream'].includes(command)) {
    throw new Error(`Unsupported in JSON mode: ${command}`);
  }
  if (command === 'watch') {
    argumentsFor(args, 0, 'watch [device]');
    await cmdJsonWatch(args[0], writer);
    await writer.finish();
    return;
  }
  if (command === 'scan') {
    argumentsFor(args, 0, 'scan');
    const devices = await scan({ timeout: 5000 });
    writer.write(jsonRecord('result', 'scan', { devices: devices.map((d) => ({
      id: d.deviceId, name: d.name, address: d.address, port: d.port, model: d.model, psi: d.airplayPsi ?? null,
    })) }));
    await writer.finish();
    return;
  }
  // Reuse the normal dispatcher operations, but route their concrete return values through the writer.
  const result = await main(argv, true);
  if (!result) throw new Error('JSON command produced no result');
  writer.write(jsonRecord('result', command, result.data, result.deviceId));
  await writer.finish();
}

/** Validate and dispatch CLI arguments. Errors propagate to the executable's exit handler. */
export async function main(argv: string[], jsonInternal = false): Promise<{ data: Record<string, unknown>; deviceId?: string } | void> {
  if (!jsonInternal) {
    const jsonIndexes = argv.reduce<number[]>((indexes, value, index) => value === '--json' ? [...indexes, index] : indexes, []);
    if (jsonIndexes.length > 1) {
      const writer = new JsonLineWriter();
      writer.write(jsonRecord('error', argv.find((value) => value !== '--json') ?? 'unknown', {
        code: 'invalid_arguments', message: '--json may be specified once',
      }));
      await writer.finish();
      process.exitCode = 1;
      return;
    }
    if (jsonIndexes.length === 1) {
      const jsonArgv = argv.filter((_, index) => index !== jsonIndexes[0]);
      try {
        await mainJson(jsonArgv);
      } catch (error) {
        const writer = new JsonLineWriter();
        writer.write(jsonRecord('error', jsonArgv[0] ?? 'unknown', jsonError(error)));
        await writer.finish();
        process.exitCode = 1;
      }
      return;
    }
  }
  const [cmd, ...args] = argv;
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) { help(); return; }
  let companion = false;
  // Queries get a reply; every other operation ends with an unacknowledged send (HID key, `_tiC`, ...).
  let acknowledged = false;
  let device: string | undefined;
  let operation: (atv: AppleTV) => Promise<void | string | App[] | UserAccount[]>;
  switch (cmd) {
    case 'command': case 'cmd': {
      const { action, rest } = splitAction(args, 1);
      argumentsFor(rest, 1, 'command <key> [action] [device]');
      const result = await cmdCommand(rest[0], action, rest[1], jsonInternal);
      return jsonInternal ? { data: result ?? { acknowledged: false }, deviceId: rest[1] } : undefined;
    }
    case 'click': {
      const { action, rest } = splitAction(args, 0);
      argumentsFor(rest, 0, 'click [action] [device]');
      device = rest[0]; companion = true;
      operation = (atv) => atv.click(action);
      break;
    }
    case 'swipe': {
      argumentsFor(args, 5, 'swipe <x1> <y1> <x2> <y2> <ms> [device]');
      const [x1, y1, x2, y2, ms] = args.slice(0, 5).map((value, i) => {
        const number = numberArgument(value, i < 4 ? 0 : 1, i < 4 ? 1000 : 60000);
        if (!Number.isInteger(number)) throw new Error(`Invalid numeric argument: ${value}`);
        return number;
      });
      device = args[5]; companion = true;
      operation = (atv) => atv.swipe(x1, y1, x2, y2, ms);
      break;
    }
    case 'output': {
      const [action, ...values] = args;
      // Routing resolves only once the TV reports the new group, so no post-send wait is needed.
      acknowledged = true;
      // Rows reuse the printer's `id\tname` format.
      const rows = (atv: AppleTV) => atv.outputDevices.map((d) => ({ id: d.identifier, name: d.name }));
      if (action === 'list') {
        argumentsFor(values, 0, 'output list [device]');
        device = values[0];
        operation = async (atv) => rows(atv);
      } else if (Object.hasOwn(OUTPUT_METHODS, action ?? '')) {
        const usage = `output ${action} <id[,id...]> [device]`;
        argumentsFor(values, 1, usage);
        const ids = values[0].split(',').map((id) => id.trim());
        if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
          throw new Error(`Usage: atv ${usage} (IDs must be unique and nonblank)`);
        }
        device = values[1];
        const method = OUTPUT_METHODS[action as keyof typeof OUTPUT_METHODS];
        operation = async (atv) => { await atv[method](ids); return rows(atv); };
      } else throw new Error(`Invalid output operation: ${action ?? '(missing)'}`);
      break;
    }
    case 'dmap': {
      argumentsFor(args, 1, 'dmap <command|state> [device]');
      if (args[0] !== 'state' && !Object.hasOwn(DMAP_COMMANDS, args[0])) throw new Error(`Unknown DMAP command: ${args[0]}`);
      return cmdDmap(args[0] as keyof typeof DMAP_COMMANDS | 'state', args[1]);
    }
    case 'dmap-pair':
      if (args.length !== 1 || !isIPv4(args[0])) throw new Error('Usage: atv dmap-pair <local-ipv4>');
      return cmdDmapPair(args[0]);
    case 'raop-stream':
      if (args.length !== 2 || !isIPv4(args[0]) || !args[1].trim()) throw new Error('Usage: atv raop-stream <ipv4> <file.pcm>');
      return cmdRaopStream(args[0], args[1]);
    case 'stop': case 'power':
      argumentsFor(args, 0, `${cmd} [device]`);
      device = args[0]; companion = cmd === 'power';
      acknowledged = true;
      operation = cmd === 'stop' ? (atv) => atv.stop() : (atv) => atv.fetchPowerState();
      break;
    case 'seek': case 'skip-forward': case 'skip-backward': case 'volume': {
      argumentsFor(args, 1, `${cmd} <number> [device]`);
      const value = numberArgument(args[0], 0, cmd === 'volume' ? 100 : Infinity, cmd.startsWith('skip-'));
      device = args[1];
      acknowledged = cmd !== 'volume';
      operation = (atv) => cmd === 'seek' ? atv.setPosition(value) : cmd === 'volume' ? atv.setVolume(value) :
        cmd === 'skip-forward' ? atv.skipForward(value) : atv.skipBackward(value);
      break;
    }
    case 'shuffle': case 'repeat': {
      argumentsFor(args, 1, `${cmd} <mode> [device]`);
      const shuffle: Record<string, ShuffleState> = { off: ShuffleState.Off, albums: ShuffleState.Albums, songs: ShuffleState.Songs };
      const repeat: Record<string, RepeatState> = { off: RepeatState.Off, track: RepeatState.Track, all: RepeatState.All };
      if (!Object.hasOwn(cmd === 'shuffle' ? shuffle : repeat, args[0])) throw new Error(`Invalid ${cmd} mode: ${args[0]}`);
      device = args[1];
      acknowledged = true;
      operation = (atv) => cmd === 'shuffle' ? atv.setShuffle(shuffle[args[0]]) : atv.setRepeat(repeat[args[0]]);
      break;
    }
    case 'text': {
      const [action, ...values] = args;
      companion = true; // modern tvOS ignores the MRP TextInputMessage; text uses Companion RTI
      if (action === 'clear') {
        argumentsFor(values, 0, 'text clear [device]');
        device = values[0]; operation = (atv) => atv.clearText();
      } else if (action === 'focus') {
        argumentsFor(values, 0, 'text focus [device]');
        device = values[0]; acknowledged = true;
        operation = (atv) => atv.fetchTextFocusState();
      } else if (action === 'set' || action === 'append') {
        // Empty text is valid; unlike identifiers it must not be trimmed or rejected.
        if (values.length < 1 || values.length > 2 || (values[1] !== undefined && !values[1].trim())) throw new Error(`Usage: atv text ${action} <text> [device]`);
        device = values[1];
        operation = (atv) => action === 'set' ? atv.setText(values[0]) : atv.insertText(values[0]);
      } else throw new Error('Usage: atv text <set|append|clear|focus> ...');
      break;
    }
    case 'app': case 'account': {
      const [action, ...values] = args;
      companion = true;
      if (action === 'list') {
        argumentsFor(values, 0, `${cmd} list [device]`);
        device = values[0]; acknowledged = true;
        operation = (atv) => cmd === 'app' ? atv.appList() : atv.accountList();
      } else if (action === (cmd === 'app' ? 'launch' : 'switch')) {
        argumentsFor(values, 1, `${cmd} ${action} <id> [device]`);
        device = values[1];
        operation = (atv) => cmd === 'app' ? atv.launchApp(values[0]) : atv.switchAccount(values[0]);
      } else throw new Error(`Invalid ${cmd} operation: ${action ?? '(missing)'}`);
      break;
    }
    case 'scan': case 'pair': case 'companion-pair':
      if (args.length) throw new Error(`Usage: atv ${cmd}`);
      if (jsonInternal) throw new Error(`Unsupported in JSON mode: ${cmd}`);
      return cmd === 'scan' ? cmdScan() : cmd === 'pair' ? cmdPair() : cmdCompanionPair();
    case 'remote': case 'state': case 'queue': case 'messages': case 'keyboard': case 'companion-test':
      argumentsFor(args, 0, `${cmd} [device]`);
      if (cmd === 'state') {
        const result = await cmdState(args[0], jsonInternal);
        return jsonInternal ? { data: result ?? {}, deviceId: args[0] } : undefined;
      }
      if (cmd === 'queue') {
        const result = await cmdQueue(args[0], jsonInternal);
        return jsonInternal ? { data: result ?? {}, deviceId: args[0] } : undefined;
      }
      if (jsonInternal) throw new Error(`Unsupported in JSON mode: ${cmd}`);
      switch (cmd) {
        case 'remote': return cmdRemote(args[0]);
        case 'messages': return cmdMessages(args[0]);
        case 'keyboard': return cmdKeyboard(args[0]);
        case 'companion-test': return cmdCompanionTest(args[0]);
      }
      return;
    case 'artwork':
      if (args.length > 2) throw new Error('Usage: atv artwork [device] [output.jpg]');
      {
        const result = await cmdArtwork(args[0], args[1], jsonInternal);
        return jsonInternal ? { data: result ?? {}, deviceId: args[0] } : undefined;
      }
    default: throw new Error(`Unknown command: ${cmd}. Run "atv --help".`);
  }
  const atv = await (companion ? connectToCompanion(device) : connectToDevice(device));
  try {
    const result = await operation(atv);
    // Give unacknowledged sends time to reach the TV before close() destroys the socket.
    if (!acknowledged) await delay(postSendMs());
    if (jsonInternal) {
      const data = Array.isArray(result)
        ? { items: result.map((item) => 'bundleId' in item ? { id: item.bundleId, name: item.name } : { id: item.id, name: item.name }), acknowledged }
        : result === undefined ? { acknowledged } : { value: result, acknowledged };
      return { data, deviceId: device };
    }
    if (Array.isArray(result)) {
      for (const item of result) console.log(`${'bundleId' in item ? item.bundleId : item.id}\t${item.name}`);
    } else if (result !== undefined) console.log(result);
  } finally {
    await atv.close();
  }
}

// Importing the CLI for tests does not execute commands or touch stored credentials.
// realpathSync resolves npm bin symlinks; an unresolvable argv[1] just means "not the script".
let isScript = false;
try { isScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* not the script */ }
if (isScript) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
