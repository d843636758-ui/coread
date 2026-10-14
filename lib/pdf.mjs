import { PDFParse } from 'pdf-parse';
import { smartSplit } from './epub.mjs';

function badPdf(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.status = 400;
  return error;
}

export async function parsePdf(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
  if (!buffer.length) throw badPdf('PDF 文件为空');
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw badPdf('文件不是有效的 PDF');
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = String(result?.text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\f/g, '\n\n')
      .replace(/^-- \d+ of \d+ --$/gm, '')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    if (!text) {
      throw badPdf('PDF 中没有可提取的文字；扫描版 PDF 请先进行 OCR');
    }
    return smartSplit(text);
  } catch (error) {
    if (error?.status === 400) throw error;
    throw badPdf(`PDF 解析失败：${error?.message || '文件可能已损坏或受到密码保护'}`, error);
  } finally {
    await parser.destroy().catch(() => {});
  }
}
