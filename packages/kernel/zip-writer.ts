import { open, type FileHandle } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

/** Stored ZIP64 archive: bounded-memory output, including originals above 4 GiB. */
export class ZipWriter {
  private offset = 0n;
  private entries: { name: Buffer; size: bigint; crc: number; offset: bigint }[] = [];
  private constructor(private output: FileHandle) {}
  static async create(path: string) {
    return new ZipWriter(await open(path, 'wx'));
  }
  private async write(data: Uint8Array) {
    let pos = 0;
    while (pos < data.length) {
      const { bytesWritten } = await this.output.write(data, pos, data.length - pos);
      if (!bytesWritten) throw Error('ZIP write stalled');
      pos += bytesWritten;
    }
    this.offset += BigInt(data.length);
  }
  async add(path: string, input: Uint8Array | AsyncIterable<Uint8Array>) {
    if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\\'))
      throw Error('Unsafe ZIP entry');
    const name = Buffer.from(path),
      offset = this.offset;
    if (name.length > 65535 || this.entries.some((e) => e.name.equals(name)))
      throw Error('Invalid ZIP entry');
    const header = Buffer.alloc(30),
      extra = Buffer.alloc(20);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(45, 4);
    header.writeUInt16LE(0x808, 6);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(0xffffffff, 18);
    header.writeUInt32LE(0xffffffff, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    extra.writeUInt16LE(1);
    extra.writeUInt16LE(16, 2);
    await this.write(header);
    await this.write(name);
    await this.write(extra);
    let size = 0n,
      crc = 0;
    const chunk = async (data: Uint8Array) => {
      size += BigInt(data.length);
      crc = crc32(data, crc);
      await this.write(data);
    };
    if (input instanceof Uint8Array) await chunk(input);
    else for await (const data of input) await chunk(data);
    const descriptor = Buffer.alloc(24);
    descriptor.writeUInt32LE(0x08074b50);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeBigUInt64LE(size, 8);
    descriptor.writeBigUInt64LE(size, 16);
    await this.write(descriptor);
    this.entries.push({ name, size, crc, offset });
  }
  async finish() {
    const start = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46),
        extra = Buffer.alloc(28);
      header.writeUInt32LE(0x02014b50);
      header.writeUInt16LE(45, 4);
      header.writeUInt16LE(45, 6);
      header.writeUInt16LE(0x808, 8);
      header.writeUInt16LE(0x21, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(0xffffffff, 20);
      header.writeUInt32LE(0xffffffff, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt32LE(0xffffffff, 42);
      extra.writeUInt16LE(1);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(entry.size, 4);
      extra.writeBigUInt64LE(entry.size, 12);
      extra.writeBigUInt64LE(entry.offset, 20);
      await this.write(header);
      await this.write(entry.name);
      await this.write(extra);
    }
    const centralSize = this.offset - start,
      endOffset = this.offset,
      end = Buffer.alloc(56),
      locator = Buffer.alloc(20),
      footer = Buffer.alloc(22),
      count = BigInt(this.entries.length);
    end.writeUInt32LE(0x06064b50);
    end.writeBigUInt64LE(44n, 4);
    end.writeUInt16LE(45, 12);
    end.writeUInt16LE(45, 14);
    end.writeBigUInt64LE(count, 24);
    end.writeBigUInt64LE(count, 32);
    end.writeBigUInt64LE(centralSize, 40);
    end.writeBigUInt64LE(start, 48);
    locator.writeUInt32LE(0x07064b50);
    locator.writeBigUInt64LE(endOffset, 8);
    locator.writeUInt32LE(1, 16);
    footer.writeUInt32LE(0x06054b50);
    footer.writeUInt16LE(0xffff, 8);
    footer.writeUInt16LE(0xffff, 10);
    footer.writeUInt32LE(0xffffffff, 12);
    footer.writeUInt32LE(0xffffffff, 16);
    await this.write(end);
    await this.write(locator);
    await this.write(footer);
    await this.output.sync();
  }
  async close() {
    await this.output.close();
  }
}
