export interface Point {
  x: number;
  y: number;
}

export interface WorldPoint {
  x: number;
  z: number;
}

export interface ReferencePoint {
  pixel: Point | null;
  world: WorldPoint;
}

export interface ReferenceFrame {
  topLeft: ReferencePoint;
  bottomRight: ReferencePoint;
}

export interface SoilLayer {
  id: string;
  points: Point[];
  name: string;
}

export type Mode = "pan" | "reference" | "draw";

export interface SoilProfileLayerOutput {
  top: number;
  bottom: number;
  soil_code: string;
}

export interface SoilProfileOutput {
  x: number;
  y: number;
  soil_layers: SoilProfileLayerOutput[];
}

export interface ProjectFile {
  version: 1;
  image: { fileName: string; dataUrl: string } | null;
  referenceFrame: ReferenceFrame;
  layers: SoilLayer[];
  layerCounter: number;
  soilColors: Record<string, string>;
  referenceLine: Point[] | null;
}
