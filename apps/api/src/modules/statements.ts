import { Router, type Response } from "express";
import { z } from "zod";
import { getAuth } from "../auth/middleware.js";
import type { Deps } from "../deps.js";
import { AppError } from "../lib/errors.js";
import { idParam, ok, parse, route } from "../lib/http.js";
import { loadWallet } from "./accounts.js";

export const statementQuery = z.object({
  wallet_id: z.uuid(),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM"),
});

interface Line {
  posted_at: Date;
  kind: string;
  description: string;
  direction: "DEBIT" | "CREDIT";
  amount_minor: bigint;
}

/** Signed delta for a credit-normal wallet: credits add, debits subtract. */
const signed = (l: Pick<Line, "direction" | "amount_minor">) =>
  l.direction === "CREDIT" ? l.amount_minor : -l.amount_minor;

/** Spreadsheet formula-injection guard for CSV exports (OWASP). */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function formatMinor(minor: bigint, exponent: number): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  if (exponent === 0) return `${neg ? "-" : ""}${abs}`;
  const s = abs.toString().padStart(exponent + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -exponent)}.${s.slice(-exponent)}`;
}

/** Minimal single-font PDF writer (no external dependency). Text only; enough for a statement export. */
export function simplePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (m) => `\\${m}`).replace(/[^\x20-\x7e]/g, "?");
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 50) pages.push(lines.slice(i, i + 50));
  const objs: string[] = [];
  const kids: number[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";
  let n = 4;
  for (const p of pages.length ? pages : [[]]) {
    const content = `BT /F1 9 Tf 40 800 Td 12 TL ${p.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    objs[n] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
    objs[n + 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${n} 0 R >>`;
    kids.push(n + 1);
    n += 2;
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out);
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
    .join("")}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export function statementsRouter(deps: Deps): Router {
  const r = Router();
  const reqId = (res: Response) => String(res.locals.requestId);

  async function linesFor(accountId: string, from: string, toExclusive: string) {
    return (
      await deps.db.query<Line>(
        `SELECT t.posted_at, t.kind, t.description, e.direction, e.amount_minor
         FROM ledger_entries e JOIN transactions t ON t.id = e.transaction_id
        WHERE e.account_id = $1 AND t.posted_at >= ($2::date)::timestamp AT TIME ZONE 'UTC' AND t.posted_at < ($3::date)::timestamp AT TIME ZONE 'UTC' ORDER BY e.id`,
        [accountId, from, toExclusive],
      )
    ).rows;
  }

  /** Generates (idempotently) the statement for a month; the current month is "to date". */
  r.get(
    "/statements",
    route(async (req, res) => {
      const q = parse(statementQuery, req.query);
      const { wallet } = await loadWallet(deps, res, q.wallet_id);
      const start = `${q.period}-01`;
      const monthEnd = new Date(
        Date.UTC(Number(q.period.slice(0, 4)), Number(q.period.slice(5, 7)), 0),
      );
      const today = new Date();
      if (new Date(`${start}T00:00:00Z`) > today)
        throw new AppError("VALIDATION_ERROR", "Statement period is in the future.", [
          { path: "period", message: "future" },
        ]);
      const end = (monthEnd < today ? monthEnd : today).toISOString().slice(0, 10);
      const endExclusive = new Date(new Date(`${end}T00:00:00Z`).getTime() + 86_400_000)
        .toISOString()
        .slice(0, 10);

      const opening =
        (
          await deps.db.query<{ v: bigint }>(
            `SELECT coalesce(sum(CASE e.direction WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END), 0)::bigint AS v
           FROM ledger_entries e JOIN transactions t ON t.id = e.transaction_id WHERE e.account_id = $1 AND t.posted_at < ($2::date)::timestamp AT TIME ZONE 'UTC'`,
            [wallet.account_id, start],
          )
        ).rows[0]?.v ?? 0n;
      const lines = await linesFor(wallet.account_id, start, endExclusive);
      const credits = lines
        .filter((l) => l.direction === "CREDIT")
        .reduce((s, l) => s + l.amount_minor, 0n);
      const debits = lines
        .filter((l) => l.direction === "DEBIT")
        .reduce((s, l) => s + l.amount_minor, 0n);
      const closing = opening + credits - debits;

      // Independent cross-check by the analytics service (Decimal). A disagreement is a defect: refuse to issue.
      try {
        const check = await deps.analytics.summarizeStatement(
          opening,
          lines.map((l) => ({ direction: l.direction, amount_minor: l.amount_minor })),
          reqId(res),
        );
        if (
          check.closing_minor !== closing ||
          check.total_credits_minor !== credits ||
          check.total_debits_minor !== debits
        ) {
          deps.logger.error(
            { request_id: reqId(res), wallet_id: wallet.id },
            "statement cross-check mismatch",
          );
          throw new AppError("INTERNAL_ERROR", "Statement totals could not be verified.");
        }
      } catch (err) {
        if (err instanceof AppError && err.code === "INTERNAL_ERROR") throw err;
        deps.logger.warn(
          { request_id: reqId(res) },
          "statement cross-check skipped: analytics unavailable",
        );
      }

      // Statements are immutable snapshots (insert-only): reuse the snapshot if one with these entries exists.
      const cols =
        "id, wallet_id, period_start, period_end, opening_minor, closing_minor, total_credits_minor, total_debits_minor, entry_count, generated_at";
      const params = [
        wallet.id,
        start,
        end,
        opening.toString(),
        closing.toString(),
        credits.toString(),
        debits.toString(),
        lines.length,
      ];
      const st =
        (
          await deps.db.query(
            `INSERT INTO statements (wallet_id, period_start, period_end, opening_minor, closing_minor, total_credits_minor, total_debits_minor, entry_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING ${cols}`,
            params,
          )
        ).rows[0] ??
        (
          await deps.db.query(
            `SELECT ${cols} FROM statements WHERE wallet_id = $1 AND period_start = $2 AND period_end = $3 AND entry_count = $4`,
            [wallet.id, start, end, lines.length],
          )
        ).rows[0];
      ok(res, { ...st, currency: wallet.currency, simulated: true });
    }),
  );

  r.get(
    "/statements/:id/export",
    route(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const { format } = parse(
        z.object({ format: z.enum(["csv", "pdf"]).default("csv") }),
        req.query,
      );
      const st = (
        await deps.db.query<{
          wallet_id: string;
          period_start: Date;
          period_end: Date;
          opening_minor: bigint;
          closing_minor: bigint;
        }>(
          `SELECT wallet_id, period_start, period_end, opening_minor, closing_minor FROM statements WHERE id = $1`,
          [id],
        )
      ).rows[0];
      if (!st) throw new AppError("NOT_FOUND", "Statement not found.");
      const { wallet } = await loadWallet(deps, res, st.wallet_id); // ownership check (404 for others)
      const exp =
        (
          await deps.db.query<{ exponent: number }>(
            `SELECT exponent FROM currencies WHERE code = $1`,
            [wallet.currency],
          )
        ).rows[0]?.exponent ?? 2;
      const from = st.period_start.toISOString().slice(0, 10);
      const toExclusive = new Date(st.period_end.getTime() + 86_400_000).toISOString().slice(0, 10);
      const lines = await linesFor(wallet.account_id, from, toExclusive);
      let running = st.opening_minor;
      const rows = lines.map((l) => {
        running += signed(l);
        return [
          l.posted_at.toISOString(),
          l.kind,
          l.description,
          l.direction,
          formatMinor(l.amount_minor, exp),
          formatMinor(running, exp),
        ];
      });
      const masked = `••••${wallet.account_number.slice(-4)}`;
      const name = `statement-${masked.slice(-4)}-${from}`;
      void getAuth(res);
      if (format === "csv") {
        const header = [
          "posted_at",
          "kind",
          "description",
          "direction",
          `amount_${wallet.currency}`,
          `balance_${wallet.currency}`,
        ];
        const csv = [
          `# FinCore SIMULATED statement,${csvCell(masked)},${from},${st.period_end.toISOString().slice(0, 10)}`,
          `# opening_balance,${formatMinor(st.opening_minor, exp)}`,
          header.join(","),
          ...rows.map((r) => r.map((c) => csvCell(String(c))).join(",")),
          `# closing_balance,${formatMinor(st.closing_minor, exp)}`,
        ].join("\n");
        res.setHeader("content-type", "text/csv; charset=utf-8");
        res.setHeader("content-disposition", `attachment; filename="${name}.csv"`);
        res.send(csv);
        return;
      }
      const pdf = simplePdf([
        "FinCore - SIMULATED statement (no real funds)",
        `Account ${masked}  Currency ${wallet.currency}  Period ${from} to ${st.period_end.toISOString().slice(0, 10)}`,
        `Opening balance ${formatMinor(st.opening_minor, exp)}`,
        "",
        ...rows.map(
          (r) =>
            `${r[0]?.slice(0, 19)}  ${String(r[3]).padEnd(6)} ${String(r[4]).padStart(14)} ${String(r[5]).padStart(14)}  ${String(r[2]).slice(0, 40)}`,
        ),
        "",
        `Closing balance ${formatMinor(st.closing_minor, exp)}`,
      ]);
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", `attachment; filename="${name}.pdf"`);
      res.send(pdf);
    }),
  );

  return r;
}
