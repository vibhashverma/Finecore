"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { z } from "zod";
import { buttonClass, ErrorState, Field, inputClass } from "@/components/ui";
import { apiCall } from "@/lib/api";

const credentials = z.object({
  email: z.email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [step, setStep] = useState<"password" | "mfa">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    const v = credentials.safeParse({ email, password });
    if (!v.success) {
      setFieldErrors(Object.fromEntries(v.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setFieldErrors({});
    setBusy(true);
    setError(null);
    try {
      const r = await apiCall<{ challenge_id: string }>("/auth/login", {
        method: "POST",
        body: v.data,
      });
      setChallenge(r.data.challenge_id);
      setStep("mfa");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setFieldErrors({ code: "Enter the 6-digit code" });
    setBusy(true);
    setError(null);
    try {
      await apiCall("/auth/mfa/verify", {
        method: "POST",
        body: { challenge_id: challenge, code },
      });
      const s = await apiCall<{ roles: string[] }>("/auth/session");
      const staffHome =
        s.data.roles.includes("OPS") || s.data.roles.includes("FINANCE")
          ? "/ops"
          : s.data.roles.includes("ADMIN")
            ? "/audit"
            : s.data.roles.includes("SUPPORT")
              ? "/disputes"
              : "/dashboard";
      router.replace(next?.startsWith("/") && !next.startsWith("//") ? next : staffHome);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="mx-auto max-w-sm px-4 py-12">
      <h1 className="mb-6 text-2xl font-bold">Sign in</h1>
      {step === "password" ? (
        <form onSubmit={submitPassword} noValidate>
          <Field label="Email" id="email" error={fieldErrors.email}>
            <input
              id="email"
              type="email"
              autoComplete="username"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={!!fieldErrors.email}
              aria-describedby={fieldErrors.email ? "email-error" : undefined}
            />
          </Field>
          <Field label="Password" id="password" error={fieldErrors.password}>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className={inputClass}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!fieldErrors.password}
            />
          </Field>
          {error ? <ErrorState error={error} /> : null}
          <button type="submit" className={`${buttonClass} mt-2 w-full`} disabled={busy}>
            {busy ? "Signing in…" : "Continue"}
          </button>
          <p className="mt-4 text-sm">
            No account?{" "}
            <Link href="/register" className="text-blue-800 underline">
              Register
            </Link>
          </p>
        </form>
      ) : (
        <form onSubmit={submitCode} noValidate>
          <p className="mb-4 text-sm text-slate-700">
            Enter the code from your authenticator app (SIMULATED MFA; demo users share a documented
            test secret).
          </p>
          <Field label="6-digit code" id="code" error={fieldErrors.code}>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              className={inputClass}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              aria-invalid={!!fieldErrors.code}
            />
          </Field>
          {error ? <ErrorState error={error} /> : null}
          <button type="submit" className={`${buttonClass} mt-2 w-full`} disabled={busy}>
            {busy ? "Verifying…" : "Verify"}
          </button>
        </form>
      )}
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
