import dgram from 'node:dgram';
import { isIP } from 'node:net';

export const SERVICE_TYPES = ['airplay', 'raop', 'companion-link', 'mediaremotetv', 'touch-able', 'appletv-v2'] as const;

const SERVICE_NAMES: Record<typeof SERVICE_TYPES[number], string> = {
  airplay: '_airplay._tcp.local',
  raop: '_raop._tcp.local',
  'companion-link': '_companion-link._tcp.local',
  mediaremotetv: '_mediaremotetv._tcp.local',
  'touch-able': '_touch-able._tcp.local',
  'appletv-v2': '_appletv-v2._tcp.local',
};

export interface TargetedService {
  type: typeof SERVICE_TYPES[number];
  name: string;
  host: string;
  port: number;
  addresses: string[];
  txt: Record<string, string>;
  fqdn: string;
}

type Target = { address: string; family: 4 | 6; scope?: string };
type Resource = { name: string; type: number; data: string | { host: string; port: number } | Record<string, string> };
type SocketState = { socket: dgram.Socket; family: 4 | 6; targets: Target[]; sent: Set<string> };

/** Validate literal mDNS targets before any socket is opened. */
export function parseTargets(hosts: readonly string[]): Target[] {
  return hosts.map((host) => {
    if (!host || !host.trim() || host !== host.trim()) throw new Error(`Invalid discovery host: ${host}`);
    const [address, ...scopeParts] = host.split('%');
    const scope = scopeParts.length ? scopeParts.join('%') : undefined;
    const family = isIP(address);
    if ((family !== 4 && family !== 6) || (family === 4 && scope) || (scopeParts.length > 1 || (scopeParts.length && !scope))) {
      throw new Error(`Invalid discovery host: ${host}`);
    }
    if (family === 6 && /^fe[89ab]/i.test(address) && !scope) {
      throw new Error(`IPv6 link-local discovery host requires a scope: ${host}`);
    }
    return { address: host, family: family as 4 | 6, scope };
  });
}

const writeName = (name: string): Buffer => {
  const labels = name.replace(/\.$/, '').split('.');
  if (!labels.length || labels.some(label => !label || Buffer.byteLength(label) > 63)) throw new Error(`Invalid DNS name: ${name}`);
  return Buffer.concat([...labels.map(label => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])), Buffer.from([0])]);
};

const query = (name: string, type: number): Buffer => {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // one question, mDNS transaction ID is always zero
  return Buffer.concat([header, writeName(name), Buffer.from([type >> 8, type & 0xff, 0x80, 1])]); // QU | IN
};

function readName(packet: Buffer, offset: number, seen = new Set<number>()): [string, number] | undefined {
  const labels: string[] = [];
  let next = offset;
  let jumped = false;
  while (offset < packet.length) {
    const length = packet[offset++];
    if ((length & 0xc0) === 0xc0) {
      if (offset >= packet.length) return;
      const pointer = ((length & 0x3f) << 8) | packet[offset++];
      if (pointer >= packet.length || seen.has(pointer)) return;
      seen.add(pointer);
      const pointed = readName(packet, pointer, seen);
      if (!pointed) return;
      labels.push(pointed[0]);
      if (!jumped) next = offset;
      jumped = true;
      break;
    }
    if (length & 0xc0 || length > 63 || offset + length > packet.length) return;
    if (length === 0) { if (!jumped) next = offset; break; }
    labels.push(packet.subarray(offset, offset + length).toString('utf8'));
    offset += length;
  }
  return [labels.join('.').toLowerCase(), next];
}

export function parsePacket(packet: Buffer): Resource[] {
  if (packet.length < 12) return [];
  const questions = packet.readUInt16BE(4);
  const count = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
  if (questions > 64 || count > 512) return [];
  let offset = 12;
  for (let index = 0; index < questions; index++) {
    const name = readName(packet, offset);
    if (!name || name[1] + 4 > packet.length) return [];
    offset = name[1] + 4;
  }
  const records: Resource[] = [];
  for (let index = 0; index < count; index++) {
    const name = readName(packet, offset);
    if (!name || name[1] + 10 > packet.length) return [];
    const type = packet.readUInt16BE(name[1]);
    const length = packet.readUInt16BE(name[1] + 8);
    const start = name[1] + 10;
    const end = start + length;
    if (end > packet.length) return [];
    let data: Resource['data'] | undefined;
    if (type === 12) {
      const value = readName(packet, start);
      if (value && value[1] <= end) data = value[0];
    } else if (type === 33 && length >= 6) {
      const host = readName(packet, start + 6);
      if (host && host[1] <= end) data = { port: packet.readUInt16BE(start + 4), host: host[0] };
    } else if (type === 1 && length === 4) data = Array.from(packet.subarray(start, end)).join('.');
    else if (type === 28 && length === 16) {
      const parts: string[] = [];
      for (let part = start; part < end; part += 2) parts.push(packet.readUInt16BE(part).toString(16));
      data = parts.join(':');
    } else if (type === 16) {
      const txt: Record<string, string> = {};
      let cursor = start;
      let valid = true;
      while (cursor < end) {
        const size = packet[cursor++];
        if (cursor + size > end) { valid = false; break; }
        const entry = packet.subarray(cursor, cursor + size).toString('utf8');
        const equals = entry.indexOf('=');
        const key = (equals < 0 ? entry : entry.slice(0, equals)).toLowerCase();
        if (key) txt[key] = equals < 0 ? '' : entry.slice(equals + 1);
        cursor += size;
      }
      if (valid) data = txt;
    }
    if (data !== undefined) records.push({ name: name[0], type, data });
    offset = end;
  }
  return records;
}

function isSrv(data: Resource['data']): data is { host: string; port: number } {
  return typeof data === 'object' && 'host' in data && typeof data.host === 'string' &&
    'port' in data && typeof data.port === 'number';
}

/** Low-level targeted mDNS/DNS-SD query path; it deliberately does not use Bonjour internals. */
export class TargetedMdns {
  private readonly ptrs = new Map<string, Set<string>>();
  private readonly srvs = new Map<string, { host: string; port: number }>();
  private readonly txts = new Map<string, Record<string, string>>();
  private readonly addresses = new Map<string, Set<string>>();
  private readonly states: SocketState[] = [];
  private readonly emitted = new Set<string>();
  private retry: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private readonly targets: Target[],
    private readonly found: (service: TargetedService) => void,
    private readonly fail: (error: Error) => void,
    private readonly port = 5353,
    private readonly bindPort = 0,
  ) {}

  async start(): Promise<void> {
    const families: (4 | 6)[] = this.targets.some(target => target.family === 4) && this.targets.some(target => target.family === 6) ? [4, 6] :
      [this.targets[0].family];
    await Promise.all(families.map(family => this.open(family)));
    this.sendQuestions();
    this.retry = setInterval(() => this.sendQuestions(), 750);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.retry);
    for (const { socket } of this.states) socket.close();
  }

  private open(family: 4 | 6): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: family === 4 ? 'udp4' : 'udp6', reuseAddr: true });
      const state: SocketState = { socket, family, targets: this.targets.filter(target => target.family === family), sent: new Set() };
      this.states.push(state);
      const fail = (error: Error) => { if (!this.closed) { this.close(); reject(error); } };
      socket.once('error', fail);
      socket.on('message', (packet, rinfo) => this.receive(packet, state, rinfo.address));
      socket.bind(this.bindPort, () => { socket.off('error', fail); socket.on('error', error => this.fail(error)); resolve(); });
    });
  }

  private sendQuestions(): void {
    if (this.closed) return;
    for (const state of this.states) {
      state.sent.clear();
      for (const target of state.targets) for (const type of SERVICE_TYPES) {
        const packet = query(SERVICE_NAMES[type], 12);
        state.socket.send(packet, this.port, target.address, error => { if (error && !this.closed) this.fail(error); });
      }
      for (const instances of this.ptrs.values()) for (const instance of instances) {
        this.ask(state, instance, 33); this.ask(state, instance, 16);
      }
      for (const srv of this.srvs.values()) {
        this.ask(state, srv.host, 1); this.ask(state, srv.host, 28);
      }
    }
  }

  private ask(state: SocketState, name: string, type: number): void {
    const key = `${name}/${type}`;
    if (state.sent.has(key) || this.closed) return;
    state.sent.add(key);
    const packet = query(name, type);
    for (const target of state.targets) state.socket.send(packet, this.port, target.address, error => { if (error && !this.closed) this.fail(error); });
  }

  private receive(packet: Buffer, state: SocketState, source: string): void {
    for (const record of parsePacket(packet)) {
      if (record.type === 12 && typeof record.data === 'string' && Object.values(SERVICE_NAMES).includes(record.name)) {
        (this.ptrs.get(record.name) ?? this.ptrs.set(record.name, new Set()).get(record.name)!).add(record.data);
        this.ask(state, record.data, 33); this.ask(state, record.data, 16);
      } else if (record.type === 33 && isSrv(record.data)) {
        this.srvs.set(record.name, record.data); this.ask(state, record.data.host, 1); this.ask(state, record.data.host, 28);
      } else if (record.type === 16 && typeof record.data === 'object' && !('host' in record.data)) this.txts.set(record.name, record.data);
      else if ((record.type === 1 || record.type === 28) && typeof record.data === 'string') {
        const scoped = record.type === 28 && /^fe[89ab]/i.test(record.data) ?
          `${record.data}%${state.targets.find(target => target.address.split('%')[0] === source)?.scope ?? ''}`.replace(/%$/, '') : record.data;
        (this.addresses.get(record.name) ?? this.addresses.set(record.name, new Set()).get(record.name)!).add(scoped);
      }
    }
    this.emit();
  }

  private emit(): void {
    for (const type of SERVICE_TYPES) for (const instance of this.ptrs.get(SERVICE_NAMES[type]) ?? []) {
      const srv = this.srvs.get(instance);
      const addresses = srv ? [...(this.addresses.get(srv.host) ?? [])] : [];
      if (!srv || !this.txts.has(instance) || !addresses.length) continue;
      const service = { type, name: instance.replace(new RegExp(`\\.${SERVICE_NAMES[type]}$`), ''), host: srv.host, port: srv.port, addresses, txt: this.txts.get(instance)!, fqdn: instance };
      const key = JSON.stringify(service);
      if (this.emitted.has(key)) continue;
      this.emitted.add(key);
      this.found(service);
    }
  }
}
