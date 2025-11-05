"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getNDCStatus } from "../../../lib/api";
import { getProductWithPackages, type Product, type Package } from "../../../lib/ndcDatabase";

interface NDCStatus {
  ndc11?: string;
  status?: string;
  active?: string;
  rxnormNdc?: string;
  rxcui?: string;
  conceptName?: string;
  conceptStatus?: string;
  sourceList?: {
    sourceName?: string[];
  };
  altNdc?: string;
  comment?: string | null;
  ndcHistory?: Array<{
    activeRxcui?: string;
    originalRxcui?: string;
    startDate?: string;
    endDate?: string;
  }>;
}

interface DatabaseProduct extends Product {
  packages: Package[];
}

export default function NDCDetailsPage() {
  const params = useParams();
  const ndc = params.ndc as string;
  const [status, setStatus] = useState<NDCStatus | null>(null);
  const [products, setProducts] = useState<DatabaseProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchNDCData = async () => {
      if (!ndc) return;
      
      setLoading(true);
      setError(null);
      
      try {
        console.log('Fetching NDC data for:', ndc);
        
        // Fetch both RxNav status and local database data in parallel
        const [rxNavStatus, dbData] = await Promise.all([
          getNDCStatus(ndc).catch((e) => {
            console.warn('RxNav status fetch failed:', e);
            return null;
          }),
          getProductWithPackages(ndc).catch((e) => {
            console.error('Database fetch failed:', e);
            return { product: null, packages: [] };
          })
        ]);
        
        console.log('RxNav status:', rxNavStatus);
        console.log('Database data:', dbData);
        
        if (rxNavStatus) {
          setStatus(rxNavStatus);
        }
        
        if (dbData.product) {
          console.log('Found product:', dbData.product.PRODUCTNDC, 'with', dbData.packages.length, 'packages');
          // Ensure we have all packages for this product
          if (dbData.packages.length === 0) {
            console.warn('No packages found, but product exists. Product ID:', dbData.product.PRODUCTID);
          }
          setProducts([{
            ...dbData.product,
            packages: dbData.packages
          }]);
        } else {
          console.warn('No product found in database for NDC:', ndc);
        }
        
        if (!rxNavStatus && !dbData.product) {
          setError("NDC not found in RxNav or local database");
        }
      } catch (err) {
        console.error("Error fetching NDC data:", err);
        setError(err instanceof Error ? err.message : "Failed to fetch NDC data");
      } finally {
        setLoading(false);
      }
    };

    fetchNDCData();
  }, [ndc]);

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto p-8 min-h-screen bg-slate-50">
        <div className="text-center text-slate-700">Loading NDC details...</div>
      </main>
    );
  }

  if (error && products.length === 0 && !status) {
    return (
      <main className="max-w-4xl mx-auto p-8 min-h-screen bg-slate-50">
        <div className="bg-white border border-red-200 rounded-xl p-5 shadow-sm">
          <h2 className="text-red-700 font-semibold mb-1">Error</h2>
          <p className="text-red-600 text-sm">{error || "NDC not found in database or RxNav"}</p>
          <p className="text-xs text-slate-600 mt-2">Check browser console for detailed logs.</p>
        </div>
      </main>
    );
  }

  const formatStrength = (product: Product) => {
    const numerator = product.ACTIVE_NUMERATOR_STRENGTH || '';
    const unit = product.ACTIVE_INGRED_UNIT || '';
    return numerator && unit ? `${numerator} ${unit}` : '';
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr || dateStr.length !== 8) return dateStr;
    return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  };

  return (
    <main className="max-w-6xl mx-auto p-8 min-h-screen bg-slate-50">
      <div className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">
          NDC Details
        </h1>
        <p className="mt-1 text-sm text-slate-600">{ndc}</p>
        {status?.conceptName && (
          <p className="text-slate-700 mt-1">{status.conceptName}</p>
        )}
      </div>

      {/* Product Cards from Local Database */}
      {products.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4 text-slate-900">Product Information</h2>
          <div className="space-y-4">
            {products.map((product, index) => (
              <div key={index} className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                  <div>
                    <label className="text-sm text-slate-600">Product NDC</label>
                    <p className="font-mono text-lg font-semibold text-slate-900">{product.PRODUCTNDC}</p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-600">Product Type</label>
                    <p className="text-sm text-slate-800">{product.PRODUCTTYPENAME}</p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-600">Brand Name</label>
                    <p className="font-semibold text-slate-900">{product.PROPRIETARYNAME || 'N/A'}</p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-600">Generic Name</label>
                    <p className="font-semibold text-slate-900">{product.NONPROPRIETARYNAME || 'N/A'}</p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-600">Dosage Form</label>
                    <p className="text-sm text-slate-800">{product.DOSAGEFORMNAME}</p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-600">Route</label>
                    <p className="text-sm text-slate-800">{product.ROUTENAME}</p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-600">Strength</label>
                    <p className="text-sm font-semibold text-slate-900">{formatStrength(product)}</p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-600">Labeler</label>
                    <p className="text-sm text-slate-800">{product.LABELERNAME}</p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-600">DEA Schedule</label>
                    <p className="text-sm text-slate-800">{product.DEASCHEDULE || 'None'}</p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-600">Marketing Dates</label>
                    <p className="text-sm text-slate-800">
                      {product.STARTMARKETINGDATE ? formatDate(product.STARTMARKETINGDATE) : 'N/A'}
                      {product.ENDMARKETINGDATE && ` - ${formatDate(product.ENDMARKETINGDATE)}`}
                    </p>
                  </div>
                </div>

                {/* Packages for this Product */}
                {product.packages && product.packages.length > 0 && (
                  <div className="mt-6 pt-6 border-t border-slate-200">
                    <h3 className="text-lg font-semibold mb-4 text-slate-900">
                      All Packages for this Product ({product.packages.length})
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {product.packages.map((pkg, pkgIndex) => (
                        <div
                          key={pkgIndex}
                          onClick={() => window.open(`/ndc/${pkg.NDCPACKAGECODE}`, '_blank')}
                          className="p-4 bg-white rounded-lg border border-slate-200 hover:border-blue-500 hover:bg-blue-50 hover:shadow-md transition-all cursor-pointer"
                        >
                          <div className="mb-2">
                            <label className="text-xs text-slate-600">Package NDC</label>
                            <p className="font-mono text-sm font-semibold text-slate-900">{pkg.NDCPACKAGECODE}</p>
                          </div>
                          <div className="mb-2">
                            <label className="text-xs text-slate-600">Description</label>
                            <p className="text-sm text-slate-800">{pkg.PACKAGEDESCRIPTION || 'N/A'}</p>
                          </div>
                          {pkg.STARTMARKETINGDATE && (
                            <div className="mb-2">
                              <label className="text-xs text-slate-600">Marketing Date</label>
                              <p className="text-xs text-slate-800">
                                {formatDate(pkg.STARTMARKETINGDATE)}
                                {pkg.ENDMARKETINGDATE && ` - ${formatDate(pkg.ENDMARKETINGDATE)}`}
                              </p>
                            </div>
                          )}
                          <div className="mt-2 pt-2 border-t border-slate-200">
                            <span className="text-xs text-blue-700 font-medium">Click to view details →</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {product.packages && product.packages.length === 0 && (
                  <div className="mt-6 pt-6 border-t border-slate-200">
                    <p className="text-sm text-slate-600">No packages found for this product.</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* RxNav Status Information */}
      {status && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-6">
        {/* Status Section */}
        <section>
          <h2 className="text-lg font-semibold mb-4 text-slate-900">Status Information</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-slate-600">NDC11</label>
              <p className="font-mono text-sm text-slate-900">{status.ndc11 || "N/A"}</p>
            </div>
            <div>
              <label className="text-sm text-slate-600">Status</label>
              <p className={`text-sm font-semibold ${
                status.status === "ACTIVE" ? "text-emerald-700" : "text-rose-700"
              }`}>
                {status.status || "N/A"}
              </p>
            </div>
            <div>
              <label className="text-sm text-slate-600">Active</label>
              <p className={`text-sm font-semibold ${
                status.active === "YES" ? "text-emerald-700" : "text-rose-700"
              }`}>
                {status.active || "N/A"}
              </p>
            </div>
            <div>
              <label className="text-sm text-slate-600">RxNorm NDC</label>
              <p className="text-sm text-slate-800">{status.rxnormNdc || "N/A"}</p>
            </div>
            {status.rxcui && (
              <div>
                <label className="text-sm text-slate-600">RxCUI</label>
                <p className="font-mono text-sm text-slate-900">{status.rxcui}</p>
              </div>
            )}
            <div>
              <label className="text-sm text-slate-600">Concept Status</label>
              <p className={`text-sm font-semibold ${
                status.conceptStatus === "ACTIVE" ? "text-emerald-700" : "text-rose-700"
              }`}>
                {status.conceptStatus || "N/A"}
              </p>
            </div>
          </div>
        </section>

        {/* Concept Name */}
        {status.conceptName && (
          <section>
            <h2 className="text-lg font-semibold mb-2 text-slate-900">Concept Name</h2>
            <p className="text-slate-800">{status.conceptName}</p>
          </section>
        )}

        {/* Source List */}
        {status.sourceList?.sourceName && status.sourceList.sourceName.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold mb-2 text-slate-900">Source List</h2>
            <div className="flex flex-wrap gap-2">
              {status.sourceList.sourceName.map((source, index) => (
                <span
                  key={index}
                  className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm"
                >
                  {source}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* NDC History */}
        {status.ndcHistory && status.ndcHistory.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold mb-4 text-slate-900">NDC History</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full border border-slate-200 rounded-lg overflow-hidden">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-slate-700 uppercase">Active RxCUI</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-slate-700 uppercase">Original RxCUI</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-slate-700 uppercase">Start Date</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-slate-700 uppercase">End Date</th>
                  </tr>
                </thead>
                <tbody>
                  {status.ndcHistory.map((history, index) => (
                    <tr key={index} className={index % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                      <td className="px-4 py-2 text-sm font-mono text-slate-900">{history.activeRxcui || "N/A"}</td>
                      <td className="px-4 py-2 text-sm font-mono text-slate-900">{history.originalRxcui || "N/A"}</td>
                      <td className="px-4 py-2 text-sm text-slate-800">{history.startDate || "N/A"}</td>
                      <td className="px-4 py-2 text-sm text-slate-800">{history.endDate || "N/A"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Comments */}
        {status.comment && (
          <section>
            <h2 className="text-lg font-semibold mb-2 text-slate-900">Comments</h2>
            <p className="text-slate-800">{status.comment}</p>
          </section>
        )}
        </div>
      )}
    </main>
  );
}

