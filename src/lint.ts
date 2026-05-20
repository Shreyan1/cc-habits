import fs from 'fs';
import { readHabitsMd } from './storage';
import { lintFile, LintFinding } from './extractor';

export async function lintPath(filePath: string): Promise<LintFinding[]> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`lint: file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const habitsMd = readHabitsMd();
  return lintFile(filePath, content, habitsMd);
}

export type { LintFinding };
