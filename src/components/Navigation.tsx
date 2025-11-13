"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, X } from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  description?: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const navigationGroups: NavGroup[] = [
  {
    title: "Main",
    items: [
      { href: "/", label: "Home", description: "Home page" },
      { href: "/rrf-search", label: "RRF Search", description: "RxNorm RRF approximate search" },
      { href: "/sql-browser", label: "SQL Browser", description: "Browse medication SQL database" },
    ],
  },
  {
    title: "Medications",
    items: [
      { href: "/medications/batch", label: "Medications Batch", description: "Batch medication processing" },
      { href: "/medications/fmb", label: "Medications FMB", description: "FMB medication data" },
      { href: "/medication-csv", label: "Medication CSV", description: "CSV medication import/export" },
    ],
  },
  {
    title: "Comparison",
    items: [
      { href: "/medication-comparison", label: "Medication Comparison", description: "Compare medications" },
      { href: "/medication-comparison/batch", label: "Comparison Batch", description: "Batch medication comparison" },
    ],
  },
  {
    title: "Testing",
    items: [
      { href: "/test/llm", label: "Test LLM", description: "Test LLM functionality" },
      { href: "/test/med", label: "Test Med", description: "Test medication processing" },
      { href: "/test/med/batch", label: "Test Med Batch", description: "Batch test medication processing" },
      { href: "/test/med2", label: "Test Med2", description: "Alternative medication test" },
      { href: "/test/approximate", label: "Test Approximate", description: "Test approximate matching" },
      { href: "/test/approximate/audit", label: "Approximate Audit", description: "Audit approximate search results" },
    ],
  },
];

export default function Navigation() {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isActive = (href: string) => {
    if (href === "/") {
      return pathname === "/";
    }
    return pathname.startsWith(href);
  };

  return (
    <nav className="border-b bg-white/95 backdrop-blur-sm sticky top-0 z-50 shadow-sm">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo/Brand */}
          <div className="flex items-center">
            <Link
              href="/"
              className="text-lg font-semibold text-slate-900 hover:text-slate-700 transition"
            >
              AI Medication Assistant
            </Link>
          </div>

          {/* Desktop Navigation */}
          <div className="hidden lg:flex lg:items-center lg:gap-1">
            {navigationGroups.map((group) => (
              <div key={group.title} className="relative group">
                <button className="px-3 py-2 text-sm font-medium text-slate-700 hover:text-slate-900 hover:bg-slate-50 rounded-md transition">
                  {group.title}
                </button>
                <div className="absolute left-0 mt-1 w-64 rounded-md bg-white shadow-lg border border-slate-200 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50">
                  <div className="py-1">
                    {group.items.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={`block px-4 py-2 text-sm transition ${
                          isActive(item.href)
                            ? "bg-slate-100 text-slate-900 font-medium"
                            : "text-slate-700 hover:bg-slate-50"
                        }`}
                      >
                        <div className="font-medium">{item.label}</div>
                        {item.description && (
                          <div className="text-xs text-slate-500 mt-0.5">{item.description}</div>
                        )}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Mobile menu button */}
          <button
            type="button"
            className="lg:hidden p-2 text-slate-700 hover:text-slate-900 hover:bg-slate-50 rounded-md transition"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? (
              <X className="h-6 w-6" />
            ) : (
              <Menu className="h-6 w-6" />
            )}
          </button>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <div className="lg:hidden border-t border-slate-200 py-4">
            <div className="space-y-4">
              {navigationGroups.map((group) => (
                <div key={group.title}>
                  <div className="px-3 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    {group.title}
                  </div>
                  <div className="mt-1 space-y-1">
                    {group.items.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setMobileMenuOpen(false)}
                        className={`block px-3 py-2 text-sm rounded-md transition ${
                          isActive(item.href)
                            ? "bg-slate-100 text-slate-900 font-medium"
                            : "text-slate-700 hover:bg-slate-50"
                        }`}
                      >
                        <div className="font-medium">{item.label}</div>
                        {item.description && (
                          <div className="text-xs text-slate-500 mt-0.5">{item.description}</div>
                        )}
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}

