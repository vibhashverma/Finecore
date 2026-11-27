/** PII masking for staff views and logs (brief §11). */
export const maskAccountNumber = (n: string) => `••••${n.slice(-4)}`;

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

export function maskName(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => (p.length <= 1 ? p : `${p[0]}${"•".repeat(Math.min(p.length - 1, 4))}`))
    .join(" ");
}
