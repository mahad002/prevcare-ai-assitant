import React from "react";
import { Medication } from "../types/models";
import { NDCCard } from "./NDCCard";

export const MedicationCard: React.FC<{ med: Medication }> = ({ med }) => (
  <div className="p-4 bg-white rounded-xl shadow-sm border">
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <h2 className="text-lg font-semibold text-blue-800">{med.drug_name}</h2>
        {med.drug_class && <p className="text-sm text-gray-500">{med.drug_class}</p>}
        <div className="text-sm mt-1 text-gray-600">
          {med.strength && <span>{med.strength} • </span>}
          {med.dosage_form && <span>{med.dosage_form} • </span>}
          {med.route && <span>{med.route}</span>}
        </div>
        {med.rxcui && (
          <p className="text-xs text-gray-400 mt-1">RxCUI: {med.rxcui}</p>
        )}
      </div>
      {med.rxcui && (
        <button
          onClick={() => window.open(`/inventory/${med.rxcui}`, '_blank')}
          className="shrink-0 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded-md px-3 py-2"
          title="Check inventory availability by RxCUI"
        >
          Check
        </button>
      )}
    </div>

    {med.ndcs && med.ndcs.length > 0 && (
      <details className="mt-4">
        <summary className="cursor-pointer text-sm text-blue-600 font-medium hover:text-blue-800">
          Show NDCs ({med.ndcs.length})
        </summary>
        <div className="mt-3 space-y-2 max-h-64 overflow-y-auto pr-2">
          {med.ndcs.map((n) => (
            <NDCCard key={n.ndc} ndc={n} medicationName={med.drug_name} />
          ))}
        </div>
      </details>
    )}
  </div>
);
