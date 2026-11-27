"use client";

import type { ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/money";

const BADGE: Record<string, string> = {
  POSTED: "bg-green-100 text-green-900",
  SUCCEEDED: "bg-green-100 text-green-900",
  MATCHED: "bg-green-100 text-green-900",
  CLEARED: "bg-green-100 text-green-900",
  PENDING: "bg-amber-100 text-amber-900",
  PROCESSING: "bg-amber-100 text-amber-900",
  REQUIRES_CONFIRMATION: "bg-amber-100 text-amber-900",
  OPEN: "bg-amber-100 text-amber-900",
  UNDER_REVIEW: "bg-amber-100 text-amber-900",
  INVESTIGATING: "bg-amber-100 text-amber-900",
  NEW: "bg-blue-100 text-blue-900",
  FAILED: "bg-red-100 text-red-900",
  ESCALATED: "bg-red-100 text-red-900",
  MISMATCHED: "bg-red-100 text-red-900",
  REVERSED: "bg-slate-200 text-slate-900",
};

/** Transaction/state badge: colour plus the state name as text (never colour alone, WCAG 1.4.1). */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${BADGE[status] ?? "bg-slate-100 text-slate-900"}`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}

export function Money({ minor, currency }: { minor: string; currency: string }) {
  return <span className="tabular-nums">{formatMoney(minor, currency)}</span>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" aria-live="polite" className="py-4 text-slate-600">
      {label}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded border border-dashed border-slate-300 p-4 text-slate-600">{children}</p>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const e = error instanceof ApiError ? error : null;
  return (
    <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-red-900">
      <p className="font-semibold">{e?.message ?? "Something went wrong."}</p>
      {e?.details?.map((d) => (
        <p key={`${d.path}-${d.message}`} className="text-sm">
          {d.path ? `${d.path}: ` : ""}
          {d.message}
        </p>
      ))}
      {e?.requestId && <p className="mt-1 text-xs">Reference: {e.requestId}</p>}
    </div>
  );
}

export function Card({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section
      aria-labelledby={title.replaceAll(" ", "-")}
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id={title.replaceAll(" ", "-")} className="text-lg font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Field({
  label,
  id,
  error,
  children,
}: {
  label: string;
  id: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="mb-3">
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export const inputClass =
  "w-full rounded border border-slate-400 px-3 py-2 focus-visible:outline-blue-700";
export const buttonClass =
  "rounded bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800 disabled:opacity-50";
export const secondaryButton =
  "rounded border border-slate-400 px-3 py-1.5 text-sm font-medium hover:bg-slate-100";
