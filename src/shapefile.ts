import proj4 from "proj4";
import { parseShp } from "shpjs";
import type { Point } from "./types";

// Same definition used by the other apps in this workspace (e.g. lithovox_app).
const RD_DEF =
  "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.33,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs";
proj4.defs("EPSG:28992", RD_DEF);

export interface ShapefileParts {
  shp: ArrayBuffer;
  prj: string | null;
}

// Parses a .shp (with an optional .prj for its coordinate system) into
// reference-line points in EPSG:28992 (RD). If the .prj is missing or
// unparseable, coordinates are assumed to already be in RD.
export function parseShapefileToReferenceLine(parts: ShapefileParts): Point[] {
  // shpjs only reprojects (to WGS84) when handed a *valid* prj string, and
  // otherwise silently falls back to raw coordinates - validate it ourselves
  // first so we reliably know which case we're in and interpret the output
  // coordinates accordingly.
  let prj: string | undefined;
  if (parts.prj) {
    try {
      proj4(parts.prj);
      prj = parts.prj;
    } catch {
      prj = undefined;
    }
  }

  const geometry = parseShp(parts.shp, prj);
  const rawCoords = flattenCoordinates(geometry);
  if (rawCoords.length < 2) {
    throw new Error("The shapefile has no usable line geometry");
  }

  return rawCoords.map((coord) => toReferenceLinePoint(coord, prj !== undefined));
}

function toReferenceLinePoint(coord: number[], wasReprojectedToWgs84: boolean): Point {
  if (!wasReprojectedToWgs84) return { x: coord[0], y: coord[1] }; // no usable .prj - assume already RD
  const [x, y] = proj4("EPSG:4326", "EPSG:28992", [coord[0], coord[1]]); // shpjs reprojects to WGS84 [lon, lat]
  return { x, y };
}

// Recursively descends GeoJSON-shaped geometry (a single geometry, an array
// of them, or nested coordinate arrays) down to the [x, y(, z)] leaves.
function flattenCoordinates(value: unknown): number[][] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    if (typeof value[0] === "number") {
      return [value as number[]];
    }
    return (value as unknown[]).flatMap(flattenCoordinates);
  }
  if (typeof value === "object" && "coordinates" in value) {
    return flattenCoordinates((value as { coordinates: unknown }).coordinates);
  }
  return [];
}
