"use client";

import Link from "next/link";
import { useState } from "react";
import { z } from "zod";
import { buttonClass, ErrorState, Field, inputClass } from "@/components/ui";
import { apiCall } from "@/lib/api";

const schema = z.object({
  full_name: z.string().trim().min(1, "Enter your name"),
  email: z.email("Enter a valid email"),
  password: z.string().min(12, "Use at least 12 characters"),
});

export default function RegisterPage() {
  const [form, setForm] = useState({ full_name: "", email: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [mfa, setMfa] = useState<{ secret: string; otpauth_url: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = schema.safeParse(form);
    if (!v.success)
      return setErrors(
        Object.fromEntries(v.error.issues.map((i) => [String(i.path[0]), i.message])),
      );
    setErrors({});
    try {
      const r = await apiCall<{ mfa: { secret: string; otpauth_url: string } }>("/auth/register", {
        method: "POST",
        body: v.data,
      });
      setMfa(r.data.mfa);
    } catch (err) {
      setError(err);
    }
  }

  if (mfa)
    return (
      <main id="main" className="mx-auto max-w-md px-4 py-12">
        <h1 className="mb-4 text-2xl font-bold">Set up your authenticator</h1>
        <p className="mb-2">
          Add this secret to an authenticator app (SIMULATED MFA). It is shown only once.
        </p>
        <p className="mb-4 rounded bg-slate-100 p-3 font-mono text-lg" data-testid="mfa-secret">
          {mfa.secret}
        </p>
        <Link href="/login" className={buttonClass}>
          Continue to sign in
        </Link>
      </main>
    );

  return (
    <main id="main" className="mx-auto max-w-sm px-4 py-12">
      <h1 className="mb-6 text-2xl font-bold">Create an account</h1>
      <form onSubmit={submit} noValidate>
        {(["full_name", "email", "password"] as const).map((k) => (
          <Field
            key={k}
            label={
              k === "full_name"
                ? "Full name (synthetic data only)"
                : k[0]?.toUpperCase() + k.slice(1)
            }
            id={k}
            error={errors[k]}
          >
            <input
              id={k}
              type={k === "password" ? "password" : k === "email" ? "email" : "text"}
              autoComplete={k === "password" ? "new-password" : k === "email" ? "username" : "name"}
              className={inputClass}
              value={form[k]}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              aria-invalid={!!errors[k]}
            />
          </Field>
        ))}
        {error ? <ErrorState error={error} /> : null}
        <button type="submit" className={`${buttonClass} w-full`}>
          Register
        </button>
      </form>
    </main>
  );
}
