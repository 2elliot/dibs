import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "dibs",
  description: "Live view of every agent, what it's building, and where they collide.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
