import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SimulatedBanner } from "@/components/simulated-banner";
import "./globals.css";

export const metadata: Metadata = {
  title: "FinCore (Simulated)",
  description: "Simulated digital wallet and ledger platform: educational use only.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:bg-white focus:p-2"
        >
          Skip to main content
        </a>
        <SimulatedBanner />
        {children}
      </body>
    </html>
  );
}
