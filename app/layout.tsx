import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NULLWAVE // RADIO_TRANSMISSION",
  description: "Experimental cyber-industrial web radio interface.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
