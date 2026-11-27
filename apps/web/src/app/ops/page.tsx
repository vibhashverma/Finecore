"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, useReauth, useSession } from "@/components/session";
import {
  Card,
  Empty,
  ErrorState,
  Loading,
  Money,
  secondaryButton,
  StatusBadge,
} from "@/components/ui";
import { apiCall } from "@/lib/api";

interface Alert {
  id: string;
  kind: string;
  status: string;
  score: string;
  reasons: Array<{ code: string; detail: string }>;
  amount_minor: string | null;
  currency: string | null;
  transfer_status: string | null;
}
interface Settlement {
  id: string;
  provider_payout_id: string;
  currency: string;
  expected_minor: string;
  actual_minor: string | null;
  status: string;
}

const NEXT: Record<string, string[]> = {
  NEW: ["INVESTIGATING"],
  INVESTIGATING: ["CLEARED", "ESCALATED"],
};

function Ops() {
  const s = useSession();
  const qc = useQueryClient();
  const withReauth = useReauth();
  const canAct = s.roles.includes("OPS");
  const isFinance = s.roles.includes("FINANCE");
  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: async () => apiCall<Alert[]>("/risk-alerts?limit=100"),
  });
  const settlements = useQuery({
    queryKey: ["settlements"],
    queryFn: async () => (await apiCall<Settlement[]>("/settlements?limit=100")).data,
  });
  const move = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) =>
      apiCall(`/risk-alerts/${id}/transition`, {
        method: "POST",
        body: { to, note: `${to} by analyst` },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
  const resolve = useMutation({
    mutationFn: (st: Settlement) =>
      withReauth(() =>
        apiCall(`/settlements/${st.id}/resolve`, {
          method: "POST",
          body: { recovered_minor: "0", note: "Reviewed and closed from the console" },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settlements"] }),
  });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Risk alerts">
        <p className="mb-2 text-sm text-slate-700">
          {String(
            alerts.data?.meta.disclaimer ?? "Risk scores are decision support, not proof of fraud.",
          )}
        </p>
        {move.error ? <ErrorState error={move.error} /> : null}
        {alerts.isPending ? (
          <Loading />
        ) : alerts.error ? (
          <ErrorState error={alerts.error} />
        ) : alerts.data.data.length === 0 ? (
          <Empty>No alerts.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {alerts.data.data.map((a) => (
              <li key={a.id} className="py-2 text-sm">
                <div className="flex justify-between">
                  <span>
                    {a.kind} · score {a.score}{" "}
                    {a.amount_minor && a.currency && (
                      <Money minor={a.amount_minor} currency={a.currency} />
                    )}
                  </span>
                  <StatusBadge status={a.status} />
                </div>
                <ul className="ml-4 list-disc text-slate-700">
                  {a.reasons.map((r) => (
                    <li key={r.code}>{r.detail}</li>
                  ))}
                </ul>
                {canAct && (
                  <div className="mt-1 flex gap-1">
                    {(NEXT[a.status] ?? []).map((to) => (
                      <button
                        key={to}
                        type="button"
                        className={secondaryButton}
                        onClick={() => move.mutate({ id: a.id, to })}
                      >
                        {to.toLowerCase()}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Settlements">
        {resolve.error ? <ErrorState error={resolve.error} /> : null}
        {settlements.isPending ? (
          <Loading />
        ) : settlements.error ? (
          <ErrorState error={settlements.error} />
        ) : settlements.data.length === 0 ? (
          <Empty>No settlements yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Provider settlements</caption>
            <thead>
              <tr className="text-left text-slate-600">
                <th scope="col">Payout</th>
                <th scope="col">Expected</th>
                <th scope="col">Received</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {settlements.data.map((st) => (
                <tr key={st.id} className="border-t border-slate-100">
                  <td>{st.provider_payout_id.slice(0, 14)}</td>
                  <td>
                    <Money minor={st.expected_minor} currency={st.currency} />
                  </td>
                  <td>
                    {st.actual_minor ? (
                      <Money minor={st.actual_minor} currency={st.currency} />
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>
                    <StatusBadge status={st.status} />
                    {isFinance && ["MISMATCHED", "FAILED"].includes(st.status) && (
                      <button
                        type="button"
                        className={`${secondaryButton} ml-1`}
                        onClick={() => resolve.mutate(st)}
                      >
                        resolve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

export default function OpsPage() {
  return (
    <AppShell roles={["OPS", "FINANCE"]}>
      <h1 className="mb-4 text-2xl font-bold">Operations</h1>
      <Ops />
    </AppShell>
  );
}
