"use client";

import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/session";
import { Card, ErrorState, Loading, StatusBadge } from "@/components/ui";
import { apiCall } from "@/lib/api";

interface AuditRow {
  chain_seq: string;
  occurred_at: string;
  action: string;
  outcome: string;
  resource_type: string | null;
  request_id: string | null;
}

export default function AuditPage() {
  return (
    <AppShell roles={["OPS", "FINANCE", "ADMIN"]}>
      <h1 className="mb-4 text-2xl font-bold">Audit log</h1>
      <Audit />
    </AppShell>
  );
}

function Audit() {
  const q = useQuery({
    queryKey: ["audit"],
    queryFn: () => apiCall<AuditRow[]>("/audit-log?limit=100"),
  });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <Card title="Recent events">
      <p className="mb-2 text-sm" role="status">
        Hash chain: <StatusBadge status={q.data.meta.chain_intact ? "MATCHED" : "FAILED"} />{" "}
        {q.data.meta.chain_intact ? "intact" : "TAMPERING DETECTED"}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Audit events, newest first</caption>
          <thead>
            <tr className="text-left text-slate-600">
              <th scope="col">#</th>
              <th scope="col">Time</th>
              <th scope="col">Action</th>
              <th scope="col">Outcome</th>
              <th scope="col">Request</th>
            </tr>
          </thead>
          <tbody>
            {q.data.data.map((r) => (
              <tr key={r.chain_seq} className="border-t border-slate-100">
                <td>{r.chain_seq}</td>
                <td>{new Date(r.occurred_at).toLocaleString()}</td>
                <td>{r.action}</td>
                <td>
                  <StatusBadge status={r.outcome === "ALLOWED" ? "POSTED" : "FAILED"} />{" "}
                  <span className="sr-only">{r.outcome}</span>
                </td>
                <td className="font-mono text-xs">{r.request_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
