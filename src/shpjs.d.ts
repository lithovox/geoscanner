declare module "shpjs" {
  export function parseShp(shp: ArrayBuffer | ArrayBufferView, prj?: string | false): unknown;
}
