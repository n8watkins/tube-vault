// Chrome Native Messaging wire format: 4-byte LE uint32 length + UTF-8 JSON body

// Once Chrome closes the port (extension reloaded, browser closed) further writes
// fail with EPIPE. Stop writing instead of crashing, so a running download still
// finishes or is cancelled through its job owner record like before.
let outputClosed = false;
process.stdout.on('error', () => { outputClosed = true; });

export function writeMessage(obj: unknown): void {
  if (outputClosed) return;
  const json = JSON.stringify(obj);
  const len = Buffer.byteLength(json, 'utf8');
  const buf = Buffer.allocUnsafe(4 + len);
  buf.writeUInt32LE(len, 0);
  buf.write(json, 4, 'utf8');
  process.stdout.write(buf);
}

export function readMessages(onMessage: (msg: unknown) => Promise<void>): void {
  let buf = Buffer.alloc(0);

  process.stdin.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const json = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      try {
        onMessage(JSON.parse(json)).catch((err: unknown) => {
          writeMessage({ ok: false, status: 'failed', error: String(err) });
        });
      } catch {
        // skip malformed JSON
      }
    }
  });

  process.stdin.resume();
}
