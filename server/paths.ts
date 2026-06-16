import path from 'node:path';

export function getDataPath(...parts: string[]): string {
  return path.join(process.env.DATA_DIR || path.resolve(process.cwd(), '.data'), ...parts);
}
