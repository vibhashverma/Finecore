"use client";

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiCall, ApiError } from "@/lib/api";
import { buttonClass, ErrorState, Field, inputClass, Loading, secondaryButton } from "./ui";

export interface Session {
  user_id: string;
  roles: string[];
  customer_id: string | null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
            staleTime: 5_000,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const NAV: Array<{ href: string; label: string; roles: string[] }> = [
  { href: "/dashboard", label: "Dashboard", roles: ["CUSTOMER"] },
  { href: "/transfers", label: "Transfers", roles: ["CUSTOMER"] },
  { href: "/beneficiaries", label: "Beneficiaries", roles: ["CUSTOMER"] },
  { href: "/topup", label: "Top up", roles: ["CUSTOMER"] },
  { href: "/disputes", label: "Disputes", roles: ["CUSTOMER", "SUPPORT", "FINANCE"] },
  { href: "/statements", label: "Statements", roles: ["CUSTOMER"] },
  { href: "/ops", label: "Operations", roles: ["OPS", "FINANCE"] },
  { href: "/audit", label: "Audit log", roles: ["OPS", "FINANCE", "ADMIN"] },
];

// ---- Step-up reauthentication (sensitive actions) -------------------------------------------------------------
type Reauth = <T>(action: () => Promise<T>) => Promise<T>;
const ReauthContext = createContext<Reauth>((a) => a());
export const useReauth = () => useContext(ReauthContext);

function ReauthDialog({ onDone }: { onDone: (ok: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(null);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal(); // native modal: focus trap + Esc handled by the browser
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="reauth-title"
      className="w-full max-w-sm rounded-lg p-6 backdrop:bg-black/40"
      onCancel={() => onDone(false)}
    >
      <h2 id="reauth-title" className="mb-2 text-lg font-semibold">
        Confirm it&apos;s you
      </h2>
      <p className="mb-4 text-sm text-slate-700">
        This action needs your password and a fresh code from your authenticator (SIMULATED MFA).
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apiCall("/auth/reauth", { method: "POST", body: { password, code } }).then(
            () => onDone(true),
            setError,
          );
        }}
      >
        <Field label="Password" id="reauth-password">
          <input
            id="reauth-password"
            type="password"
            autoComplete="current-password"
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <Field label="6-digit code" id="reauth-code">
          <input
            id="reauth-code"
            inputMode="numeric"
            pattern="\d{6}"
            autoComplete="one-time-code"
            className={inputClass}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
        </Field>
        {error ? <ErrorState error={error} /> : null}
        <div className="mt-4 flex gap-2">
          <button type="submit" className={buttonClass}>
            Confirm
          </button>
          <button type="button" className={secondaryButton} onClick={() => onDone(false)}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

// ---- Authenticated shell -------------------------------------------------------------------------------------
const SessionContext = createContext<Session | null>(null);
export const useSession = () => {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside AppShell");
  return s;
};

export function AppShell({ children, roles }: { children: ReactNode; roles?: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: async () => (await apiCall<Session>("/auth/session")).data,
  });
  const [pending, setPending] = useState<((ok: boolean) => void) | null>(null);

  const withReauth: Reauth = useCallback(async (action) => {
    try {
      return await action();
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== "REAUTH_REQUIRED") throw e;
      const ok = await new Promise<boolean>((resolve) => setPending(() => resolve));
      setPending(null);
      if (!ok) throw e;
      return action(); // retried with the SAME idempotency key captured by the caller
    }
  }, []);

  useEffect(() => {
    if (session.error instanceof ApiError && session.error.status === 401)
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [session.error, router, pathname]);

  if (session.isPending) return <Loading label="Checking your session…" />;
  if (!session.data) return <ErrorState error={session.error} />;
  const s = session.data;
  const allowed = !roles || s.roles.some((r) => roles.includes(r));

  return (
    <SessionContext.Provider value={s}>
      <ReauthContext.Provider value={withReauth}>
        <header className="border-b border-slate-200 bg-white">
          <nav
            aria-label="Main"
            className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-4 py-2"
          >
            <span className="mr-4 font-bold">FinCore</span>
            {NAV.filter((n) => s.roles.some((r) => n.roles.includes(r))).map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={pathname === n.href ? "page" : undefined}
                className="rounded px-3 py-2 text-sm hover:bg-slate-100 aria-[current=page]:bg-slate-200 aria-[current=page]:font-semibold"
              >
                {n.label}
              </Link>
            ))}
            <span className="ml-auto text-xs text-slate-600">{s.roles.join(", ")}</span>
            <button
              type="button"
              className={`${secondaryButton} ml-2`}
              onClick={() => {
                void apiCall("/auth/logout", { method: "POST" }).finally(() => {
                  qc.clear();
                  router.replace("/login");
                });
              }}
            >
              Sign out
            </button>
          </nav>
        </header>
        <main id="main" className="mx-auto max-w-6xl px-4 py-6">
          {allowed ? (
            children
          ) : (
            <ErrorState
              error={new ApiError(403, "FORBIDDEN", "You do not have access to this page.")}
            />
          )}
        </main>
        {pending && <ReauthDialog onDone={pending} />}
      </ReauthContext.Provider>
    </SessionContext.Provider>
  );
}
