import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RADIO CHROMITE",
  description: "Radio Chromite digital music broadcast.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
