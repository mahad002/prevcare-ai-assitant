"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { getNDCs } from "../../../lib/api";
import { loadPackages } from "../../../lib/ndcDatabase";

function normalizeNDC(s: string) {
  return (s || "").replace(/[- ]/g, "").trim();
}

function productNDCFromAny(ndc: string) {
  const raw = ndc || "";
  if (raw.includes("-")) {
    const parts = raw.split("-");
    if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  }
  const clean = normalizeNDC(raw);
  if (clean.length === 11) {
    const labeler5 = clean.slice(0, 5);
    const product4 = clean.slice(5, 9);
    const firstPart = labeler5.startsWith("0") ? labeler5.slice(1) : labeler5.slice(-4);
    return `${firstPart.padStart(4, "0")}-${product4}`;
  }
  if (clean.length === 9) {
    const labeler5 = clean.slice(0, 5);
    const product4 = clean.slice(5, 9);
    const firstPart = labeler5.startsWith("0") ? labeler5.slice(1) : labeler5.slice(-4);
    return `${firstPart.padStart(4, "0")}-${product4}`;
  }
  return raw;
}

export default function InventoryByRxCUI() {
  const params = useParams();
  const rxcui = (params.rxcui as string) || "";
  const [allNDCs, setAllNDCs] = useState<string[]>([]);
  const [packages, setPackages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "available" | "unavailable">("all");

  useEffect(() => {
    const run = async () => {
      if (!rxcui) return;
      setLoading(true);
      setError(null);
      try {
        const [ndcs, pkgs] = await Promise.all([
          getNDCs(rxcui).catch(() => []),
          loadPackages().catch(() => [])
        ]);
        setAllNDCs(ndcs || []);
        setPackages(pkgs || []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load inventory");
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [rxcui]);

  const inventorySet = useMemo(() => {
    const set = new Set<string>();
    for (const p of packages) {
      const fullCode = (p?.NDCPACKAGECODE || "").trim();
      const normalizedFull = normalizeNDC(fullCode);
      if (normalizedFull) set.add(normalizedFull);
      const productCode = productNDCFromAny(fullCode);
      const normalizedProduct = normalizeNDC(productCode);
      if (normalizedProduct) set.add(normalizedProduct);
    }
    return set;
  }, [packages]);

  const rows = useMemo(() => {
    const list = (allNDCs || []).map((n) => {
      const normalized = normalizeNDC(n);
      const prodVariant = normalizeNDC(productNDCFromAny(n));
      const available = inventorySet.has(normalized) || inventorySet.has(prodVariant);
      return { ndc: n, available };
    });
    if (filter === "available") return list.filter((x) => x.available);
    if (filter === "unavailable") return list.filter((x) => !x.available);
    return list;
  }, [allNDCs, inventorySet, filter]);

  return (
    <main className="max-w-5xl mx-auto p-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-blue-700">Inventory by RxCUI</h1>
          <p className="text-sm text-gray-600 mt-1">RxCUI: <span className="font-mono">{rxcui}</span></p>
          <p className="text-xs text-gray-500 mt-1">NDCs from RxNav matched against local inventory packages.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setFilter("all")} className={`text-xs rounded-md px-3 py-2 border ${filter === "all" ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-700 border-gray-300"}`}>All</button>
          <button onClick={() => setFilter("available")} className={`text-xs rounded-md px-3 py-2 border ${filter === "available" ? "bg-green-700 text-white border-green-700" : "bg-white text-gray-700 border-gray-300"}`}>Available</button>
          <button onClick={() => setFilter("unavailable")} className={`text-xs rounded-md px-3 py-2 border ${filter === "unavailable" ? "bg-red-700 text-white border-red-700" : "bg-white text-gray-700 border-gray-300"}`}>Unavailable</button>
        </div>
      </div>

      {loading && (<div className="text-sm text-gray-600">Checking inventory…</div>)}
      {error && (<div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">{error}</div>)}

      {!loading && !error && (
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">NDCs ({rows.length})</h2>
          </div>
          {rows.length === 0 ? (
            <p className="text-sm text-gray-500">No NDCs to display.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {rows.map((r) => (
                <div key={r.ndc} className={`p-4 rounded-lg border transition-all ${r.available ? "border-green-300 bg-green-50" : "border-gray-200 bg-gray-50"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-gray-500">NDC</p>
                      <p className="font-mono text-sm font-semibold">{r.ndc}</p>
                    </div>
                    <span className={`text-xs px-2 py-1 rounded ${r.available ? "bg-green-200 text-green-900" : "bg-gray-200 text-gray-800"}`}>{r.available ? "Available" : "Unavailable"}</span>
                  </div>
                  <div className="mt-3 text-right">
                    <button onClick={() => window.open(`/ndc/${r.ndc}`, '_blank')} className="text-xs text-blue-700 hover:text-blue-900">View details →</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
