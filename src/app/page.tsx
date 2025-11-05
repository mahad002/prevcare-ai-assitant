"use client";

import { useEffect, useRef, useState } from "react";
import { useMedicationAssistant } from "../hooks/useMedicationAssistant";
import { MedicationCard } from "../components/MedicationCard";
import type { Medication } from "../types/models";

export default function Home() {
  const [condition, setCondition] = useState("");
  const { loading, result, diagnosis, error, getRecommendations } = useMedicationAssistant();

  // Local reorderable list
  const [cards, setCards] = useState<Medication[]>([]);
  useEffect(() => {
    setCards(result || []);
  }, [result]);

  const dragIndex = useRef<number | null>(null);

  const handleDragStart = (index: number) => (e: React.DragEvent) => {
    dragIndex.current = index;
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (index: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (index: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragIndex.current;
    if (from === null || from === index) return;
    setCards((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(index, 0, moved);
      return next;
    });
    dragIndex.current = null;
  };

  const handleSubmit = () => {
    if (!loading && condition.trim()) {
      getRecommendations(condition);
    }
  };

  return (
    <main className="max-w-7xl mx-auto px-4 md:px-6 py-6 min-h-screen">
      <div className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">
          AI Medication Assistant
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Get FDA-grounded medication options for your diagnosis in seconds.
        </p>
      </div>

      <div className="flex items-stretch gap-3">
        <div className="flex-1">
      <input
        value={condition}
        onChange={(e) => setCondition(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="e.g., streptococcal pharyngitis, hypertension, migraine..."
            className="border border-slate-300 rounded-lg w-full p-3 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition bg-white text-slate-900 placeholder:text-slate-400"
      />
        </div>
      <button
          onClick={handleSubmit}
          className="inline-flex items-center justify-center bg-blue-600 text-white rounded-lg px-4 py-3 font-medium hover:bg-blue-700 active:bg-blue-800 disabled:bg-blue-400 disabled:cursor-not-allowed transition"
        disabled={loading || !condition.trim()}
          aria-busy={loading}
      >
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/60 border-t-white" />
              Analyzing
              <span className="inline-flex w-6 justify-between">
                <span className="h-1 w-1 bg-white/90 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="h-1 w-1 bg-white/90 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="h-1 w-1 bg-white/90 rounded-full animate-bounce [animation-delay:300ms]" />
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2L11 13" />
                <path d="M22 2L15 22 11 13 2 9 22 2z" />
              </svg>
              Get Medications
            </span>
          )}
      </button>
      </div>

      {error && (
        <div className="mt-4 bg-white border border-red-200 rounded-xl p-5 shadow-sm">
          <h3 className="text-red-700 font-semibold mb-1">Something went wrong</h3>
          <p className="text-red-700 text-sm">{error}</p>
          <p className="text-red-600 text-xs mt-2">
            Check your OpenAI API key in <code>.env.local</code> and ensure it's valid.
          </p>
        </div>
      )}

      {loading && cards.length === 0 && (
        <section className="mt-6">
          <div className="h-5 w-56 bg-slate-200 rounded mb-3 animate-pulse" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[0,1,2,3,4,5,6,7].map((i) => (
              <div key={i} className="p-4 bg-white rounded-xl shadow-sm border border-slate-200">
                <div className="h-4 w-2/3 bg-slate-200 rounded animate-pulse" />
                <div className="mt-2 h-3 w-40 bg-slate-100 rounded animate-pulse" />
                <div className="mt-3 flex gap-2">
                  <div className="h-3 w-16 bg-slate-100 rounded animate-pulse" />
                  <div className="h-3 w-20 bg-slate-100 rounded animate-pulse" />
                  <div className="h-3 w-14 bg-slate-100 rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!loading && cards.length === 0 && !error && (
        <div className="mt-10 text-center text-slate-600">
          <div className="mx-auto w-14 h-14 rounded-full bg-gradient-to-tr from-sky-100 to-blue-100 flex items-center justify-center">
            <span className="text-2xl">🩺</span>
          </div>
          <p className="mt-3 font-medium text-slate-800">Ready when you are</p>
          <p className="text-sm">Enter a diagnosis or symptom to see recommended medications.</p>
        </div>
      )}

      {cards.length > 0 && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold text-slate-900">
            Diagnosis: <span className="font-normal text-slate-800">{diagnosis}</span> <span className="text-slate-600">({cards.length} drugs)</span>
          </h2>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {cards.map((m, i) => (
              <div
                key={i}
                draggable
                onDragStart={handleDragStart(i)}
                onDragOver={handleDragOver(i)}
                onDrop={handleDrop(i)}
                className="outline-none"
                aria-grabbed="true"
                role="listitem"
              >
                <MedicationCard med={m} />
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
