import { parentPort, workerData } from 'node:worker_threads';
import { unzipSync, strFromU8 } from 'fflate';
const unescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_m, v) =>
      String.fromCodePoint(v[0] === 'x' ? parseInt(v.slice(1), 16) : Number(v)),
    );
async function parse() {
  const { extension, data } = workerData,
    bytes = Uint8Array.from(Buffer.from(data, 'base64'));
  let text = '';
  let bodyLength = 0;
  if (extension === '.pdf') {
    const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdf.getDocument({
      data: bytes,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
    });
    const doc = await task.promise;
    try {
      if (doc.numPages > 2000) throw Error('PDF 页数超过2000');
      for (let page = 1; page <= doc.numPages; page++) {
        const p = await doc.getPage(page),
          content = await p.getTextContent();
        const body = content.items
          .map((item: any) => item.str + (item.hasEOL ? '\n' : ' '))
          .join('');
        bodyLength += body.trim().length;
        text += `\n\n## 第 ${page} 页\n` + body;
        p.cleanup();
        if (text.length > 16000000) throw Error('解析文本超过16M字符');
      }
    } finally {
      await task.destroy();
    }
  } else {
    let size = 0;
    const files = unzipSync(bytes, {
      filter: (file) => {
        const use =
          /^(word\/document|ppt\/slides\/slide\d+|xl\/sharedStrings|xl\/worksheets\/sheet\d+)\.xml$/.test(
            file.name,
          );
        if (use) {
          size += file.originalSize;
          if (size > 64000000) throw Error('Office 解压后正文超过64MB');
        }
        return use;
      },
    });
    const shared = files['xl/sharedStrings.xml']
      ? [
          ...strFromU8(files['xl/sharedStrings.xml']).matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g),
        ].map((m) =>
          unescape([...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')),
        )
      : [];
    for (const name of Object.keys(files).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    )) {
      const xml = strFromU8(files[name]);
      if (name === 'xl/sharedStrings.xml') continue;
      if (name.startsWith('xl/worksheets/')) {
        const body = [...xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)]
          .map((row) =>
            [...row[1].matchAll(/<c(\s[^>]*)?>([\s\S]*?)<\/c>/g)]
              .map((c) => {
                const value = c[2].match(/<v>([\s\S]*?)<\/v>/)?.[1];
                return /\bt="s"/.test(c[1] ?? '')
                  ? (shared[Number(value)] ?? '')
                  : unescape(
                      value ??
                        [...c[2].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
                          .map((t) => t[1])
                          .join(''),
                    );
              })
              .join('\t'),
          )
          .join('\n');
        bodyLength += body.trim().length;
        text += `\n\n## ${name}\n` + body;
        continue;
      }
      const body = unescape(
        xml
          .replace(/<\/(?:w:p|a:p|row)>/g, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/[ \t]+/g, ' '),
      );
      bodyLength += body.trim().length;
      text += `\n\n## ${name}\n` + body;
    }
  }
  if (!bodyLength) throw Error('没有可提取正文；扫描件需要可选视觉/OCR提供方');
  if (text.length > 16000000) throw Error('解析文本超过16M字符');
  return { text };
}
parse().then(
  (result) => parentPort!.postMessage({ result }),
  (e) => parentPort!.postMessage({ error: e instanceof Error ? e.message : '解析失败' }),
);
