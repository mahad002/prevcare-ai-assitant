export interface Product {
  PRODUCTID: string;
  PRODUCTNDC: string;
  PRODUCTTYPENAME: string;
  PROPRIETARYNAME: string;
  PROPRIETARYNAMESUFFIX: string;
  NONPROPRIETARYNAME: string;
  DOSAGEFORMNAME: string;
  ROUTENAME: string;
  STARTMARKETINGDATE: string;
  ENDMARKETINGDATE: string;
  MARKETINGCATEGORYNAME: string;
  APPLICATIONNUMBER: string;
  LABELERNAME: string;
  SUBSTANCENAME: string;
  ACTIVE_NUMERATOR_STRENGTH: string;
  ACTIVE_INGRED_UNIT: string;
  PHARM_CLASSES: string;
  DEASCHEDULE: string;
  NDC_EXCLUDE_FLAG: string;
  LISTING_RECORD_CERTIFIED_THROUGH: string;
}

export interface Package {
  PRODUCTID: string;
  NDCPACKAGECODE: string;
  PACKAGEDESCRIPTION: string;
  STARTMARKETINGDATE: string;
  ENDMARKETINGDATE: string;
  NDC_EXCLUDE_FLAG: string;
}

let productsCache: Product[] | null = null;
let packagesCache: Package[] | null = null;

/**
 * Parse tab-separated text file into array of objects
 */
function parseTSV(text: string): any[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  
  const headers = lines[0].split('\t');
  const data: any[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split('\t');
    if (values.length === headers.length) {
      const obj: any = {};
      headers.forEach((header, index) => {
        obj[header] = values[index] || '';
      });
      data.push(obj);
    }
  }
  
  return data;
}

/**
 * Load products from the text file
 */
export async function loadProducts(): Promise<Product[]> {
  if (productsCache) {
    console.log('Using cached products:', productsCache.length);
    return productsCache;
  }
  
  try {
    console.log('Loading products from /ndctext/product.txt');
    const response = await fetch('/ndctext/product.txt');
    if (!response.ok) {
      console.error('Failed to fetch product.txt:', response.status, response.statusText);
      return [];
    }
    const text = await response.text();
    console.log('Product file loaded, length:', text.length);
    productsCache = parseTSV(text) as Product[];
    console.log('Parsed products:', productsCache.length);
    return productsCache;
  } catch (error) {
    console.error('Error loading products:', error);
    return [];
  }
}

/**
 * Load packages from the text file
 */
export async function loadPackages(): Promise<Package[]> {
  if (packagesCache) {
    console.log('Using cached packages:', packagesCache.length);
    return packagesCache;
  }
  
  try {
    console.log('Loading packages from /ndctext/package.txt');
    const response = await fetch('/ndctext/package.txt');
    if (!response.ok) {
      console.error('Failed to fetch package.txt:', response.status, response.statusText);
      return [];
    }
    const text = await response.text();
    console.log('Package file loaded, length:', text.length);
    packagesCache = parseTSV(text) as Package[];
    console.log('Parsed packages:', packagesCache.length);
    return packagesCache;
  } catch (error) {
    console.error('Error loading packages:', error);
    return [];
  }
}

/**
 * Normalize NDC format - handles different formats and extracts product NDC
 * Examples:
 * - "00113051771" -> extract "0113-0517" (first 8 digits, remove leading zeros from first segment)
 * - "0113-0517-71" -> "0113-0517"
 * - "00093-2268-01" -> "00093-2268"
 */
function normalizeNDCForSearch(ndc: string): { normalized: string; productNDC: string } {
  // Remove all dashes and spaces
  const clean = ndc.replace(/[- ]/g, '');
  
  // If it's 11 digits (full package NDC), extract first 8 digits for product NDC
  // Example: "00113051771" -> "0113-0517"
  if (clean.length === 11) {
    // First 5 digits: labeler code (can have leading zeros)
    // Next 4 digits: product code
    // Last 2 digits: package code
    const firstSegment = clean.slice(0, 5);  // "00113"
    const secondSegment = clean.slice(5, 9); // "0517"
    
    // For labeler code, remove leading zeros but keep minimum 4 digits
    // "00113" -> take last 4 digits -> "0113"
    // "00093" -> take last 4 digits -> "0093" -> "00093" (keep leading zero if needed)
    const firstPart = firstSegment.length === 5 && firstSegment.startsWith('0') 
      ? firstSegment.slice(1) // Remove one leading zero: "00113" -> "0113"
      : firstSegment.slice(-4); // Or take last 4 digits
    
    // Ensure first part is 4 digits (pad if needed, but usually it will be 4)
    const formattedFirst = firstPart.padStart(4, '0');
    const formattedProductNDC = `${formattedFirst}-${secondSegment}`;
    
    console.log(`Normalized 11-digit NDC: ${ndc} -> product: ${formattedProductNDC}`);
    
    return {
      normalized: clean,
      productNDC: formattedProductNDC
    };
  }
  
  // If it's 9 digits (product NDC without dashes), format as 4-4
  if (clean.length === 9) {
    const firstSegment = clean.slice(0, 5);
    const secondSegment = clean.slice(5, 9);
    const firstPart = firstSegment.length === 5 && firstSegment.startsWith('0')
      ? firstSegment.slice(1)
      : firstSegment.slice(-4);
    const formatted = `${firstPart.padStart(4, '0')}-${secondSegment}`;
    return {
      normalized: clean,
      productNDC: formatted
    };
  }
  
  // If it's 8 digits (product NDC without dashes), format as 4-4
  if (clean.length === 8) {
    const firstPart = clean.slice(0, 4);
    const secondPart = clean.slice(4, 8);
    const formatted = `${firstPart}-${secondPart}`;
    return {
      normalized: clean,
      productNDC: formatted
    };
  }
  
  // If it already has dashes, extract product NDC
  if (ndc.includes('-')) {
    const parts = ndc.split('-');
    if (parts.length >= 2) {
      const productNDC = `${parts[0]}-${parts[1]}`;
      return {
        normalized: clean,
        productNDC: productNDC
      };
    }
  }
  
  return {
    normalized: clean,
    productNDC: ndc
  };
}

/**
 * Search products by NDC (supports both full NDC and product NDC)
 */
export async function searchProductsByNDC(ndc: string): Promise<Product[]> {
  console.log('Searching products for NDC:', ndc);
  const products = await loadProducts();
  console.log('Total products available:', products.length);
  
  if (products.length === 0) {
    console.warn('No products loaded!');
    return [];
  }
  
  // Normalize and extract product NDC
  const { normalized, productNDC } = normalizeNDCForSearch(ndc);
  console.log('Normalized NDC:', normalized);
  console.log('Extracted product NDC:', productNDC);
  
  const matches = products.filter(product => {
    const dbProductNDC = (product.PRODUCTNDC || '').trim();
    if (!dbProductNDC) return false;
    
    // Remove dashes for comparison
    const dbNormalized = dbProductNDC.replace(/[- ]/g, '');
    
    // Try multiple matching strategies
    // 1. Exact match with dashes
    if (dbProductNDC === productNDC) {
      console.log('✓ Exact match (with dashes):', dbProductNDC);
      return true;
    }
    
    // 2. Normalized comparison (without dashes) - exact match
    if (dbNormalized === normalized) {
      console.log('✓ Exact normalized match:', dbProductNDC);
      return true;
    }
    
    // 3. Check if normalized search NDC (11 digits) contains product NDC (8 digits)
    // Example: "00113051771" contains "01130517" or "1130517"
    if (normalized.length === 11 && dbNormalized.length === 8) {
      // Try matching the first 8 digits of search with product NDC
      const searchFirst8 = normalized.slice(0, 8);
      const searchFirst8Alt = normalized.slice(1, 9); // Skip first digit (for cases like "00113051771" -> "01130517")
      
      if (dbNormalized === searchFirst8 || dbNormalized === searchFirst8Alt) {
        console.log('✓ Package NDC contains product NDC:', dbProductNDC, 'matched with', normalized);
        return true;
      }
      
      // Also try matching by removing leading zeros
      const searchWithoutLeadingZeros = normalized.replace(/^0+/, '');
      if (dbNormalized === searchWithoutLeadingZeros.slice(0, 8)) {
        console.log('✓ Match after removing leading zeros:', dbProductNDC);
        return true;
      }
    }
    
    // 4. Check if product NDC starts with normalized search (product NDC contains search)
    if (dbNormalized.startsWith(normalized)) {
      console.log('✓ Product NDC contains search NDC:', dbProductNDC);
      return true;
    }
    
    // 5. Try matching with extracted product NDC (normalized)
    const extractedNormalized = productNDC.replace(/[- ]/g, '');
    if (dbNormalized === extractedNormalized || dbProductNDC === productNDC) {
      console.log('✓ Match with extracted product NDC:', dbProductNDC);
      return true;
    }
    
    // 6. Try matching by aligning formats (handle different zero padding)
    // If search is 11 digits and product is 8, try matching the middle portion
    if (normalized.length === 11 && dbNormalized.length === 8) {
      // Try: "00113051771" -> "1130517" (remove leading zero) -> match "01130517"?
      const searchVariants = [
        normalized.slice(0, 8),      // "00113051"
        normalized.slice(1, 9),      // "01130517" 
        normalized.slice(2, 10),     // "11305177"
        normalized.replace(/^0+/, '').slice(0, 8) // Remove leading zeros then take 8
      ];
      
      for (const variant of searchVariants) {
        if (dbNormalized === variant || variant.startsWith(dbNormalized) || dbNormalized.startsWith(variant)) {
          console.log('✓ Match with variant:', dbProductNDC, 'variant:', variant);
          return true;
        }
      }
    }
    
    return false;
  });
  
  if (matches.length > 0) {
    console.log('Found matches:', matches.length);
    matches.forEach(m => {
      console.log('  -', m.PRODUCTNDC, ':', m.PROPRIETARYNAME || m.NONPROPRIETARYNAME);
    });
  } else {
    console.warn('No matches found. Sample product NDCs:', products.slice(0, 5).map(p => p.PRODUCTNDC));
  }
  
  return matches;
}

/**
 * Get packages for a specific product ID or NDC
 */
export async function getPackagesForProduct(productId: string, productNDC?: string): Promise<Package[]> {
  console.log('Getting packages for product:', productId, productNDC);
  const packages = await loadPackages();
  console.log('Total packages available:', packages.length);
  
  // Filter by product ID first (most reliable)
  let matchingPackages = packages.filter(pkg => {
    const pkgProductId = (pkg.PRODUCTID || '').trim();
    return pkgProductId === productId.trim();
  });
  console.log('Packages matching product ID:', matchingPackages.length);
  
  // If no matches by product ID and we have product NDC, try matching by NDC
  if (matchingPackages.length === 0 && productNDC) {
    const { normalized: normalizedProductNDC, productNDC: formattedProductNDC } = normalizeNDCForSearch(productNDC);
    console.log('Trying NDC match - normalized:', normalizedProductNDC, 'formatted:', formattedProductNDC);
    
    matchingPackages = packages.filter(pkg => {
      const packageNDC = (pkg.NDCPACKAGECODE || '').trim();
      if (!packageNDC) return false;
      
      // Try exact match with dashes
      if (packageNDC === formattedProductNDC) return true;
      
      // Try normalized comparison
      const normalizedPackageNDC = packageNDC.replace(/[- ]/g, '');
      
      // Check if package NDC starts with product NDC (package contains product)
      if (normalizedPackageNDC.startsWith(normalizedProductNDC)) {
        return true;
      }
      
      // Check if product NDC starts with package (vice versa)
      if (normalizedProductNDC.startsWith(normalizedPackageNDC)) {
        return true;
      }
      
      return false;
    });
    console.log('Packages matching NDC:', matchingPackages.length);
  }
  
  return matchingPackages;
}

/**
 * Search products by name (proprietary or non-proprietary)
 */
export async function searchProductsByName(searchTerm: string): Promise<Product[]> {
  const products = await loadProducts();
  const term = searchTerm.toLowerCase();
  
  return products.filter(product => {
    const proprietary = (product.PROPRIETARYNAME || '').toLowerCase();
    const nonProprietary = (product.NONPROPRIETARYNAME || '').toLowerCase();
    const substance = (product.SUBSTANCENAME || '').toLowerCase();
    
    return proprietary.includes(term) || 
           nonProprietary.includes(term) || 
           substance.includes(term);
  });
}

/**
 * Get full product information with packages for a given NDC
 */
export async function getProductWithPackages(ndc: string): Promise<{
  product: Product | null;
  packages: Package[];
}> {
  const products = await searchProductsByNDC(ndc);
  
  if (products.length === 0) {
    return { product: null, packages: [] };
  }
  
  // Get the first matching product (prefer active ones)
  const product = products.sort((a, b) => {
    // Prefer products with later start dates (more recent)
    const aDate = a.STARTMARKETINGDATE || '0';
    const bDate = b.STARTMARKETINGDATE || '0';
    return bDate.localeCompare(aDate);
  })[0];
  
  const packages = await getPackagesForProduct(product.PRODUCTID, product.PRODUCTNDC);
  
  return { product, packages };
}

