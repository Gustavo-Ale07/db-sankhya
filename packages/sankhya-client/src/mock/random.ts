/** Small deterministic PRNG (mulberry32) so demo data is stable across restarts. */
export function createRandom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min: number, max: number): number {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from empty list');
      return item;
    },
    chance(p: number): boolean {
      return next() < p;
    },
    money(min: number, max: number): number {
      return Math.round((min + next() * (max - min)) * 100) / 100;
    },
  };
}

export type Random = ReturnType<typeof createRandom>;

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** Formats a UTC date as dd/mm/aaaa. */
export function fakeDate(d: Date): string {
  return `${pad(d.getUTCDate(), 2)}/${pad(d.getUTCMonth() + 1, 2)}/${d.getUTCFullYear()}`;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/**
 * Builds a CNPJ-shaped string whose check digits are deliberately WRONG, so it
 * can never collide with a real company registration.
 */
export function fakeCnpj(rand: Random): string {
  const digits = Array.from({ length: 12 }, () => rand.int(0, 9));
  digits[8] = 0;
  digits[9] = 0;
  digits[10] = 0;
  digits[11] = 1;
  const valid = cnpjCheckDigits(digits);
  const d1 = (valid[0] + 1) % 10;
  const d2 = (valid[1] + 3) % 10;
  const s = [...digits, d1, d2].join('');
  return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}`;
}

export function cnpjCheckDigits(base12: number[]): [number, number] {
  const calc = (nums: number[], weights: number[]) => {
    const sum = nums.reduce((acc, n, i) => acc + n * (weights[i] ?? 0), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = calc(base12, w1);
  const d2 = calc([...base12, d1], w2);
  return [d1, d2];
}

/** EAN-13 in the 200â€“299 "restricted circulation" range, never assigned to real products. */
export function fakeEan(rand: Random): string {
  const body =
    `2${rand.int(0, 9)}${rand.int(0, 9)}` +
    Array.from({ length: 9 }, () => rand.int(0, 9)).join('');
  const sum = body.split('').reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
  return body + String((10 - (sum % 10)) % 10);
}
