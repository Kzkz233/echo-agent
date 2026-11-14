/** Bounded normalized WAV input; shared by detection and ASR cropping. */
export function pcm16(wav: Buffer) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE')
    throw Error('Speech detection requires normalized WAV audio');
  let pcm: Buffer | undefined,
    format = false;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString('ascii', offset, offset + 4),
      bytes = wav.readUInt32LE(offset + 4),
      start = offset + 8;
    if (start + bytes > wav.length) throw Error('Incomplete WAV input');
    if (name === 'fmt ')
      format =
        bytes >= 16 &&
        wav.readUInt16LE(start) === 1 &&
        wav.readUInt16LE(start + 2) === 1 &&
        wav.readUInt32LE(start + 4) === 16000 &&
        wav.readUInt16LE(start + 14) === 16;
    if (name === 'data') pcm = wav.subarray(start, start + bytes);
    offset = start + bytes + (bytes % 2);
  }
  if (!format || !pcm?.length || pcm.length % 2 || pcm.length > 16000 * 2 * 61)
    throw Error('Speech detection requires bounded mono 16 kHz PCM16');
  return pcm;
}
export function wave(pcm: Buffer) {
  const head = Buffer.alloc(44);
  head.write('RIFF');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}
export function cropWave(wav: Buffer, start: number, end: number) {
  const pcm = pcm16(wav),
    from = Math.max(0, Math.floor(start * 16000)) * 2,
    to = Math.min(pcm.length, Math.ceil(end * 16000) * 2);
  if (to <= from) throw Error('Empty speech range');
  return wave(pcm.subarray(from, to));
}
