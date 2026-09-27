import { Socket } from 'node:net';
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  diffieHellman,
  sign,
  verify as cryptoVerify,
  createPublicKey,
  createPrivateKey,
} from 'node:crypto';
import { EventEmitter } from 'node:events';
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';
import { HAPSession } from './util/hap-session.js';
import { hkdfSha512, encryptChaCha20, decryptChaCha20 } from './util/crypto.js';
import { TlvTag, tlvEncode, tlvDecode } from './util/tlv.js';
import { MRPMessage, MessageType } from './mrp/messages.js';
import { buildDataStreamFrame, buildDataStreamReply, parseDataStreamFrame } from './util/data-stream.js';
import type { HAPCredentials } from './auth/types.js';
import { PendingRequests } from './util/pending-requests.js';

const DATA_CHANNEL_TYPE_UUID = '1910A70F-DBC0-4242-AF95-115DB30604E1';
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

interface ParsedHTTP {
  headers: Record<string, string>;
  body: Buffer;
  totalSize: number;
  statusCode?: number;
}

/** Parse an HTTP message (request or response) from a buffer. Returns null if incomplete. */
function parseHTTPMessage(buf: Buffer): ParsedHTTP | null {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;

  const headerSection = buf.subarray(0, headerEnd).toString('utf8');
  const headers: Record<string, string> = {};
  const lines = headerSection.split('\r\n');
  const status = /^(?:HTTP|RTSP)\/1\.[01] (\d{3})(?: |$)/.exec(lines[0]);
  if (!status && !/^[A-Z]+ \S+ (?:HTTP|RTSP)\/1\.[01]$/.test(lines[0])) throw new Error('Invalid AirPlay HTTP header');
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx > 0) {
      headers[lines[i].substring(0, colonIdx).trim().toLowerCase()] =
        lines[i].substring(colonIdx + 1).trim();
    }
  }

  const bodyStart = headerEnd + 4;
  const length = headers['content-length'] ?? '0';
  if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new Error('Invalid AirPlay content length');
  const contentLength = Number(length);
  const totalSize = bodyStart + contentLength;
  if (buf.length < totalSize) return null;

  const body = buf.subarray(bodyStart, bodyStart + contentLength);
  return { headers, body: Buffer.from(body), totalSize, statusCode: status ? Number(status[1]) : undefined };
}

export interface AirPlayConnectionOptions {
  timeoutMs?: number;
  logger?: (message: string) => void;
}

export class AirPlayConnection extends EventEmitter {
  private socket?: Socket;
  private eventSocket?: Socket;
  private dataSocket?: Socket;
  private session?: HAPSession;
  private eventSession?: HAPSession;
  private dataSession?: HAPSession;
  private rawBuffer = Buffer.alloc(0);
  private cseq = 0;
  private sharedSecret?: Buffer;
  private sessionId = String(Math.floor(Math.random() * 0xffffffff));
  private dacpId = randomBytes(8).toString('hex');
  private activeRemote = String(Math.floor(Math.random() * 0xffffffff));
  private localAddress?: string;
  private pending = new PendingRequests(error => this.fail(error));
  private sockets = new Set<Socket>();
  private nextOperation = 0;
  private closed = false;
  private started = false;
  private removeAbortListener?: () => void;
  private feedbackInterval?: ReturnType<typeof setInterval>;
  private dataDecBuffer = Buffer.alloc(0);
  private mrpResponseTypes = new Map<string, number | undefined>();
  private incomingMRP = Promise.resolve();

  constructor(
    private host: string,
    private port: number,
    private credentials: HAPCredentials,
    private options: AirPlayConnectionOptions = {},
  ) {
    super();
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new RangeError('Invalid AirPlay timeout');
  }

  private get timeoutMs(): number { return this.options.timeoutMs ?? 10000; }

  private assertOpen(): void {
    if (this.closed) throw new Error('AirPlay connection closed');
  }

  private async openSocket(port: number): Promise<Socket> {
    this.assertOpen();
    const socket = new Socket();
    this.sockets.add(socket); // Own the socket before connect can settle or be cancelled.
    const key = `connect:${++this.nextOperation}`;
    const connected = this.pending.create<Socket>(key, this.timeoutMs);
    socket.once('connect', () => this.pending.resolve(key, socket));
    socket.on('error', error => this.fail(error));
    socket.once('close', () => {
      this.sockets.delete(socket);
      if (!this.closed) this.fail(new Error('AirPlay connection closed by peer'));
    });
    socket.setNoDelay(true);
    try { socket.connect(port, this.host); }
    catch (error) { this.fail(error instanceof Error ? error : new Error('AirPlay connection failed')); }
    const result = await connected;
    this.assertOpen();
    return result;
  }

  private async write(socket: Socket | undefined, data: Buffer): Promise<void> {
    this.assertOpen();
    if (!socket || socket.destroyed) throw new Error('AirPlay socket not connected');
    const key = `write:${++this.nextOperation}`;
    const written = this.pending.create<void>(key, this.timeoutMs);
    try {
      socket.write(data, error => {
        if (error) this.fail(error);
        else this.pending.resolve(key, undefined);
      });
    } catch (error) { this.fail(error instanceof Error ? error : new Error('AirPlay write failed')); }
    return written;
  }

  /** One connection lifetime; use a new instance after close or failure. */
  async connect({ signal }: { signal?: AbortSignal } = {}): Promise<void> {
    this.assertOpen();
    if (this.started) throw new Error('AirPlay connection already started');
    this.started = true;
    const onAbort = () => this.fail(new Error('AirPlay connection cancelled'));
    if (signal?.aborted) {
      onAbort();
      throw new Error('AirPlay connection cancelled');
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    this.removeAbortListener = () => signal?.removeEventListener('abort', onAbort);
    try {
      // Step 1: Open TCP connection
      this.log('opening TCP connection...');
      this.socket = await this.openSocket(this.port);
      this.localAddress = this.socket.localAddress;
      this.log(`TCP connected (local ${this.localAddress})`);

      // Initially handle raw (unencrypted) data for pair-verify
      this.socket.on('data', (data) => this.onRawData(Buffer.from(data)));

      // Step 2: Pair-verify on this connection
      this.log('pair-verify...');
      const { outputKey, inputKey, sharedSecret } = await this.pairVerifyOnSocket();
      this.assertOpen();
      this.session = new HAPSession(outputKey, inputKey);
      this.sharedSecret = sharedSecret;
      this.log('pair-verify OK');

      // Switch from raw mode to encrypted RTSP mode
      this.socket.removeAllListeners('data');
      this.socket.on('data', (data) => this.onEncryptedData(Buffer.from(data)));
      if (this.rawBuffer.length) {
        const remaining = this.rawBuffer;
        this.rawBuffer = Buffer.alloc(0);
        this.onEncryptedData(remaining);
      }

      // Step 3: Set up event channel via RTSP SETUP
      this.log('SETUP event channel...');
      await this.setupEventChannel();
      this.log('event channel OK');

      // Step 4: RECORD
      this.log('RECORD...');
      await this.sendRTSP('RECORD', this.rtspUri);
      this.log('RECORD OK');

      // Step 5: Start FEEDBACK heartbeat (every 2 seconds)
      this.startFeedbackHeartbeat();

      // Step 6: Set up data channel (MRP tunnel)
      this.log('SETUP data channel...');
      await this.setupDataChannel();
      this.assertOpen();
      this.log('data channel OK');
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('AirPlay connection failed'));
      throw error;
    }
  }

  private log(msg: string): void {
    if (this.options.logger) this.options.logger(msg);
    else console.error(`[AirPlay] ${msg}`);
  }

  // --- Pair-verify directly on the RTSP socket ---

  private async pairVerifyOnSocket(): Promise<{
    outputKey: Buffer;
    inputKey: Buffer;
    sharedSecret: Buffer;
  }> {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const ephemeralPublicKeyRaw = Buffer.from(
      publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    );

    // M1: Send ephemeral public key
    const m1 = tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x01]),
      [TlvTag.PublicKey]: ephemeralPublicKeyRaw,
    });
    const m2Body = await this.httpPostOnSocket('/pair-verify', m1);
    const m2 = tlvDecode(m2Body);

    const serverEphemeralPub = m2[TlvTag.PublicKey];
    const m2Encrypted = m2[TlvTag.EncryptedData];
    if (!serverEphemeralPub || !m2Encrypted) {
      const error = m2[TlvTag.Error];
      throw new Error(`M2 missing PublicKey or EncryptedData (error=${error ? error[0] : 'none'})`);
    }

    // Compute shared secret
    const serverEphemeralKeyObj = createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, serverEphemeralPub]),
      format: 'der',
      type: 'spki',
    });
    const sharedSecret = diffieHellman({ privateKey, publicKey: serverEphemeralKeyObj });

    // Derive session key
    const sessionKey = await hkdfSha512(
      Buffer.from(sharedSecret),
      'Pair-Verify-Encrypt-Salt',
      'Pair-Verify-Encrypt-Info',
      32,
    );

    // Decrypt M2 encrypted data
    const m2Nonce = Buffer.alloc(12, 0);
    m2Nonce.write('PV-Msg02', 4);
    const m2Ciphertext = m2Encrypted.subarray(0, m2Encrypted.length - 16);
    const m2Tag = m2Encrypted.subarray(m2Encrypted.length - 16);
    const decrypted = decryptChaCha20(sessionKey, m2Nonce, m2Ciphertext, m2Tag, Buffer.alloc(0));
    const serverInfo = tlvDecode(decrypted);

    const serverIdentifier = serverInfo[TlvTag.Identifier];
    const serverSignature = serverInfo[TlvTag.Signature];
    if (!serverIdentifier || !serverSignature) {
      throw new Error('M2 decrypted data missing Identifier or Signature');
    }

    // Verify server signature
    const serverSignedData = Buffer.concat([serverEphemeralPub, serverIdentifier, ephemeralPublicKeyRaw]);
    const serverLTPKObj = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, this.credentials.serverLTPK]),
      format: 'der',
      type: 'spki',
    });
    const valid = cryptoVerify(null, serverSignedData, serverLTPKObj, serverSignature);
    if (!valid) throw new Error('Server signature verification failed');

    // Sign our proof
    const clientSignedData = Buffer.concat([
      ephemeralPublicKeyRaw,
      Buffer.from(this.credentials.clientId),
      serverEphemeralPub,
    ]);
    const clientPrivKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, this.credentials.clientLTSK]),
      format: 'der',
      type: 'pkcs8',
    });
    const clientSignature = sign(null, clientSignedData, clientPrivKey);

    // Encrypt M3
    const subTlv = tlvEncode({
      [TlvTag.Identifier]: Buffer.from(this.credentials.clientId),
      [TlvTag.Signature]: clientSignature,
    });
    const m3Nonce = Buffer.alloc(12, 0);
    m3Nonce.write('PV-Msg03', 4);
    const { ciphertext, tag } = encryptChaCha20(sessionKey, m3Nonce, subTlv, Buffer.alloc(0));

    const m3 = tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x03]),
      [TlvTag.EncryptedData]: Buffer.concat([ciphertext, tag]),
    });

    const m4Body = await this.httpPostOnSocket('/pair-verify', m3);
    const m4 = tlvDecode(m4Body);
    const m4Error = m4[TlvTag.Error];
    if (m4Error && m4Error[0] !== 0) {
      throw new Error(`Pair-verify M4 error: ${m4Error[0]}`);
    }

    // Derive encryption keys
    const outputKey = await hkdfSha512(
      Buffer.from(sharedSecret), 'Control-Salt', 'Control-Write-Encryption-Key', 32,
    );
    const inputKey = await hkdfSha512(
      Buffer.from(sharedSecret), 'Control-Salt', 'Control-Read-Encryption-Key', 32,
    );

    return { outputKey, inputKey, sharedSecret: Buffer.from(sharedSecret) };
  }

  /** Send a plain HTTP POST on the raw socket and read the response */
  private async httpPostOnSocket(path: string, body: Buffer): Promise<Buffer> {
    this.assertOpen();
    const headers = [
      `POST ${path} HTTP/1.1`,
      `Host: ${this.host}:${this.port}`,
      'User-Agent: AirPlay/320.20',
      'Connection: keep-alive',
      'X-Apple-HKP: 3',
      'Content-Type: application/octet-stream',
      `Content-Length: ${body.length}`,
      '',
      '',
    ].join('\r\n');

    const response = this.pending.create<Buffer>('raw', this.timeoutMs);
    try {
      const [, result] = await Promise.all([this.write(this.socket, Buffer.concat([Buffer.from(headers), body])), response]);
      return result;
    } catch (error) {
      this.pending.reject('raw', error instanceof Error ? error : new Error('AirPlay request failed'));
      throw error;
    }
  }

  /** Handle raw (unencrypted) data during pair-verify phase */
  private onRawData(data: Buffer): void {
    if (this.closed) return;
    this.rawBuffer = Buffer.concat([this.rawBuffer, data]);
    if (!this.pending.has('raw')) return;
    try {
      const parsed = parseHTTPMessage(this.rawBuffer);
      if (!parsed) return;
      this.rawBuffer = this.rawBuffer.subarray(parsed.totalSize);
      if (parsed.statusCode === undefined) throw new Error('Invalid AirPlay pairing response');
      if (parsed.statusCode < 200 || parsed.statusCode >= 300) {
        this.pending.reject('raw', new Error(`AirPlay HTTP status ${parsed.statusCode}`));
      } else this.pending.resolve('raw', parsed.body);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Invalid AirPlay pairing response'));
    }
  }

  // --- Encrypted RTSP ---

  private encryptedBuffer = Buffer.alloc(0);
  private rtspBuffer = Buffer.alloc(0);

  private async sendRTSP(
    method: string,
    uri: string,
    headers: Record<string, string> = {},
    body?: Buffer,
  ): Promise<{ headers: Record<string, string>; body: Buffer }> {
    this.assertOpen();
    if (!this.session) throw new Error('AirPlay encryption not available');
    this.cseq++;
    const allHeaders: Record<string, string> = {
      ...headers,
      CSeq: String(this.cseq),
      'User-Agent': 'AirPlay/620.14.6',
      'DACP-ID': this.dacpId,
      'Active-Remote': this.activeRemote,
      'Client-Instance': this.dacpId,
    };

    let request = `${method} ${uri} RTSP/1.0\r\n`;
    for (const [key, value] of Object.entries(allHeaders)) {
      request += `${key}: ${value}\r\n`;
    }
    if (body) {
      request += `Content-Length: ${body.length}\r\n`;
    }
    request += '\r\n';

    let data = Buffer.from(request);
    if (body) data = Buffer.concat([data, body]);

    if (this.session) {
      data = Buffer.from(this.session.encrypt(data));
    }

    const key = `rtsp:${this.cseq}`;
    const response = this.pending.create<ParsedHTTP>(key, this.timeoutMs);
    try {
      const [, result] = await Promise.all([this.write(this.socket, data), response]);
      return result;
    } catch (error) {
      this.pending.reject(key, error instanceof Error ? error : new Error('AirPlay RTSP request failed'));
      throw error;
    }
  }

  private get rtspUri(): string {
    return `rtsp://${this.localAddress}/${this.sessionId}`;
  }

  private async setupEventChannel(): Promise<void> {
    const macAddress = randomBytes(6).toString('hex').match(/../g)!.join(':').toUpperCase();
    const body = bplistCreator({
      isRemoteControlOnly: true,
      timingProtocol: 'None',
      sessionUUID: randomUUID().toUpperCase(),
      deviceID: macAddress,
      macAddress: macAddress,
      model: 'iPhone14,3',
      name: 'Node ATV Remote',
      osName: 'iPhone OS',
      osVersion: '17.0',
      osBuildVersion: '21A5248v',
      sourceVersion: '550.10',
    });
    const response = await this.sendRTSP('SETUP', this.rtspUri, {
      'Content-Type': 'application/x-apple-binary-plist',
    }, body);
    // Parse eventPort from response
    let eventPort: number | undefined;
    if (response.body.length > 0) {
      try {
        const parsed = parseBuffer(response.body);
        const respObj = parsed[0] as Record<string, unknown>;
        eventPort = respObj?.eventPort as number | undefined;
      } catch {
        // ignore parse errors
      }
    }

    if (eventPort) {
      // Create HAP session for event channel with Events-Salt keys.
      // Keys are reversed because the event channel originates from the receiver.
      const eventOutputKey = await hkdfSha512(
        this.sharedSecret!, 'Events-Salt', 'Events-Read-Encryption-Key', 32,
      );
      const eventInputKey = await hkdfSha512(
        this.sharedSecret!, 'Events-Salt', 'Events-Write-Encryption-Key', 32,
      );
      this.assertOpen();
      this.eventSession = new HAPSession(eventOutputKey, eventInputKey);

      this.log(`connecting to event port ${eventPort}...`);
      this.eventSocket = await this.openSocket(eventPort);
      this.log('event socket connected');
      this.eventSocket.on('data', (data) => this.onEventChannelData(Buffer.from(data)));
    }
  }

  private async setupDataChannel(): Promise<void> {
    // Seed must be an integer (not Buffer) in the bplist so it encodes as uint64.
    // bplist-creator truncates values > 2^31-1, so we limit to that range.
    const seed = Math.floor(Math.random() * 0x7FFFFFFF);
    const channelID = randomUUID().toUpperCase();
    const body = bplistCreator({
      streams: [{
        type: 130,
        controlType: 2,
        channelID,
        seed,
        clientUUID: randomUUID().toUpperCase(),
        wantsDedicatedSocket: true,
        clientTypeUUID: DATA_CHANNEL_TYPE_UUID,
      }],
    });

    const response = await this.sendRTSP('SETUP', this.rtspUri, {
      'Content-Type': 'application/x-apple-binary-plist',
    }, body);

    // Parse data port from response body
    let dataPort = this.port;
    if (response.body.length > 0) {
      try {
        const parsed = parseBuffer(response.body);
        const respObj = parsed[0] as Record<string, unknown>;
        const streams = respObj?.streams as Array<Record<string, unknown>> | undefined;
        if (streams?.[0]?.dataPort) {
          dataPort = streams[0].dataPort as number;
        }
      } catch {
        // ignore parse errors
      }
    }

    // Derive data channel encryption keys via HKDF
    // Salt = "DataStream-Salt" + seed as decimal string
    const saltStr = `DataStream-Salt${seed}`;

    const dataOutputKey = await hkdfSha512(
      this.sharedSecret!,
      saltStr,
      'DataStream-Output-Encryption-Key',
      32,
    );
    const dataInputKey = await hkdfSha512(
      this.sharedSecret!,
      saltStr,
      'DataStream-Input-Encryption-Key',
      32,
    );
    this.assertOpen();
    this.dataSession = new HAPSession(dataOutputKey, dataInputKey);

    this.log(`connecting data channel to ${this.host}:${dataPort}...`);

    this.dataSocket = await this.openSocket(dataPort);
    this.log('data socket connected');

    this.dataSocket.on('data', (data) => this.onDataChannelData(Buffer.from(data)));
    this.dataSocket.on('end', () => this.log('data channel ended by remote'));

    // Initialize MRP protocol on data channel
    await this.initMRPProtocol();
  }

  private async initMRPProtocol(): Promise<void> {
    this.log('sending DeviceInfo...');

    // 1. DeviceInfo must be the first message
    const deviceInfo = await MRPMessage.deviceInfo({
      uniqueIdentifier: this.credentials.clientId,
      name: 'Node ATV Remote',
    });
    // Wait for DeviceInfo response from Apple TV
    await this.sendMRPMessageAndWait(deviceInfo, MessageType.DeviceInfo, 5000);
    this.log('DeviceInfo exchange complete');

    // 2. CryptoPairing is NOT performed over AirPlay transport.
    // The data channel is already encrypted at the transport layer (HAP session).
    // pyatv's AirPlayMrpConnection.enable_encryption() is a no-op.
    // Sending CryptoPairing confuses some Apple TV models and delays setup.

    // 3. SetConnectionState (fire and forget, pyatv uses send() not send_and_receive())
    const connState = await MRPMessage.setConnectionState(2);
    await this.sendMRPMessage(connState);

    // 4. ClientUpdatesConfig (pyatv uses send_and_receive)
    const updatesConfig = await MRPMessage.clientUpdatesConfig({
      artworkUpdates: true,
      nowPlayingUpdates: true,
      volumeUpdates: true,
      keyboardUpdates: true,
      outputDeviceUpdates: true,
    });
    await this.sendMRPMessageAndWait(updatesConfig);

    // 5. GetKeyboardSession (pyatv uses send_and_receive)
    const getKeyboard = await MRPMessage.sendCommand(MessageType.GetKeyboardSession);
    await this.sendMRPMessageAndWait(getKeyboard, MessageType.Keyboard);
  }

  /** Perform MRP-level pair-verify using CryptoPairingMessage */
  private async mrpPairVerify(): Promise<void> {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const ephemeralPublicKeyRaw = Buffer.from(
      publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    );

    // M1: Send our ephemeral public key
    // Manually construct TLV with SeqNo first (pyatv order) since JS sorts
    // numeric object keys ascending, which would put PublicKey(3) before SeqNo(6)
    const m1Tlv = Buffer.concat([
      Buffer.from([TlvTag.SeqNo, 0x01, 0x01]),
      Buffer.from([TlvTag.PublicKey, ephemeralPublicKeyRaw.length]),
      ephemeralPublicKeyRaw,
    ]);
    const m1Msg = await MRPMessage.cryptoPairing(m1Tlv);
    // Wait for M2 response
    const m2Response = await this.sendMRPMessageAndWait(m1Msg, MessageType.CryptoPairing, 10000);
    const m2PairingData = (m2Response as any)['.cryptoPairingMessage']?.pairingData as Buffer;
    if (!m2PairingData) throw new Error('M2 missing pairingData');

    const m2Tlv = tlvDecode(m2PairingData);
    const serverEphemeralPub = m2Tlv[TlvTag.PublicKey];
    const m2Encrypted = m2Tlv[TlvTag.EncryptedData];
    if (!serverEphemeralPub || !m2Encrypted) {
      throw new Error('MRP M2 missing PublicKey or EncryptedData');
    }

    // Compute shared secret
    const serverEphemeralKeyObj = createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, serverEphemeralPub]),
      format: 'der',
      type: 'spki',
    });
    const sharedSecret = diffieHellman({ privateKey, publicKey: serverEphemeralKeyObj });

    // Derive session key for TLV encryption
    const sessionKey = await hkdfSha512(
      Buffer.from(sharedSecret),
      'Pair-Verify-Encrypt-Salt',
      'Pair-Verify-Encrypt-Info',
      32,
    );

    // Decrypt M2 sub-TLV
    const m2Nonce = Buffer.alloc(12, 0);
    m2Nonce.write('PV-Msg02', 4);
    const m2Ciphertext = m2Encrypted.subarray(0, m2Encrypted.length - 16);
    const m2Tag = m2Encrypted.subarray(m2Encrypted.length - 16);
    const decrypted = decryptChaCha20(sessionKey, m2Nonce, m2Ciphertext, m2Tag, Buffer.alloc(0));
    const serverInfo = tlvDecode(decrypted);

    const serverIdentifier = serverInfo[TlvTag.Identifier];
    const serverSignature = serverInfo[TlvTag.Signature];
    if (!serverIdentifier || !serverSignature) {
      throw new Error('MRP M2 decrypted data missing Identifier or Signature');
    }

    // Verify server signature
    const serverSignedData = Buffer.concat([serverEphemeralPub, serverIdentifier, ephemeralPublicKeyRaw]);
    const serverLTPKObj = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, this.credentials.serverLTPK]),
      format: 'der',
      type: 'spki',
    });
    const valid = cryptoVerify(null, serverSignedData, serverLTPKObj, serverSignature);
    if (!valid) throw new Error('MRP server signature verification failed');

    // Sign our proof for M3
    const clientSignedData = Buffer.concat([
      ephemeralPublicKeyRaw,
      Buffer.from(this.credentials.clientId),
      serverEphemeralPub,
    ]);
    const clientPrivKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, this.credentials.clientLTSK]),
      format: 'der',
      type: 'pkcs8',
    });
    const clientSignature = sign(null, clientSignedData, clientPrivKey);

    // Encrypt M3 sub-TLV
    const subTlv = tlvEncode({
      [TlvTag.Identifier]: Buffer.from(this.credentials.clientId),
      [TlvTag.Signature]: clientSignature,
    });
    const m3Nonce = Buffer.alloc(12, 0);
    m3Nonce.write('PV-Msg03', 4);
    const { ciphertext, tag } = encryptChaCha20(sessionKey, m3Nonce, subTlv, Buffer.alloc(0));

    const m3Tlv = tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x03]),
      [TlvTag.EncryptedData]: Buffer.concat([ciphertext, tag]),
    });
    const m3Msg = await MRPMessage.cryptoPairing(m3Tlv);
    // Wait for M4 acknowledgment
    await this.sendMRPMessageAndWait(m3Msg, MessageType.CryptoPairing);

    // Over AirPlay, MRP encryption keys are derived but NOT applied.
    // The data channel is already encrypted at the transport layer.
    // This matches pyatv's AirPlayMrpConnection.enable_encryption() which is a no-op.
    this.log('MRP pair-verify complete (encryption not applied over AirPlay)');
  }

  /** Handle encrypted data after pair-verify is complete */
  private onEncryptedData(data: Buffer): void {
    if (this.closed) return;
    this.encryptedBuffer = Buffer.concat([this.encryptedBuffer, data]);
    this.tryParseRTSPResponse();
  }

  private tryParseRTSPResponse(): void {
    try {
      if (!this.session) throw new Error('AirPlay encryption not available');
      while (this.encryptedBuffer.length >= 2) {
        const size = 2 + this.encryptedBuffer.readUInt16LE(0) + 16;
        if (this.encryptedBuffer.length < size) break;
        const frame = this.encryptedBuffer.subarray(0, size);
        this.encryptedBuffer = this.encryptedBuffer.subarray(size);
        this.rtspBuffer = Buffer.concat([this.rtspBuffer, this.session.decrypt(frame)]);
      }
      while (!this.closed) {
        const parsed = parseHTTPMessage(this.rtspBuffer);
        if (!parsed) break;
        this.rtspBuffer = this.rtspBuffer.subarray(parsed.totalSize);
        if (parsed.statusCode === undefined) throw new Error('Invalid AirPlay RTSP response');
        const sequence = parsed.headers.cseq;
        if (sequence && /^\d+$/.test(sequence) && Number.isSafeInteger(Number(sequence))) {
          const key = `rtsp:${Number(sequence)}`;
          if (parsed.statusCode >= 200 && parsed.statusCode < 300) this.pending.resolve(key, parsed);
          else this.pending.reject(key, new Error(`AirPlay RTSP status ${parsed.statusCode}`));
        }
        this.emit('rtsp-response', { headers: parsed.headers, body: parsed.body });
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Invalid AirPlay RTSP frame'));
    }
  }

  private eventEncBuffer = Buffer.alloc(0);
  private eventDecBuffer = Buffer.alloc(0);

  private onEventChannelData(data: Buffer): void {
    if (this.closed) return;
    this.eventEncBuffer = Buffer.concat([this.eventEncBuffer, data]);
    if (!this.eventSession) return;

    // Decrypt HAP frames from the event channel
    while (this.eventEncBuffer.length >= 2) {
      const frameLen = this.eventEncBuffer.readUInt16LE(0);
      const totalFrameSize = 2 + frameLen + 16; // length + ciphertext + auth tag
      if (this.eventEncBuffer.length < totalFrameSize) break;

      const frame = this.eventEncBuffer.subarray(0, totalFrameSize);
      this.eventEncBuffer = this.eventEncBuffer.subarray(totalFrameSize);

      try {
        const decrypted = this.eventSession.decrypt(frame);
        this.eventDecBuffer = Buffer.concat([this.eventDecBuffer, decrypted]);
      } catch {
        this.fail(new Error('Invalid AirPlay event encryption'));
        return;
      }
    }

    // Parse HTTP requests from decrypted data and respond with 200 OK
    try { this.processEventRequests(); }
    catch { this.fail(new Error('Invalid AirPlay event request')); }
  }

  private processEventRequests(): void {
    while (this.eventDecBuffer.length > 0) {
      const parsed = parseHTTPMessage(this.eventDecBuffer);
      if (!parsed) break;

      this.eventDecBuffer = this.eventDecBuffer.subarray(parsed.totalSize);

      // Build 200 OK response
      const respHeaders: string[] = [
        'Content-Length: 0',
        'Audio-Latency: 0',
      ];
      if (parsed.headers['server']) respHeaders.push(`Server: ${parsed.headers['server']}`);
      if (parsed.headers['cseq']) respHeaders.push(`CSeq: ${parsed.headers['cseq']}`);

      const response = `RTSP/1.0 200 OK\r\n${respHeaders.join('\r\n')}\r\n\r\n`;
      const encrypted = this.eventSession!.encrypt(Buffer.from(response));
      void this.write(this.eventSocket, encrypted).catch(error => this.fail(error));
    }
  }

  private dataEncBuffer = Buffer.alloc(0);

  private onDataChannelData(data: Buffer): void {
    if (this.closed) return;
    this.dataEncBuffer = Buffer.concat([this.dataEncBuffer, data]);

    // Wait for complete HAP frames before decrypting
    while (this.dataEncBuffer.length >= 2) {
      const frameLen = this.dataEncBuffer.readUInt16LE(0);
      const totalFrameSize = 2 + frameLen + 16; // length + ciphertext + auth tag
      if (this.dataEncBuffer.length < totalFrameSize) break;

      const frame = this.dataEncBuffer.subarray(0, totalFrameSize);
      this.dataEncBuffer = this.dataEncBuffer.subarray(totalFrameSize);

      try {
        const decrypted = this.dataSession!.decrypt(frame);
        this.dataDecBuffer = Buffer.concat([this.dataDecBuffer, decrypted]);
      } catch (e) {
        this.log(`data channel decrypt error: ${e}`);
        this.fail(new Error('Invalid AirPlay data encryption'));
        return;
      }
    }

    // Parse complete DataStream frames from the decrypted buffer
    while (this.dataDecBuffer.length >= 32) {
      let frame;
      try {
        frame = parseDataStreamFrame(this.dataDecBuffer, 0);
      } catch {
        this.fail(new Error('Invalid AirPlay data frame'));
        return;
      }
      if (!frame) break;

      // Send rply for sync frames from the Apple TV
      if (frame.messageType === 'sync') {
        const reply = buildDataStreamReply(frame.seqno);
        const encrypted = this.dataSession!.encrypt(reply);
        void this.write(this.dataSocket, encrypted).catch(error => this.fail(error));
      }

      for (const protobufData of frame.protobufMessages) {
        this.incomingMRP = this.incomingMRP.then(() => this.handleMRPResponse(protobufData));
      }

      // Advance buffer past this frame
      this.dataDecBuffer = this.dataDecBuffer.subarray(frame.totalSize);
    }
  }

  private async handleMRPResponse(protobufData: Buffer): Promise<void> {
    if (this.closed) return;
    try {
      const decoded = await MRPMessage.decode(protobufData);
      if (this.closed) return;
      const msg = decoded as unknown as Record<string, unknown>;
      this.log(`MRP response: type=${msg.type}`);

      // Always emit so that listeners (e.g. AppleTV) can observe all messages
      this.emit('mrp-message', msg);

      const identifier = Object.hasOwn(msg, 'identifier') ? msg.identifier : undefined;
      const key = identifier ? `mrp:id:${identifier}` : `mrp:type:${msg.type}`;
      if (this.pending.has(key)) {
        const expected = this.mrpResponseTypes.get(key);
        if (typeof msg.errorCode === 'number' && msg.errorCode !== 0) {
          this.pending.reject(key, new Error(`AirPlay MRP error ${msg.errorCode}`));
        } else if (expected !== undefined && (!Object.hasOwn(msg, 'type') || msg.type !== expected)) {
          this.pending.reject(key, new Error('Unexpected AirPlay MRP response type'));
        } else this.pending.resolve(key, msg);
      }
    } catch (e) {
      this.fail(new Error('Invalid AirPlay MRP message'));
    }
  }

  private startFeedbackHeartbeat(): void {
    this.assertOpen();
    let pending = false;
    this.feedbackInterval = setInterval(async () => {
      if (pending || this.closed) return;
      pending = true;
      try {
        await this.sendRTSP('POST', '/feedback');
      } catch (e) {
        this.fail(new Error('AirPlay heartbeat failed'));
      } finally {
        pending = false;
      }
    }, 2000);
  }

  async sendMRPMessageAndWait(
    protobufData: Buffer,
    responseType?: number,
    timeoutMs = 5000,
  ): Promise<Record<string, unknown>> {
    this.assertOpen();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid MRP timeout');
    const message = await MRPMessage.decode(protobufData);
    this.assertOpen();
    const identifier = Object.hasOwn(message, 'identifier') ? message.identifier : undefined;
    if (!identifier && responseType === undefined) throw new Error('MRP request needs an identifier or response type');
    const key = identifier ? `mrp:id:${identifier}` : `mrp:type:${responseType}`;
    const response = this.pending.create<Record<string, unknown>>(key, timeoutMs);
    this.mrpResponseTypes.set(key, responseType);
    try {
      const [, result] = await Promise.all([this.sendMRPMessage(protobufData), response]);
      return result;
    } catch (error) {
      this.pending.reject(key, error instanceof Error ? error : new Error('AirPlay MRP request failed'));
      throw error;
    } finally {
      this.mrpResponseTypes.delete(key);
    }
  }

  async sendMRPMessage(protobufData: Buffer): Promise<void> {
    this.assertOpen();
    if (!this.dataSocket || !this.dataSession) throw new Error('Data channel not connected');
    const frame = buildDataStreamFrame(protobufData);
    const encrypted = this.dataSession.encrypt(frame);
    await this.write(this.dataSocket, encrypted);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.shutdown(error);
    if (this.listenerCount('error')) this.emit('error', error);
  }

  private shutdown(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    this.pending.rejectAll(error);
    this.mrpResponseTypes.clear();
    if (this.feedbackInterval) {
      clearInterval(this.feedbackInterval);
      this.feedbackInterval = undefined;
    }
    for (const socket of new Set([...this.sockets, this.socket, this.eventSocket, this.dataSocket])) socket?.destroy();
    this.sockets.clear();
    this.dataSocket = undefined;
    this.eventSocket = undefined;
    this.socket = undefined;
    this.rawBuffer = this.encryptedBuffer = this.rtspBuffer = Buffer.alloc(0);
    this.eventEncBuffer = this.eventDecBuffer = this.dataEncBuffer = this.dataDecBuffer = Buffer.alloc(0);
    this.session = this.eventSession = this.dataSession = undefined;
    this.sharedSecret = undefined;
    this.emit('close');
  }

  close(): void { this.shutdown(new Error('AirPlay connection closed')); }
}
