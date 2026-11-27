"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell, useReauth, useSession } from "@/components/session";
import {
  buttonClass,
  Card,
  Empty,
  ErrorState,
  Field,
  inputClass,
  Loading,
  Money,
  secondaryButton,
  StatusBadge,
} from "@/components/ui";
import { apiCall } from "@/lib/api";
import type { Transfer } from "@/lib/types";

interface Dispute {
  id: string;
  transfer_id: string;
  amount_minor: string;
  currency: string;
  reason: string;
  status: string;
}

const NEXT: Record<string, string[]> = {
  OPEN: ["UNDER_REVIEW"],
  UNDER_REVIEW: ["RESOLVED_CUSTOMER", "RESOLVED_MERCHANT", "REJECTED"],
};

function Disputes() {
  const s = useSession();
  const qc = useQueryClient();
  const withReauth = useReauth();
  const isCustomer = s.roles.includes("CUSTOMER");
  const canResolve = s.roles.some((r) => r === "SUPPORT" || r === "FINANCE");
  const list = useQuery({
    queryKey: ["disputes"],
    queryFn: async () => (await apiCall<Dispute[]>("/disputes?limit=100")).data,
  });
  const transfers = useQuery({
    queryKey: ["transfers"],
    enabled: isCustomer,
    queryFn: async () => (await apiCall<Transfer[]>("/transfers?status=POSTED&limit=100")).data,
  });
  const [form, setForm] = useState({ transfer_id: "", reason: "" });
  const create = useMutation({
    mutationFn: () => apiCall("/disputes", { method: "POST", body: form }),
    onSuccess: () => {
      setForm({ transfer_id: "", reason: "" });
      void qc.invalidateQueries({ queryKey: ["disputes"] });
    },
  });
  const move = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) =>
      withReauth(() =>
        apiCall(`/disputes/${id}/transition`, {
          method: "POST",
          body: { to, note: `Moved to ${to} via console` },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["disputes"] }),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {isCustomer && (
        <Card title="Raise a dispute">
          {transfers.isPending ? (
            <Loading />
          ) : (
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (form.transfer_id && form.reason.trim().length >= 3) create.mutate();
              }}
            >
              <Field label="Transfer" id="d-transfer">
                <select
                  id="d-transfer"
                  className={inputClass}
                  value={form.transfer_id}
                  onChange={(e) => setForm({ ...form, transfer_id: e.target.value })}
                >
                  <option value="">Select…</option>
                  {transfers.data?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {new Date(t.created_at).toLocaleDateString()} {t.amount_minor} {t.currency}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reason (at least 3 characters)" id="d-reason">
                <textarea
                  id="d-reason"
                  className={inputClass}
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                />
              </Field>
              {create.error ? <ErrorState error={create.error} /> : null}
              <button type="submit" className={buttonClass}>
                Submit dispute
              </button>
            </form>
          )}
        </Card>
      )}
      <Card title={canResolve ? "Dispute queue" : "Your disputes"}>
        {move.error ? <ErrorState error={move.error} /> : null}
        {list.isPending ? (
          <Loading />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : list.data.length === 0 ? (
          <Empty>No disputes.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.map((d) => (
              <li key={d.id} className="py-2">
                <div className="flex justify-between">
                  <Money minor={d.amount_minor} currency={d.currency} />{" "}
                  <StatusBadge status={d.status} />
                </div>
                <p className="text-sm text-slate-700">{d.reason}</p>
                {canResolve && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(NEXT[d.status] ?? []).map((to) => (
                      <button
                        key={to}
                        type="button"
                        className={secondaryButton}
                        onClick={() => move.mutate({ id: d.id, to })}
                      >
                        {to.replaceAll("_", " ").toLowerCase()}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function DisputesPage() {
  return (
    <AppShell roles={["CUSTOMER", "SUPPORT", "FINANCE"]}>
      <h1 className="mb-4 text-2xl font-bold">Disputes</h1>
      <Disputes />
    </AppShell>
  );
}
