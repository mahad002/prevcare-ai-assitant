import React from "react";
import { NDCInfo } from "../types/models";

interface NDCCardProps {
  ndc: NDCInfo;
  medicationName: string;
  compact?: boolean;
}

export const NDCCard: React.FC<NDCCardProps> = ({ ndc, medicationName, compact = false }) => {
  const handleClick = () => {
    // Open NDC details page in new tab
    window.open(`/ndc/${ndc.ndc}`, '_blank');
  };

  const base = compact
    ? "p-2 bg-slate-50 rounded-md border border-slate-200 hover:border-blue-400 hover:bg-blue-50 cursor-pointer transition-all"
    : "p-3 bg-gray-50 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50 cursor-pointer transition-all shadow-sm hover:shadow-md";

  return (
    <div 
      onClick={handleClick}
      className={base}
      role="button"
      aria-label={`Open NDC details for ${medicationName} (${ndc.ndc})`}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <h3 className={compact ? "text-[13px] font-semibold text-slate-900 mb-0.5 truncate" : "text-sm font-semibold text-gray-800 mb-1"}>
            NDC: <span className="font-mono">{ndc.ndc}</span>
          </h3>
          {!compact && ndc.labeler_name && (
            <p className="text-xs text-gray-600 mb-1 truncate">{ndc.labeler_name}</p>
          )}
          <div className="flex items-center gap-2 mt-1">
            {ndc.marketing_status && (
              <span className={`${ndc.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'} ${compact ? 'text-[10px]' : 'text-xs'} px-2 py-0.5 rounded-full`}> 
                {ndc.marketing_status}
              </span>
            )}
            {ndc.dea_schedule && !compact && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700">
                DEA: {ndc.dea_schedule}
              </span>
            )}
          </div>
        </div>
        <div className="ml-2 shrink-0">
          <svg 
            className={compact ? "w-4 h-4 text-blue-600" : "w-5 h-5 text-blue-600"}
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={2} 
              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" 
            />
          </svg>
        </div>
      </div>
    </div>
  );
};

