import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePacket, parseTargets, TargetedMdns, type TargetedService } from '../targeted-mdns.js';

const sockets: dgram.Socket[] = [];
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); });

const name = (value: string) => Buffer.concat([...value.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
const rr = (owner: string, type: number, data: Buffer) => {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0); header.writeUInt16BE(1, 2); header.writeUInt32BE(120, 4); header.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(owner), header, data]);
};
const packet = (...records: Buffer[]) => {
  const header = Buffer.alloc(12); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...records]);
};

async function bind(address: string) {
  const socket = dgram.createSocket('udp4');
  sockets.push(socket);
  const port = await new Promise<number>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, address, () => {
      const binding = socket.address();
      if (typeof binding === 'string') { reject(new Error('Expected a UDP address')); return; }
      resolve(binding.port);
    });
  });
  return { socket, port };
}

describe('targeted mDNS', () => {
  it('validates literals and requires a link-local IPv6 scope', () => {
    expect(parseTargets(['192.0.2.7', '2001:db8::7%en0'])).toEqual([
      { address: '192.0.2.7', family: 4, scope: undefined, canonical: '192.0.2.7' },
      { address: '2001:db8::7%en0', family: 6, scope: 'en0', canonical: '2001:db8::7' },
    ]);
    expect(() => parseTargets(['', 'host.example', 'fe80::1'])).toThrow('Invalid discovery host: ');
    expect(() => parseTargets(['fe80::1'])).toThrow('requires a scope');
  });

  it('decodes complete DNS answer sections', () => {
    const instance = 'living-room._airplay._tcp.local';
    const host = 'living-room.local';
    expect(parsePacket(packet(
      rr('_airplay._tcp.local', 12, name(instance)),
      rr(instance, 33, Buffer.concat([Buffer.from([0, 0, 0, 0x00, 0x1b, 0x58]), name(host)])),
      rr(instance, 16, Buffer.concat([Buffer.from([17]), Buffer.from('deviceid=11:22:33')])),
      rr(host, 1, Buffer.from([192, 0, 2, 44])),
    ))).toHaveLength(4);
  });

  it('follows PTR records to assemble SRV, TXT and A answers while suppressing duplicates', async () => {
    const { socket: responder, port } = await bind('127.0.0.1');
    const instance = 'living-room._airplay._tcp.local';
    const host = 'living-room.local';
    let requestResolve!: () => void;
    const request = new Promise<void>(resolve => { requestResolve = resolve; });
    responder.on('message', (requestPacket, rinfo) => {
      const response = requestPacket.includes(Buffer.from('living-room')) ? packet(
        rr(instance, 33, Buffer.concat([Buffer.from([0, 0, 0, 0x00, 0x1b, 0x58]), name(host)])),
        rr(instance, 16, Buffer.concat([Buffer.from([17]), Buffer.from('deviceid=11:22:33')])),
        rr(host, 1, Buffer.from([192, 0, 2, 44])),
      ) : packet(rr('_airplay._tcp.local', 12, name(instance)));
      responder.send(response, rinfo.port, rinfo.address);
      responder.send(response, rinfo.port, rinfo.address);
      if (requestPacket.includes(Buffer.from('living-room'))) requestResolve();
    });
    const services: TargetedService[] = [];
    const resolver = new TargetedMdns(parseTargets(['127.0.0.1']), service => services.push(service), error => { throw error; }, port, 0);
    await resolver.start();
    await request;
    // A real UDP socket needs one platform poll turn after the responder's asynchronous send.
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    resolver.close();
    expect(services).toEqual([expect.objectContaining({ type: 'airplay', name: 'living-room', host, port: 7000, addresses: ['192.0.2.44'], txt: { deviceid: '11:22:33' } })]);
  });
});
