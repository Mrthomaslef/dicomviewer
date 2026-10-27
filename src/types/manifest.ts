export interface PedagogicalManifest {
  formatVersion: "1.0";
  caseId: string;
  title: string;
  modality: "MR" | "CT" | "RX" | "CR" | "DX" | "XA" | "US";
  anatomicalRegion?: string;
  clinicalHistory?: string;
  diagnosis?: string;
  keySliceIndex?: number;
  keyWindowKey?: string;
  series: SeriesManifest[];
}

export interface SeriesManifest {
  id: string;
  description: string;
  modality: string;
  width: number;
  height: number;
  sliceCount: number;
  // Espacement physique [espacement_ligne_mm, espacement_colonne_mm] pour l'outil règle
  pixelSpacing: [number, number];
  // Épaisseur effective après décimation (SliceThickness * step)
  effectiveSliceThickness: number;
  // Liste des fenêtres pré-rendues (ex: ["default"] en IRM, ["bone", "soft"] en TDM)
  availableWindows: {
    key: string;
    label: string;
    folderPath: string;
  }[];
  slices: {
    index: number;
    zPosition: number;
    annotations?: AnnotationItem[];
  }[];
}

export interface AnnotationItem {
  id: string;
  type: "arrow" | "circle" | "text";
  // Coordonnées normalisées entre 0 et 1 par rapport à width/height
  points: [number, number][];
  label?: string;
}

/**
 * Rectangle normalisé [0..1] pour l'anonymisation par destruction physique (Burned-in PHI)
 */
export interface BurnedInMaskRect {
  id: string;
  x: number; // [0..1]
  y: number; // [0..1]
  width: number; // [0..1]
  height: number; // [0..1];
}

export interface WindowPresetConfig {
  key: string;
  label: string;
  windowCenter: number;
  windowWidth: number;
}
