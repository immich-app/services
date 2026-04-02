export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemVer(version: string): SemVer | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

export function isGreaterThan(a: string, b: string): boolean {
  const parsedA = parseSemVer(a);
  const parsedB = parseSemVer(b);
  if (!parsedA || !parsedB) {
    return false;
  }
  return compareSemVer(parsedA, parsedB) > 0;
}
