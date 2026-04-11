export interface ProjectMapMeta {
  name: string;
  stack: string;
  language: string;
  architecture: string;
  created: string;
  lastUpdated: string;
}

export interface MapNode {
  purpose: string;
  exports?: string[];
  depends_on?: string[];
  children?: Record<string, MapNode>;
}

export interface ProjectMap {
  meta: ProjectMapMeta;
  structure: Record<string, MapNode>;
}

export interface MapValidationResult {
  unmappedFiles: string[];
  missingFiles: string[];
  valid: boolean;
}
