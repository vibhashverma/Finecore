export interface Wallet {
  id: string;
  account_number: string;
  currency: string;
  nickname: string | null;
  status: string;
  balance: { posted_minor: string; held_minor: string; available_minor: string; simulated: true };
}
export interface Beneficiary {
  id: string;
  nickname: string;
  account_number: string;
  currency: string;
}
export interface Transfer {
  id: string;
  status: string;
  source_wallet_id: string;
  amount_minor: string;
  fee_minor: string;
  currency: string;
  description: string | null;
  risk: { score: number; reasons: Array<{ code: string; detail: string }> } | null;
  created_at: string;
}
export interface LedgerLine {
  entry_id: string;
  kind: string;
  description: string;
  direction: "DEBIT" | "CREDIT";
  amount_minor: string;
  posted_at: string;
  state: string;
}
