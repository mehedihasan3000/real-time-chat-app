export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
}

export interface SecretScanResult {
  findings: SecretFinding[];
  filesChecked: number;
}

export function scanText(text: string, file?: string): SecretFinding[];
export function scanRepository(options?: { cwd?: string }): SecretScanResult;
