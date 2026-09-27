import { MessageType } from './mrp/messages.js';

export { MessageType };

export class Message {
  readonly type: MessageType;
  readonly identifier: string;
  readonly payload: Record<string, unknown>;

  constructor(decoded: Record<string, unknown>) {
    // protobufjs supplies the first enum member for an absent proto2 field.
    // An untyped acknowledgement must not appear to be a SendCommand.
    this.type = Object.hasOwn(decoded, 'type') ? decoded.type as MessageType : 0;
    this.identifier = (decoded.identifier as string) ?? '';
    this.payload = decoded;
  }

  toString(): string {
    const typeName =
      MessageType[this.type] ?? `Unknown(${this.type})`;
    return `Message(${typeName}, id=${this.identifier})`;
  }
}
