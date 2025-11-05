export interface NDCInfo {
  ndc: string;
  labeler_name?: string;
  marketing_status?: string;
  package_description?: string;
  marketing_start?: string;
  marketing_end?: string;
  dea_schedule?: string;
  is_active?: boolean;
}

export interface Medication {
  drug_name: string;
  rxcui?: string;
  drug_class?: string;
  strength?: string;
  dosage_form?: string;
  route?: string;
  ndcs?: NDCInfo[];
}

export interface RecommendationResponse {
  diagnosis: string;
  recommendations: Medication[];
}
