/**
 * Client-side mirror of the server password policy (the server remains authoritative):
 * 12+ characters and at least three of lower case, upper case, digits and symbols.
 */
export function passwordProblems(pw: string): string[] {
  const out: string[] = [];
  if (pw.length < 12) out.push('12+ caracteres');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) out.push('ao menos 3 tipos entre minúsculas, maiúsculas, números e símbolos');
  return out;
}
