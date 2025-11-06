import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Medication Assistant",
  description: "AI-powered medication assistance using GPT-5",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen bg-white`}
      >
        <header className="border-b bg-white/80 backdrop-blur">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 flex items-center gap-6">
            <Link href="/" className="text-sm font-semibold text-slate-900">
              Home
            </Link>
            <nav className="flex items-center gap-4">
              <Link href="/test/llm" className="text-sm text-slate-700 hover:text-slate-900">
                Test LLM
              </Link>
              <Link href="/test/med" className="text-sm text-slate-700 hover:text-slate-900">
                Test Med
              </Link>
              <Link href="/test/med/batch" className="text-sm text-slate-700 hover:text-slate-900">
                Test Med Batch
              </Link>
              <Link href="/test/med2" className="text-sm text-slate-700 hover:text-slate-900">
                Test Med2
              </Link>
              <Link href="/medications/batch" className="text-sm text-slate-700 hover:text-slate-900">
                Medications Batch
              </Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
