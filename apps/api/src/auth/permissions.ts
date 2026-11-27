/** Role → permission matrix (brief §2). Enforced server-side by requirePermission(); tested against the brief. */
export type Role = "CUSTOMER" | "SUPPORT" | "OPS" | "FINANCE" | "ADMIN";

export const PERMISSIONS = {
  "self:manage": ["CUSTOMER"],
  "transfers:create": ["CUSTOMER"],
  "payments:create": ["CUSTOMER"],
  "customers:read": ["SUPPORT", "OPS", "FINANCE", "ADMIN"],
  "disputes:create": ["CUSTOMER", "SUPPORT"],
  "disputes:read_all": ["SUPPORT", "FINANCE"],
  "disputes:resolve": ["SUPPORT", "FINANCE"],
  "risk:read": ["OPS", "FINANCE"],
  "risk:action": ["OPS"],
  "reconciliation:read": ["OPS", "FINANCE"],
  "reconciliation:run": ["FINANCE"],
  "refunds:create": ["FINANCE"],
  "reversals:create": ["FINANCE"],
  "audit:read": ["OPS", "FINANCE", "ADMIN"],
  "admin:manage": ["ADMIN"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(roles: readonly string[], permission: Permission): boolean {
  const allowed: readonly string[] = PERMISSIONS[permission];
  return roles.some((r) => allowed.includes(r));
}

export const isStaff = (roles: readonly string[]) => roles.some((r) => r !== "CUSTOMER");
