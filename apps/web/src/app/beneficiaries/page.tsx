"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { AppShell, useReauth } from "@/components/session";
import {
  buttonClass,
  Card,
  Empty,
  ErrorState,
  Field,
  inputClass,
  Loading,
  secondaryButton,
} from "@/components/ui";
import { apiCall } from "@/lib/api";
import type { Beneficiary } from "@/lib/types";

const schema = z.object({
  account_number: z.string().regex(/^FC\d{10}$/, "Format: FC followed by 10 digits"),
  nickname: z.string().trim().min(1, "Enter a nickname").max(60),
});

export default function BeneficiariesPage() {
  const qc = useQueryClient();
  const withReauth = useReauth;
  return (
    <AppShell roles={["CUSTOMER"]}>
      <h1 className="mb-4 text-2xl font-bold">Beneficiaries</h1>
      <Inner qc={qc} useWithReauth={withReauth} />
    </AppShell>
  );
}

function Inner({
  qc,
  useWithReauth,
}: {
  qc: ReturnType<typeof useQueryClient>;
  useWithReauth: typeof useReauth;
}) {
  const withReauth = useWithReauth();
  const list = useQuery({
    queryKey: ["beneficiaries"],
    queryFn: async () => (await apiCall<Beneficiary[]>("/beneficiaries?limit=100")).data,
  });
  const [form, setForm] = useState({ account_number: "", nickname: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const add = useMutation({
    // Adding a beneficiary is a sensitive action: the API demands step-up; the dialog handles it.
    mutationFn: (body: z.infer<typeof schema>) =>
      withReauth(() => apiCall("/beneficiaries", { method: "POST", body })),
    onSuccess: () => {
      setForm({ account_number: "", nickname: "" });
      void qc.invalidateQueries({ queryKey: ["beneficiaries"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiCall(`/beneficiaries/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["beneficiaries"] }),
  });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Add beneficiary">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const v = schema.safeParse(form);
            if (!v.success)
              return setErrors(
                Object.fromEntries(v.error.issues.map((i) => [String(i.path[0]), i.message])),
              );
            setErrors({});
            add.mutate(v.data);
          }}
        >
          <Field label="FinCore account number" id="account_number" error={errors.account_number}>
            <input
              id="account_number"
              className={inputClass}
              value={form.account_number}
              onChange={(e) => setForm({ ...form, account_number: e.target.value.toUpperCase() })}
              aria-invalid={!!errors.account_number}
            />
          </Field>
          <Field label="Nickname" id="nickname" error={errors.nickname}>
            <input
              id="nickname"
              className={inputClass}
              value={form.nickname}
              onChange={(e) => setForm({ ...form, nickname: e.target.value })}
              aria-invalid={!!errors.nickname}
            />
          </Field>
          {add.error ? <ErrorState error={add.error} /> : null}
          <button type="submit" className={buttonClass} disabled={add.isPending}>
            Add beneficiary
          </button>
        </form>
      </Card>
      <Card title="Saved beneficiaries">
        {list.isPending ? (
          <Loading />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : list.data.length === 0 ? (
          <Empty>No beneficiaries yet.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.map((b) => (
              <li key={b.id} className="flex items-center justify-between py-2">
                <span>
                  {b.nickname} <span className="text-sm text-slate-600">{b.account_number}</span>
                </span>
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => remove.mutate(b.id)}
                  aria-label={`Remove ${b.nickname}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
