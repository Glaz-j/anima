import { createConnection, type Socket } from 'node:net';

/** Minimal loopback-only Source RCON client. Commands are serialized and terminated by a second response id. */
export class LocalRcon {
  private socket?: Socket; private buffer = Buffer.alloc(0); private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<number, { resolve(value: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; chunks: string[]; endId?: number; terminatorSent?: boolean }>();
  async connect(port: number, password: string) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 25565) throw new Error('Invalid isolated RCON port.');
    if (this.socket) throw new Error('RCON is already connected.');
    const socket = this.socket = createConnection({ host: '127.0.0.1', port });
    socket.setNoDelay(true);
    socket.on('data', bytes => this.consume(bytes));
    socket.on('error', () => this.fail(new Error('Local exam RCON connection failed.')));
    socket.on('close', () => this.fail(new Error('Local exam RCON closed.')));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('RCON connect timeout.')); }, 3000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('Cannot connect to isolated exam server.')); });
    });
    try { await this.request(3, password, false); } catch (error) { this.close(); throw error; }
  }
  command(command: string): Promise<string> {
    if (/[\r\n\0]/u.test(command) || command.length > 8192) return Promise.reject(new Error('Invalid single RCON command.'));
    const request = this.queue.then(() => this.request(2, command, true));
    this.queue = request.catch(() => {}); return request;
  }
  private request(type: number, payload: string, terminated: boolean): Promise<string> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('RCON is disconnected.'));
    const id = this.nextId++, endId = terminated ? this.nextId++ : undefined;
    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('RCON command timed out; result is unknown.')); this.close();
      }, 5000);
      this.pending.set(id, { resolve, reject, timer, chunks: [], endId });
    });
    this.send(id, type, payload);
    return promise;
  }
  private send(id: number, type: number, payload: string) {
    const text = Buffer.from(payload, 'utf8'), packet = Buffer.alloc(text.length + 14);
    packet.writeInt32LE(text.length + 10, 0); packet.writeInt32LE(id, 4); packet.writeInt32LE(type, 8); text.copy(packet, 12);
    this.socket!.write(packet);
  }
  private consume(bytes: Buffer) {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (length < 10 || length > 1_048_576) { this.fail(new Error('Invalid RCON frame.')); this.close(); return; }
      if (this.buffer.length < length + 4) return;
      const id = this.buffer.readInt32LE(4), type = this.buffer.readInt32LE(8), payload = this.buffer.subarray(12, length + 2).toString('utf8');
      this.buffer = this.buffer.subarray(length + 4);
      if (id === -1) { this.fail(new Error('Isolated exam RCON authentication failed.')); this.close(); return; }
      let active = this.pending.get(id);
      if (active) {
        active.chunks.push(payload);
        // Vanilla's RCON reader can reject two request packets coalesced in one
        // socket read. Wait for its first response before sending the barrier.
        // Remaining chunks of this response precede the barrier's reply.
        if (active.endId !== undefined && !active.terminatorSent) { active.terminatorSent = true; this.send(active.endId, 2, ''); }
        if (active.endId === undefined && type === 2) { clearTimeout(active.timer); this.pending.delete(id); active.resolve(active.chunks.join('')); }
      } else {
        const match = [...this.pending.entries()].find(([, pending]) => pending.endId === id);
        if (match) { const [key, pending] = match; clearTimeout(pending.timer); this.pending.delete(key); pending.resolve(pending.chunks.join('')); }
      }
    }
  }
  private fail(error: Error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  close() { this.socket?.destroy(); this.socket = undefined; this.fail(new Error('RCON session closed.')); }
}

/** Small SNBT reader for vanilla `data get` output (compound/list, typed arrays, strings, numeric suffixes). */
export function parseSnbt(source: string): any {
  let offset = 0;
  const white = () => { while (/\s/u.test(source[offset] || '') && offset < source.length) offset += 1; };
  function quoted() {
    const quote = source[offset++]; let value = '';
    while (offset < source.length) {
      const character = source[offset++];
      if (character === quote) return value;
      if (character === '\\') { if (offset >= source.length) throw new Error('Invalid SNBT escape.'); value += source[offset++]; } else value += character;
    }
    throw new Error('Unterminated SNBT string.');
  }
  function value(): any {
    white(); const character = source[offset];
    if (character === '"' || character === "'") return quoted();
    if (character === '{') {
      offset += 1; const result: Record<string, unknown> = Object.create(null); white();
      while (source[offset] !== '}') {
        white(); let key: string;
        if (source[offset] === '"' || source[offset] === "'") key = quoted();
        else { const start = offset; while (offset < source.length && !/[:\s]/u.test(source[offset])) offset += 1; key = source.slice(start, offset); }
        white(); if (!key || source[offset++] !== ':') throw new Error('Invalid SNBT compound.');
        result[key] = value(); white(); if (source[offset] === ',') offset += 1; else if (source[offset] !== '}') throw new Error('Invalid SNBT compound separator.');
      }
      offset += 1; return result;
    }
    if (character === '[') {
      offset += 1; white(); if (/^[BIL];/iu.test(source.slice(offset, offset + 2))) offset += 2;
      const result: unknown[] = []; white();
      while (source[offset] !== ']') { result.push(value()); white(); if (source[offset] === ',') offset += 1; else if (source[offset] !== ']') throw new Error('Invalid SNBT list.'); }
      offset += 1; return result;
    }
    const start = offset;
    while (offset < source.length && !/[\s,}\]]/u.test(source[offset])) offset += 1;
    const bare = source.slice(start, offset);
    if (!bare) throw new Error('Invalid SNBT value.');
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[bBsSlLfFdD]?$/u.test(bare)) return Number(bare.replace(/[bBsSlLfFdD]$/u, ''));
    if (bare === 'true') return true; if (bare === 'false') return false;
    return bare;
  }
  const result = value(); white(); if (offset !== source.length) throw new Error('Trailing SNBT data.'); return result;
}
