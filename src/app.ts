import "leaflet/dist/leaflet.css";
import * as L from "leaflet";
import proj4 from "proj4";
import { parseShapefileToReferenceLine } from "./shapefile";
import type {
  Mode,
  Point,
  ProjectFile,
  ReferenceFrame,
  SoilLayer,
  SoilProfileLayerOutput,
  SoilProfileOutput,
} from "./types";

// Register EPSG:28992 (RD New) so the uploaded reference line (given in RD coordinates)
// can be shown on an OpenStreetMap (WGS84) mini-map.
const RD_DEF =
  "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.33,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs";
proj4.defs("EPSG:28992", RD_DEF);

function rdToWgs84(x: number, y: number): { lat: number; lng: number } {
  const [lng, lat] = proj4("EPSG:28992", "EPSG:4326", [x, y]);
  return { lat, lng };
}

const LAYER_COLORS = [
  "#e07a5f",
  "#81b29a",
  "#f2cc8f",
  "#3d5a80",
  "#e63946",
  "#2a9d8f",
  "#e9c46a",
  "#9b5de5",
  "#00b4d8",
  "#f4a261",
];

const CLICK_DRAG_THRESHOLD = 5;
const MIN_SCALE = 0.02;
const MAX_SCALE = 40;
const GENERATE_STEP_PX = 50;

function toSoilCode(name: string): string {
  const code = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return code || "unknown";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Removes soil layers thinner than `minLayerHeight`, splitting each removed
 * layer's thickness between the layers directly above and below it (or
 * giving it entirely to whichever of the two exists, at the top/bottom of
 * the profile). Layers are ordered top to bottom, as produced by buildSoilProfiles.
 */
function distributeThinLayers(
  soilLayers: SoilProfileLayerOutput[],
  minLayerHeight: number
): SoilProfileLayerOutput[] {
  const layers = soilLayers.map((layer) => ({ ...layer }));
  if (minLayerHeight <= 0) return layers;

  let i = 0;
  while (i < layers.length) {
    const thickness = layers[i].top - layers[i].bottom;
    if (layers.length === 1 || thickness >= minLayerHeight) {
      i++;
      continue;
    }

    const above = i > 0 ? layers[i - 1] : null;
    const below = i < layers.length - 1 ? layers[i + 1] : null;

    if (above && below) {
      const mid = round2((layers[i].top + layers[i].bottom) / 2);
      above.bottom = mid;
      below.top = mid;
    } else if (above) {
      above.bottom = layers[i].bottom;
    } else if (below) {
      below.top = layers[i].top;
    }

    layers.splice(i, 1);
    // Re-check the layer(s) that absorbed this space, in case that leaves them thin too.
    i = Math.max(0, i - 1);
  }

  return layers;
}

/** Merges consecutive layers that share a soil code (e.g. after distributeThinLayers) into one. */
function mergeAdjacentSameSoil(soilLayers: SoilProfileLayerOutput[]): SoilProfileLayerOutput[] {
  const merged: SoilProfileLayerOutput[] = [];
  for (const layer of soilLayers) {
    const last = merged[merged.length - 1];
    if (last && last.soil_code === layer.soil_code) {
      last.bottom = layer.bottom;
    } else {
      merged.push({ ...layer });
    }
  }
  return merged;
}

interface LabelHitBox {
  layerId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const PROFILE_BAR_WIDTH = 20;
const MIN_PANE_RATIO = 0.15;
const MAX_PANE_RATIO = 0.85;

const SHAPEFILE_REQUIRED_EXTENSIONS = ["shp", "shx", "dbf"];

function baseFileName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return (dot === -1 ? filename : filename.slice(0, dot)).toLowerCase();
}

export class App {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private container: HTMLElement;

  private canvasSplit: HTMLElement;
  private splitDivider: HTMLElement;
  private profileContainer: HTMLElement;
  private profileCanvas: HTMLCanvasElement;
  private profileCtx: CanvasRenderingContext2D;
  private splitRatio = 0.5;
  private isDraggingSplit = false;
  private soilProfiles: SoilProfileOutput[] | null = null;

  private image: HTMLImageElement | null = null;
  private imageFileName: string | null = null;
  private imageDataUrl: string | null = null;
  private awaitingImageForProject = false;
  private imageVisible = true;

  private scale = 1;
  private offset: Point = { x: 0, y: 0 };

  private mode: Mode = "pan";

  private referenceFrame: ReferenceFrame = {
    topLeft: { pixel: null, world: { x: 0, z: 0 } },
    bottomRight: { pixel: null, world: { x: 0, z: 0 } },
  };
  private referenceNextStep: "topLeft" | "bottomRight" = "topLeft";
  private referenceLine: Point[] | null = null;
  private referenceLineMap: L.Map | null = null;
  private referenceLineLayer: L.Polyline | null = null;
  private soilProfileMarkers: L.CircleMarker[] = [];

  private layers: SoilLayer[] = [];
  private layerCounter = 0;
  private currentLinePoints: Point[] | null = null;
  private mousePos: Point | null = null;

  /** Soil color, keyed by soil (layer) name. Layers sharing a name share a color. */
  private soilColors: Record<string, string> = {};

  private labelHitBoxes: LabelHitBox[] = [];

  private pickingColorForName: string | null = null;
  private sampleCanvas: HTMLCanvasElement | null = null;

  private isPanning = false;
  private panStartScreen: Point = { x: 0, y: 0 };
  private panStartOffset: Point = { x: 0, y: 0 };
  private mouseDownScreen: Point | null = null;

  private emptyHint: HTMLElement;
  private statusBar: HTMLElement;
  private layersList: HTMLElement;
  private tlPixelEl: HTMLElement;
  private brPixelEl: HTMLElement;
  private tlX: HTMLInputElement;
  private tlZ: HTMLInputElement;
  private brX: HTMLInputElement;
  private brZ: HTMLInputElement;
  private useReferenceLineEl: HTMLInputElement;
  private referenceLineMapEl: HTMLElement;
  private generateModal: HTMLElement;
  private minLayerHeightInput: HTMLInputElement;

  constructor() {
    this.container = document.getElementById("canvas-container")!;
    this.canvas = document.getElementById("canvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.canvasSplit = document.getElementById("canvas-split")!;
    this.splitDivider = document.getElementById("split-divider")!;
    this.profileContainer = document.getElementById("profile-container")!;
    this.profileCanvas = document.getElementById("profile-canvas") as HTMLCanvasElement;
    this.profileCtx = this.profileCanvas.getContext("2d")!;
    this.emptyHint = document.getElementById("empty-hint")!;
    this.statusBar = document.getElementById("status-bar")!;
    this.layersList = document.getElementById("layers-list")!;
    this.tlPixelEl = document.getElementById("tl-pixel")!;
    this.brPixelEl = document.getElementById("br-pixel")!;
    this.tlX = document.getElementById("tl-x") as HTMLInputElement;
    this.tlZ = document.getElementById("tl-z") as HTMLInputElement;
    this.brX = document.getElementById("br-x") as HTMLInputElement;
    this.brZ = document.getElementById("br-z") as HTMLInputElement;
    this.useReferenceLineEl = document.getElementById("use-referenceline") as HTMLInputElement;
    this.referenceLineMapEl = document.getElementById("referenceline-map")!;
    this.generateModal = document.getElementById("generate-modal")!;
    this.minLayerHeightInput = document.getElementById("min-layer-height") as HTMLInputElement;

    this.setupToolbar();
    this.setupCanvasEvents();
    this.setupResize();
    this.setupSplitDrag();
    this.setMode("pan");
    this.renderLayerList();
    this.resizeCanvas();
    this.resizeProfileCanvas();
    this.updateStatus();
    this.draw();
  }

  // ---------- setup ----------

  private setupToolbar() {
    const imageInput = document.getElementById("image-input") as HTMLInputElement;
    imageInput.addEventListener("change", () => {
      const file = imageInput.files?.[0];
      if (file) this.loadImage(file);
      imageInput.value = "";
    });

    const projectInput = document.getElementById("project-input") as HTMLInputElement;
    projectInput.addEventListener("change", () => {
      const file = projectInput.files?.[0];
      if (file) this.loadProjectFile(file);
      projectInput.value = "";
    });

    const referenceLineInput = document.getElementById("referenceline-input") as HTMLInputElement;
    referenceLineInput.addEventListener("change", () => {
      const files = Array.from(referenceLineInput.files ?? []);
      referenceLineInput.value = "";
      if (files.length > 0) this.loadReferenceLineFiles(files);
    });

    document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.setMode(btn.dataset.mode as Mode);
      });
    });

    document.getElementById("generate-btn")!.addEventListener("click", () => this.openGenerateModal());
    this.setupGenerateModal();
    document.getElementById("download-profile-btn")!.addEventListener("click", () => this.downloadSoilProfiles());
    document.getElementById("new-project-btn")!.addEventListener("click", () => this.newProject());
    document.getElementById("save-project-btn")!.addEventListener("click", () => this.saveProject());
    document.getElementById("load-project-btn")!.addEventListener("click", () => {
      projectInput.click();
    });
    document.getElementById("clear-lines-btn")!.addEventListener("click", () => this.clearLines());

    const toggleImageBtn = document.getElementById("toggle-image-btn") as HTMLButtonElement;
    toggleImageBtn.addEventListener("click", () => {
      this.imageVisible = !this.imageVisible;
      toggleImageBtn.classList.toggle("active", !this.imageVisible);
      toggleImageBtn.title = this.imageVisible ? "Hide Image" : "Show Image";
      this.draw();
    });

    this.tlX.addEventListener("input", () => this.updateWorldFromInputs());
    this.tlZ.addEventListener("input", () => this.updateWorldFromInputs());
    this.brX.addEventListener("input", () => this.updateWorldFromInputs());
    this.brZ.addEventListener("input", () => this.updateWorldFromInputs());
  }

  private updateWorldFromInputs() {
    this.referenceFrame.topLeft.world = {
      x: parseFloat(this.tlX.value) || 0,
      z: parseFloat(this.tlZ.value) || 0,
    };
    this.referenceFrame.bottomRight.world = {
      x: parseFloat(this.brX.value) || 0,
      z: parseFloat(this.brZ.value) || 0,
    };
  }

  // ---------- reference line ----------

  private async loadReferenceLineFiles(files: File[]) {
    try {
      const byExt = new Map<string, File>();
      for (const file of files) {
        const ext = file.name.split(".").pop()?.toLowerCase();
        if (ext) byExt.set(ext, file);
      }
      const missing = SHAPEFILE_REQUIRED_EXTENSIONS.filter((ext) => !byExt.has(ext));
      if (missing.length > 0) {
        throw new Error(`Select the .${missing.join(", .")} file${missing.length === 1 ? "" : "s"} too`);
      }

      const presentExtensions = byExt.has("prj")
        ? [...SHAPEFILE_REQUIRED_EXTENSIONS, "prj"]
        : SHAPEFILE_REQUIRED_EXTENSIONS;
      const baseNames = new Set(presentExtensions.map((ext) => baseFileName(byExt.get(ext)!.name)));
      if (baseNames.size > 1) {
        throw new Error("The .shp, .shx, .dbf and .prj files must belong to the same shapefile");
      }

      const shp = await byExt.get("shp")!.arrayBuffer();
      const prj = byExt.has("prj") ? await byExt.get("prj")!.text() : null;
      const points = parseShapefileToReferenceLine({ shp, prj });
      this.referenceLine = points;
      this.updateReferenceLineCheckbox();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Could not read that shapefile");
    }
  }

  private updateReferenceLineCheckbox() {
    const hasReferenceLine = !!this.referenceLine && this.referenceLine.length > 0;
    this.useReferenceLineEl.disabled = !hasReferenceLine;
    this.useReferenceLineEl.checked = hasReferenceLine;
    this.updateReferenceLineMap();
  }

  private updateReferenceLineMap() {
    this.clearSoilProfileMarkers();

    if (!this.referenceLine || this.referenceLine.length === 0) {
      this.referenceLineMapEl.classList.remove("visible");
      return;
    }

    this.referenceLineMapEl.classList.add("visible");

    const latLngs: L.LatLngExpression[] = this.referenceLine.map((p) => {
      const { lat, lng } = rdToWgs84(p.x, p.y);
      return [lat, lng];
    });

    if (!this.referenceLineMap) {
      this.referenceLineMap = L.map(this.referenceLineMapEl);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(this.referenceLineMap);
    }

    if (this.referenceLineLayer) {
      this.referenceLineLayer.remove();
    }
    this.referenceLineLayer = L.polyline(latLngs, { color: "#1f8f96", weight: 3 }).addTo(this.referenceLineMap);

    const map = this.referenceLineMap;
    const layer = this.referenceLineLayer;
    requestAnimationFrame(() => {
      map.invalidateSize();
      if (latLngs.length === 1) {
        map.setView(latLngs[0], 15);
      } else {
        map.fitBounds(layer.getBounds(), { padding: [20, 20] });
      }
    });
  }

  private clearSoilProfileMarkers() {
    this.soilProfileMarkers.forEach((marker) => marker.remove());
    this.soilProfileMarkers = [];
  }

  /** Plots the generated soil profile locations on the reference-line mini-map. */
  private updateSoilProfileMarkersOnMap() {
    this.clearSoilProfileMarkers();

    if (!this.referenceLineMap || !this.referenceLine || !this.useReferenceLineEl.checked || !this.soilProfiles) {
      return;
    }

    const outputProfiles = this.buildOutputSoilProfiles(this.soilProfiles);
    const map = this.referenceLineMap;
    for (const profile of outputProfiles) {
      const { lat, lng } = rdToWgs84(profile.x, profile.y);
      const marker = L.circleMarker([lat, lng], {
        radius: 5,
        color: "#fff",
        weight: 2,
        fillColor: "#f2cc8f",
        fillOpacity: 1,
      }).addTo(map);
      this.soilProfileMarkers.push(marker);
    }
  }

  private setupResize() {
    const ro = new ResizeObserver(() => {
      this.resizeCanvas();
      this.resizeProfileCanvas();
      this.draw();
    });
    ro.observe(this.container);
    ro.observe(this.profileContainer);
  }

  private setupSplitDrag() {
    this.splitDivider.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.isDraggingSplit = true;
      this.splitDivider.classList.add("dragging");
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.isDraggingSplit) return;
      const rect = this.canvasSplit.getBoundingClientRect();
      const dividerHeight = this.splitDivider.getBoundingClientRect().height;
      const usable = rect.height - dividerHeight;
      if (usable <= 0) return;
      const ratio = (e.clientY - rect.top) / usable;
      this.splitRatio = Math.min(MAX_PANE_RATIO, Math.max(MIN_PANE_RATIO, ratio));
      this.applySplitRatio();
      this.resizeCanvas();
      this.resizeProfileCanvas();
      this.draw();
    });
    window.addEventListener("mouseup", () => {
      if (!this.isDraggingSplit) return;
      this.isDraggingSplit = false;
      this.splitDivider.classList.remove("dragging");
    });
  }

  private showProfileView() {
    this.splitDivider.classList.add("visible");
    this.profileContainer.classList.add("visible");
    this.splitRatio = 0.5;
    this.applySplitRatio();
  }

  private hideProfileView() {
    this.soilProfiles = null;
    this.clearSoilProfileMarkers();
    this.splitDivider.classList.remove("visible");
    this.profileContainer.classList.remove("visible");
    this.container.style.flex = "";
    this.profileContainer.style.flex = "";
  }

  private applySplitRatio() {
    this.container.style.flex = `${this.splitRatio} 1 0`;
    this.profileContainer.style.flex = `${1 - this.splitRatio} 1 0`;
  }

  private setupCanvasEvents() {
    this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
    window.addEventListener("mousemove", (e) => this.onMouseMove(e));
    window.addEventListener("mouseup", (e) => this.onMouseUp(e));
    this.canvas.addEventListener("click", (e) => this.onClick(e));
    this.canvas.addEventListener("dblclick", (e) => this.onDblClick(e));
    this.canvas.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
  }

  // ---------- image loading ----------

  /**
   * Loads an image file selected via the file input. When `resetProject` (the default) is true
   * this behaves like starting fresh work on a new image. When called while waiting for a
   * project's image to be re-selected, `resetProject` is false so the already-restored
   * layers/reference stay intact.
   */
  private loadImage(file: File): Promise<void> {
    const resetProject = !this.awaitingImageForProject;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        this.decodeAndSetImage(dataUrl, file.name, resetProject).then(resolve, reject);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  private decodeAndSetImage(dataUrl: string, fileName: string, resetProject: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        if (resetProject) this.clearData();
        this.image = img;
        this.imageFileName = fileName;
        this.imageDataUrl = dataUrl;
        this.sampleCanvas = null;
        this.awaitingImageForProject = false;
        this.fitToView();
        this.emptyHint.classList.add("hidden");
        this.draw();
        this.updateStatus();
        resolve();
      };
      img.onerror = () => reject(new Error("Could not decode image."));
      img.src = dataUrl;
    });
  }

  /** Clears layers, in-progress drawing, and reference points. Leaves the loaded image untouched. */
  private clearData() {
    this.layers = [];
    this.layerCounter = 0;
    this.soilColors = {};
    this.currentLinePoints = null;
    this.mousePos = null;
    this.referenceFrame = {
      topLeft: { pixel: null, world: { x: 0, z: 0 } },
      bottomRight: { pixel: null, world: { x: 0, z: 0 } },
    };
    this.referenceNextStep = "topLeft";
    this.referenceLine = null;
    this.updateReferenceLineCheckbox();
    this.hideProfileView();
    this.updateReferenceInputs();
    this.renderLayerList();
  }

  private newProject() {
    if (!this.image && this.layers.length === 0) return;
    const proceed = window.confirm(
      "Start a new project? This removes the current image and all drawn data."
    );
    if (!proceed) return;

    this.clearData();
    this.image = null;
    this.imageFileName = null;
    this.imageDataUrl = null;
    this.sampleCanvas = null;
    this.awaitingImageForProject = false;
    this.cancelColorPick();
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.setMode("pan");
    this.emptyHint.textContent = "Upload an image to get started";
    this.emptyHint.classList.remove("hidden");
    this.resizeCanvas();
    this.draw();
    this.updateStatus();
  }

  // ---------- project save / load ----------

  private saveProject() {
    if (!this.image || !this.imageDataUrl) {
      window.alert("Upload an image first.");
      return;
    }

    const project: ProjectFile = {
      version: 1,
      image: { fileName: this.imageFileName ?? "image", dataUrl: this.imageDataUrl },
      referenceFrame: this.referenceFrame,
      layers: this.layers,
      layerCounter: this.layerCounter,
      soilColors: this.soilColors,
      referenceLine: this.referenceLine,
    };
    this.downloadJson(project, "project.json");
  }

  private async loadProjectFile(file: File) {
    let project: ProjectFile;
    try {
      project = JSON.parse(await file.text());
    } catch {
      window.alert("Could not read project file: invalid JSON.");
      return;
    }
    if (
      !project ||
      typeof project !== "object" ||
      !Array.isArray(project.layers) ||
      typeof project.soilColors !== "object"
    ) {
      window.alert("This file doesn't look like a GeoScanner project.");
      return;
    }

    this.clearData();
    this.image = null;
    this.imageDataUrl = null;
    this.imageFileName = project.image?.fileName ?? null;
    this.awaitingImageForProject = false;
    this.referenceFrame = project.referenceFrame;
    this.layers = project.layers;
    this.soilColors = project.soilColors;
    this.layerCounter = project.layerCounter ?? this.layers.length;
    this.referenceLine = project.referenceLine ?? null;
    this.updateReferenceLineCheckbox();
    this.updateReferenceInputs();
    this.renderLayerList();

    if (project.image?.dataUrl) {
      try {
        await this.decodeAndSetImage(project.image.dataUrl, project.image.fileName, false);
      } catch {
        this.reportMissingImage();
      }
    } else {
      this.reportMissingImage();
    }

    this.draw();
    this.updateStatus();
  }

  /** Leaves the restored layers/reference points in place and waits for the user to upload the image. */
  private reportMissingImage() {
    this.awaitingImageForProject = true;
    const message = this.imageFileName
      ? `Could not load the embedded image "${this.imageFileName}" for this project. Click "Upload Image" and select it again to restore the view.`
      : "This project was saved without an image. Upload one to continue.";
    window.alert(message);
    this.emptyHint.textContent = message;
    this.emptyHint.classList.remove("hidden");
  }

  private fitToView() {
    if (!this.image) return;
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    const scale = Math.min(cw / this.image.width, ch / this.image.height) * 0.95;
    this.scale = scale;
    this.offset = {
      x: (cw - this.image.width * scale) / 2,
      y: (ch - this.image.height * scale) / 2,
    };
  }

  private resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private resizeProfileCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.profileContainer.clientWidth;
    const ch = this.profileContainer.clientHeight;
    this.profileCanvas.width = Math.round(cw * dpr);
    this.profileCanvas.height = Math.round(ch * dpr);
    this.profileCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- mode ----------

  private setMode(mode: Mode) {
    this.mode = mode;
    this.currentLinePoints = null;
    document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    this.container.classList.remove("mode-pan", "mode-reference", "mode-draw");
    this.container.classList.add(`mode-${mode}`);
    this.updateStatus();
    this.draw();
  }

  // ---------- coordinate transforms ----------

  private screenToImage(p: Point): Point {
    return {
      x: (p.x - this.offset.x) / this.scale,
      y: (p.y - this.offset.y) / this.scale,
    };
  }

  private imageToScreen(p: Point): Point {
    return {
      x: p.x * this.scale + this.offset.x,
      y: p.y * this.scale + this.offset.y,
    };
  }

  private getCanvasPoint(e: MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ---------- mouse events ----------

  private onMouseDown(e: MouseEvent) {
    if (!this.image) return;
    this.mouseDownScreen = this.getCanvasPoint(e);

    const isMiddleButton = e.button === 1;
    if (isMiddleButton || (this.mode === "pan" && e.button === 0)) {
      if (isMiddleButton) e.preventDefault();
      this.isPanning = true;
      this.panStartScreen = this.getCanvasPoint(e);
      this.panStartOffset = { ...this.offset };
      this.container.classList.add("panning");
    }
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.image) return;
    const screenPt = this.getCanvasPoint(e);

    if (this.isPanning) {
      this.offset = {
        x: this.panStartOffset.x + (screenPt.x - this.panStartScreen.x),
        y: this.panStartOffset.y + (screenPt.y - this.panStartScreen.y),
      };
      this.draw();
      return;
    }

    this.mousePos = this.screenToImage(screenPt);
    if (this.mode === "draw" && this.currentLinePoints) {
      this.draw();
    }
    this.updateStatus();
  }

  private onMouseUp(_e: MouseEvent) {
    if (this.isPanning) {
      this.isPanning = false;
      this.container.classList.remove("panning");
    }
    this.mouseDownScreen = null;
  }

  private wasDrag(e: MouseEvent): boolean {
    if (!this.mouseDownScreen) return false;
    const p = this.getCanvasPoint(e);
    const dx = p.x - this.mouseDownScreen.x;
    const dy = p.y - this.mouseDownScreen.y;
    return Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD;
  }

  private onClick(e: MouseEvent) {
    if (!this.image) return;
    if (this.wasDrag(e)) return;

    const screenPt = this.getCanvasPoint(e);

    if (this.pickingColorForName) {
      this.handleColorPickClick(screenPt);
      return;
    }

    const hit = this.hitTestLabel(screenPt);
    if (hit) {
      this.renameLayer(hit);
      return;
    }

    if (this.mode === "reference") {
      this.handleReferenceClick(screenPt);
    } else if (this.mode === "draw") {
      this.handleDrawClick(screenPt);
    }
  }

  private onDblClick(e: MouseEvent) {
    if (!this.image || this.mode !== "draw") return;
    e.preventDefault();
    this.finishCurrentLine();
  }

  private onContextMenu(e: MouseEvent) {
    e.preventDefault();
    if (!this.image || this.mode !== "draw") return;
    if (!this.currentLinePoints || this.currentLinePoints.length === 0) return;
    this.currentLinePoints.pop();
    if (this.currentLinePoints.length === 0) {
      this.currentLinePoints = null;
    }
    this.draw();
    this.updateStatus();
  }

  private onWheel(e: WheelEvent) {
    if (!this.image) return;
    e.preventDefault();
    const screenPt = this.getCanvasPoint(e);
    const before = this.screenToImage(screenPt);

    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));

    const after = this.imageToScreen(before);
    this.offset = {
      x: this.offset.x - (after.x - screenPt.x),
      y: this.offset.y - (after.y - screenPt.y),
    };

    this.draw();
    this.updateStatus();
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (this.generateModal.classList.contains("visible")) {
      this.closeGenerateModal();
    } else if (this.pickingColorForName) {
      this.cancelColorPick();
    } else if (this.currentLinePoints) {
      this.currentLinePoints = null;
      this.draw();
      this.updateStatus();
    }
  }

  // ---------- reference points ----------

  private handleReferenceClick(screenPt: Point) {
    const imgPt = this.clampToImage(this.screenToImage(screenPt));
    if (this.referenceNextStep === "topLeft") {
      this.referenceFrame.topLeft.pixel = imgPt;
      this.referenceNextStep = "bottomRight";
    } else {
      this.referenceFrame.bottomRight.pixel = imgPt;
      this.referenceNextStep = "topLeft";
    }
    this.updateReferenceInputs();
    this.draw();
    this.updateStatus();
  }

  private clampToImage(p: Point): Point {
    if (!this.image) return p;
    return {
      x: Math.min(Math.max(p.x, 0), this.image.width),
      y: Math.min(Math.max(p.y, 0), this.image.height),
    };
  }

  private updateReferenceInputs() {
    const tl = this.referenceFrame.topLeft;
    const br = this.referenceFrame.bottomRight;
    this.tlPixelEl.textContent = tl.pixel
      ? `${tl.pixel.x.toFixed(1)}, ${tl.pixel.y.toFixed(1)}`
      : "not set";
    this.brPixelEl.textContent = br.pixel
      ? `${br.pixel.x.toFixed(1)}, ${br.pixel.y.toFixed(1)}`
      : "not set";
    this.tlX.value = String(tl.world.x);
    this.tlZ.value = String(tl.world.z);
    this.brX.value = String(br.world.x);
    this.brZ.value = String(br.world.z);
  }

  // ---------- drawing lines ----------

  private handleDrawClick(screenPt: Point) {
    const imgPt = this.screenToImage(screenPt);
    if (!this.currentLinePoints) {
      this.currentLinePoints = [imgPt];
    } else {
      this.currentLinePoints.push(imgPt);
    }
    this.draw();
    this.updateStatus();
  }

  private finishCurrentLine() {
    if (!this.currentLinePoints) return;
    // The second click of the double-click already added a duplicate vertex; drop it.
    const points = this.currentLinePoints.slice(0, -1);
    this.currentLinePoints = null;

    if (points.length < 2) {
      this.draw();
      this.updateStatus();
      return;
    }

    const defaultName = `Layer ${this.layerCounter + 1}`;
    const name = window.prompt("Soil name for this layer:", defaultName);
    if (name === null) {
      this.draw();
      this.updateStatus();
      return;
    }

    this.layerCounter += 1;
    const layerName = name.trim() || defaultName;
    this.colorForSoilName(layerName);
    const layer: SoilLayer = {
      id: `layer-${Date.now()}-${this.layerCounter}`,
      points,
      name: layerName,
    };
    this.layers.push(layer);
    this.renderLayerList();
    this.draw();
    this.updateStatus();
  }

  private renameLayer(layerId: string) {
    const layer = this.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const name = window.prompt("Soil name for this layer:", layer.name);
    if (name === null) return;
    layer.name = name.trim() || layer.name;
    this.colorForSoilName(layer.name);
    this.renderLayerList();
    this.draw();
  }

  private deleteLayer(layerId: string) {
    this.layers = this.layers.filter((l) => l.id !== layerId);
    this.renderLayerList();
    this.draw();
  }

  private clearLines() {
    if (this.layers.length === 0 && !this.currentLinePoints) return;
    const proceed = window.confirm("Clear all drawn soil layer lines?");
    if (!proceed) return;

    this.layers = [];
    this.layerCounter = 0;
    this.currentLinePoints = null;
    this.hideProfileView();
    this.renderLayerList();
    this.draw();
    this.updateStatus();
  }

  private renderLayerList() {
    this.layersList.innerHTML = "";
    if (this.layers.length === 0) {
      const li = document.createElement("li");
      li.className = "layers-empty";
      li.textContent = "No soil layers yet.";
      this.layersList.appendChild(li);
      return;
    }
    const seenNames = new Set<string>();
    const uniqueLayers = this.layers.filter((layer) => {
      if (seenNames.has(layer.name)) return false;
      seenNames.add(layer.name);
      return true;
    });
    uniqueLayers.forEach((layer) => {
      const li = document.createElement("li");
      li.className = "layer-item";

      const swatch = document.createElement("span");
      swatch.className = "layer-swatch";
      swatch.style.background = this.colorForSoilName(layer.name);
      swatch.title = "Click to pick a color from the image";
      swatch.addEventListener("click", () => this.startColorPick(layer.name));

      const name = document.createElement("span");
      name.className = "layer-name";
      name.textContent = layer.name;
      name.title = "Click to rename";
      name.addEventListener("click", () => this.renameLayer(layer.id));

      const del = document.createElement("button");
      del.className = "layer-delete";
      del.textContent = "×";
      del.title = "Delete layer";
      del.addEventListener("click", () => this.deleteLayer(layer.id));

      li.append(swatch, name, del);
      this.layersList.appendChild(li);
    });
  }

  private colorForLayer(index: number): string {
    return LAYER_COLORS[index % LAYER_COLORS.length];
  }

  /** Returns the color for a soil name, assigning the next palette color the first time it's seen. */
  private colorForSoilName(name: string): string {
    const existing = this.soilColors[name];
    if (existing) return existing;
    const color = this.colorForLayer(Object.keys(this.soilColors).length);
    this.soilColors[name] = color;
    return color;
  }

  // ---------- color picking ----------

  private startColorPick(soilName: string) {
    if (!this.image) {
      window.alert("Upload an image first.");
      return;
    }
    this.pickingColorForName = soilName;
    this.container.classList.add("picking-color");
    this.updateStatus();
  }

  private cancelColorPick() {
    this.pickingColorForName = null;
    this.container.classList.remove("picking-color");
    this.updateStatus();
  }

  private handleColorPickClick(screenPt: Point) {
    const soilName = this.pickingColorForName;
    this.pickingColorForName = null;
    this.container.classList.remove("picking-color");

    if (soilName) {
      const imgPt = this.clampToImage(this.screenToImage(screenPt));
      const color = this.sampleImageColorAt(imgPt);
      if (color) {
        this.soilColors[soilName] = color;
        this.renderLayerList();
        this.draw();
      }
    }
    this.updateStatus();
  }

  /** Draws the loaded image into an offscreen canvas (once per image) so pixel colors can be sampled. */
  private ensureSampleCanvas(): HTMLCanvasElement | null {
    if (!this.image) return null;
    if (
      this.sampleCanvas &&
      this.sampleCanvas.width === this.image.width &&
      this.sampleCanvas.height === this.image.height
    ) {
      return this.sampleCanvas;
    }
    const canvas = document.createElement("canvas");
    canvas.width = this.image.width;
    canvas.height = this.image.height;
    canvas.getContext("2d")!.drawImage(this.image, 0, 0);
    this.sampleCanvas = canvas;
    return canvas;
  }

  private sampleImageColorAt(imagePt: Point): string | null {
    const canvas = this.ensureSampleCanvas();
    if (!canvas) return null;
    const x = Math.min(canvas.width - 1, Math.max(0, Math.round(imagePt.x)));
    const y = Math.min(canvas.height - 1, Math.max(0, Math.round(imagePt.y)));
    const [r, g, b] = canvas.getContext("2d")!.getImageData(x, y, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  // ---------- generate ----------

  private setupGenerateModal() {
    const cancelBtn = document.getElementById("generate-modal-cancel") as HTMLButtonElement;
    const confirmBtn = document.getElementById("generate-modal-confirm") as HTMLButtonElement;

    cancelBtn.addEventListener("click", () => this.closeGenerateModal());
    this.generateModal.addEventListener("click", (e) => {
      if (e.target === this.generateModal) this.closeGenerateModal();
    });
    confirmBtn.addEventListener("click", () => this.confirmGenerate());
    this.minLayerHeightInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.confirmGenerate();
    });
  }

  private openGenerateModal() {
    if (!this.image) {
      window.alert("Upload an image first.");
      return;
    }
    const tl = this.referenceFrame.topLeft;
    const br = this.referenceFrame.bottomRight;

    if (!tl.pixel || !br.pixel) {
      window.alert("Set both reference points before generating.");
      return;
    }
    if (this.layers.length === 0) {
      window.alert("Draw at least one soil layer line before generating.");
      return;
    }

    this.minLayerHeightInput.value = "0.1";
    this.generateModal.classList.add("visible");
    this.minLayerHeightInput.focus();
    this.minLayerHeightInput.select();
  }

  private closeGenerateModal() {
    this.generateModal.classList.remove("visible");
  }

  private confirmGenerate() {
    const parsed = parseFloat(this.minLayerHeightInput.value);
    const minLayerHeight = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.1;
    this.closeGenerateModal();
    this.generate(minLayerHeight);
  }

  private generate(minLayerHeight: number) {
    const profiles = this.buildSoilProfiles(minLayerHeight);
    if (profiles.length === 0) {
      window.alert("No soil layer intersections were found between the reference points.");
      return;
    }

    this.soilProfiles = profiles;
    this.showProfileView();
    this.resizeCanvas();
    this.resizeProfileCanvas();
    this.draw();
    this.updateSoilProfileMarkersOnMap();
  }

  private downloadSoilProfiles() {
    if (!this.soilProfiles) return;
    const output = this.buildOutputSoilProfiles(this.soilProfiles);
    this.downloadJson(
      { soil_profiles: output, soil_colors: this.buildCodeToColor() },
      "soil_profiles.json"
    );
  }

  private buildSoilProfiles(minLayerHeight: number): SoilProfileOutput[] {
    const tl = this.referenceFrame.topLeft;
    const br = this.referenceFrame.bottomRight;
    if (!tl.pixel || !br.pixel) return [];

    const startPx = Math.min(tl.pixel.x, br.pixel.x);
    const endPx = Math.max(tl.pixel.x, br.pixel.x);

    const profiles: SoilProfileOutput[] = [];

    for (let px = startPx; px <= endPx; px += GENERATE_STEP_PX) {
      const intersections: { z: number; code: string }[] = [];
      for (const layer of this.layers) {
        const py = this.intersectionYAtPixelX(layer.points, px);
        if (py === null) continue;
        intersections.push({ z: this.pixelYToWorldZ(py), code: toSoilCode(layer.name) });
      }

      if (intersections.length === 0) continue;

      // Top of ground (highest world z) first, deepest last.
      intersections.sort((a, b) => b.z - a.z);

      const bottomIndex = intersections.findIndex((i) => i.code === "bottom");
      const relevant =
        bottomIndex === -1 ? intersections : intersections.slice(0, bottomIndex + 1);

      if (relevant.length < 2) continue;

      const soilLayers: SoilProfileLayerOutput[] = [];
      for (let i = 0; i < relevant.length - 1; i++) {
        soilLayers.push({
          top: round2(relevant[i].z),
          bottom: round2(relevant[i + 1].z),
          soil_code: relevant[i].code,
        });
      }

      profiles.push({
        x: round2(this.pixelXToWorldX(px)),
        y: 0,
        soil_layers: mergeAdjacentSameSoil(distributeThinLayers(soilLayers, minLayerHeight)),
      });
    }

    return profiles;
  }

  /**
   * Maps display profiles (positioned by pixel x, y = 0) to their real-world x, y for the
   * downloadable output, by projecting each profile's world x as a distance along the reference
   * line, starting from the top-left reference point. Only applied when a reference line is
   * uploaded and "Use Referenceline" is checked; profiles beyond the line's length are dropped.
   */
  private buildOutputSoilProfiles(profiles: SoilProfileOutput[]): SoilProfileOutput[] {
    if (!this.referenceLine || !this.useReferenceLineEl.checked) return profiles;

    const tl = this.referenceFrame.topLeft;
    const output: SoilProfileOutput[] = [];
    for (const profile of profiles) {
      const point = this.pointAtDistanceAlongReferenceLine(profile.x - tl.world.x);
      if (!point) continue; // beyond the reference line's length
      output.push({ x: round2(point.x), y: round2(point.y), soil_layers: profile.soil_layers });
    }
    return output;
  }

  /** Finds where a vertical line at image-space `px` crosses the given polyline, if at all. */
  private intersectionYAtPixelX(points: Point[], px: number): number | null {
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      if (p0.x === p1.x) continue;
      const xMin = Math.min(p0.x, p1.x);
      const xMax = Math.max(p0.x, p1.x);
      const isLastSegment = i === points.length - 2;
      const inRange = isLastSegment ? px >= xMin && px <= xMax : px >= xMin && px < xMax;
      if (inRange) {
        const t = (px - p0.x) / (p1.x - p0.x);
        return p0.y + t * (p1.y - p0.y);
      }
    }
    return null;
  }

  private pixelXToWorldX(px: number): number {
    const tl = this.referenceFrame.topLeft;
    const br = this.referenceFrame.bottomRight;
    if (!tl.pixel || !br.pixel || tl.pixel.x === br.pixel.x) return 0;
    const t = (px - tl.pixel.x) / (br.pixel.x - tl.pixel.x);
    return tl.world.x + t * (br.world.x - tl.world.x);
  }

  private pixelYToWorldZ(py: number): number {
    const tl = this.referenceFrame.topLeft;
    const br = this.referenceFrame.bottomRight;
    if (!tl.pixel || !br.pixel || tl.pixel.y === br.pixel.y) return 0;
    const t = (py - tl.pixel.y) / (br.pixel.y - tl.pixel.y);
    return tl.world.z + t * (br.world.z - tl.world.z);
  }

  /**
   * Walks the reference line from its start and returns the world (x, y) point at the given
   * distance along it, or null when the distance is negative or exceeds the line's total length.
   */
  private pointAtDistanceAlongReferenceLine(distance: number): Point | null {
    const line = this.referenceLine;
    if (!line || line.length === 0 || distance < -1e-6) return null;

    if (line.length === 1) {
      return Math.abs(distance) < 1e-6 ? { x: line[0].x, y: line[0].y } : null;
    }

    let remaining = Math.max(0, distance);
    for (let i = 0; i < line.length - 1; i++) {
      const p0 = line[i];
      const p1 = line[i + 1];
      const segLength = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (remaining <= segLength + 1e-6) {
        const t = segLength === 0 ? 0 : remaining / segLength;
        return { x: p0.x + t * (p1.x - p0.x), y: p0.y + t * (p1.y - p0.y) };
      }
      remaining -= segLength;
    }
    return null;
  }

  private downloadJson(data: unknown, filename: string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- label hit testing ----------

  private hitTestLabel(screenPt: Point): string | null {
    for (const box of this.labelHitBoxes) {
      if (
        screenPt.x >= box.x &&
        screenPt.x <= box.x + box.w &&
        screenPt.y >= box.y &&
        screenPt.y <= box.y + box.h
      ) {
        return box.layerId;
      }
    }
    return null;
  }

  private polylineMidpoint(points: Point[]): Point {
    if (points.length === 1) return points[0];
    let total = 0;
    const lengths: number[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const d = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
      lengths.push(d);
      total += d;
    }
    let target = total / 2;
    for (let i = 0; i < lengths.length; i++) {
      if (target <= lengths[i]) {
        const t = lengths[i] === 0 ? 0 : target / lengths[i];
        return {
          x: points[i].x + (points[i + 1].x - points[i].x) * t,
          y: points[i].y + (points[i + 1].y - points[i].y) * t,
        };
      }
      target -= lengths[i];
    }
    return points[points.length - 1];
  }

  // ---------- render ----------

  private draw() {
    const ctx = this.ctx;
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    ctx.clearRect(0, 0, cw, ch);
    this.labelHitBoxes = [];

    if (!this.image) return;

    if (this.imageVisible) {
      ctx.drawImage(
        this.image,
        this.offset.x,
        this.offset.y,
        this.image.width * this.scale,
        this.image.height * this.scale
      );
    }

    this.drawReferencePoints();
    this.layers.forEach((layer) => this.drawLayer(layer, this.colorForSoilName(layer.name)));
    this.drawCurrentLine();
    this.drawProfiles();
  }

  private drawReferencePoints() {
    const ctx = this.ctx;
    const draw = (pixel: Point | null, label: string) => {
      if (!pixel) return;
      const s = this.imageToScreen(pixel);
      ctx.save();
      ctx.strokeStyle = "#ffd166";
      ctx.fillStyle = "#ffd166";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x - 8, s.y);
      ctx.lineTo(s.x + 8, s.y);
      ctx.moveTo(s.x, s.y - 8);
      ctx.lineTo(s.x, s.y + 8);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(label, s.x + 10, s.y - 10);
      ctx.restore();
    };
    draw(this.referenceFrame.topLeft.pixel, "TL");
    draw(this.referenceFrame.bottomRight.pixel, "BR");
  }

  private drawLayer(layer: SoilLayer, color: string) {
    const ctx = this.ctx;
    if (layer.points.length < 2) return;
    const screenPts = layer.points.map((p) => this.imageToScreen(p));

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    screenPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();

    ctx.fillStyle = color;
    screenPts.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();

    this.drawLayerLabel(layer, color);
  }

  private drawLayerLabel(layer: SoilLayer, color: string) {
    const ctx = this.ctx;
    const midImg = this.polylineMidpoint(layer.points);
    const mid = this.imageToScreen(midImg);

    ctx.save();
    ctx.font = "600 12px system-ui, sans-serif";
    const textWidth = ctx.measureText(layer.name).width;
    const paddingX = 8;
    const paddingY = 5;
    const w = textWidth + paddingX * 2;
    const h = 12 + paddingY * 2;
    const x = mid.x - w / 2;
    const y = mid.y - h / 2;

    ctx.fillStyle = "rgba(20, 20, 24, 0.85)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    this.roundRect(x, y, w, h, 5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(layer.name, mid.x, mid.y + 1);
    ctx.restore();

    this.labelHitBoxes.push({ layerId: layer.id, x, y, w, h });
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private drawCurrentLine() {
    if (!this.currentLinePoints || this.currentLinePoints.length === 0) return;
    const ctx = this.ctx;
    const screenPts = this.currentLinePoints.map((p) => this.imageToScreen(p));

    ctx.save();
    ctx.strokeStyle = "#f4a261";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    screenPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();

    if (this.mousePos) {
      const last = screenPts[screenPts.length - 1];
      const mouseScreen = this.imageToScreen(this.mousePos);
      ctx.strokeStyle = "rgba(244, 162, 97, 0.6)";
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(mouseScreen.x, mouseScreen.y);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.fillStyle = "#f4a261";
    screenPts.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  // ---------- soil profile view ----------

  private worldXToPixelX(worldX: number): number {
    const tl = this.referenceFrame.topLeft;
    const br = this.referenceFrame.bottomRight;
    if (!tl.pixel || !br.pixel || br.world.x === tl.world.x) return 0;
    const t = (worldX - tl.world.x) / (br.world.x - tl.world.x);
    return tl.pixel.x + t * (br.pixel.x - tl.pixel.x);
  }

  private buildCodeToColor(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const layer of this.layers) {
      const code = toSoilCode(layer.name);
      if (code === "bottom") continue;
      map[code] = this.colorForSoilName(layer.name);
    }
    return map;
  }

  /** Rounds a rough axis step up to a "nice" 1/2/5 * 10^n value. */
  private niceStep(roughStep: number): number {
    if (!isFinite(roughStep) || roughStep <= 0) return 1;
    const exponent = Math.floor(Math.log10(roughStep));
    const base = Math.pow(10, exponent);
    const fraction = roughStep / base;
    const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return niceFraction * base;
  }

  private drawProfiles() {
    const ctx = this.profileCtx;
    const cw = this.profileContainer.clientWidth;
    const ch = this.profileContainer.clientHeight;
    ctx.clearRect(0, 0, cw, ch);

    if (!this.soilProfiles || this.soilProfiles.length === 0) return;

    let zMin = Infinity;
    let zMax = -Infinity;
    for (const profile of this.soilProfiles) {
      for (const seg of profile.soil_layers) {
        zMin = Math.min(zMin, seg.bottom);
        zMax = Math.max(zMax, seg.top);
      }
    }
    if (!isFinite(zMin) || !isFinite(zMax)) return;
    if (zMax === zMin) {
      zMax += 1;
      zMin -= 1;
    }
    const zPad = (zMax - zMin) * 0.08;
    const domainMin = zMin - zPad;
    const domainMax = zMax + zPad;

    const marginLeft = 56;
    const marginBottom = 26;
    const marginTop = 10;
    const plotBottom = ch - marginBottom;
    const plotHeight = Math.max(1, plotBottom - marginTop);
    const zToY = (z: number) => marginTop + ((domainMax - z) / (domainMax - domainMin)) * plotHeight;

    const codeToColor = this.buildCodeToColor();

    ctx.save();
    for (const profile of this.soilProfiles) {
      const pixelX = this.worldXToPixelX(profile.x);
      const screenX = pixelX * this.scale + this.offset.x;
      if (screenX < marginLeft - PROFILE_BAR_WIDTH || screenX > cw + PROFILE_BAR_WIDTH) continue;
      for (const seg of profile.soil_layers) {
        const yTop = zToY(seg.top);
        const yBottom = zToY(seg.bottom);
        ctx.fillStyle = codeToColor[seg.soil_code] ?? "#888888";
        ctx.fillRect(
          screenX - PROFILE_BAR_WIDTH / 2,
          yTop,
          PROFILE_BAR_WIDTH,
          Math.max(1, yBottom - yTop)
        );
      }
    }
    ctx.restore();

    this.drawProfileAxes(zToY, domainMin, domainMax, marginLeft, marginTop, plotBottom, cw);
  }

  private drawProfileAxes(
    zToY: (z: number) => number,
    domainMin: number,
    domainMax: number,
    marginLeft: number,
    marginTop: number,
    plotBottom: number,
    cw: number
  ) {
    const ctx = this.profileCtx;
    ctx.save();

    // Z axis (depth/level) ticks and gridlines.
    const targetZTicks = Math.max(2, Math.floor((plotBottom - marginTop) / 50));
    const zStep = this.niceStep((domainMax - domainMin) / targetZTicks);
    const zStart = Math.ceil(domainMin / zStep) * zStep;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let z = zStart; z <= domainMax; z += zStep) {
      const y = zToY(z);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      ctx.beginPath();
      ctx.moveTo(marginLeft, y);
      ctx.lineTo(cw, y);
      ctx.stroke();
      ctx.fillStyle = "#8a8d99";
      ctx.fillText(z.toFixed(2), marginLeft - 6, y);
    }

    // X axis (world x) ticks, based on the world-x range currently visible.
    const leftWorldX = this.pixelXToWorldX(this.screenToImage({ x: marginLeft, y: 0 }).x);
    const rightWorldX = this.pixelXToWorldX(this.screenToImage({ x: cw, y: 0 }).x);
    const worldMin = Math.min(leftWorldX, rightWorldX);
    const worldMax = Math.max(leftWorldX, rightWorldX);
    const targetXTicks = Math.max(2, Math.floor((cw - marginLeft) / 80));
    const xStep = this.niceStep((worldMax - worldMin) / targetXTicks);
    const xStart = Math.ceil(worldMin / xStep) * xStep;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let x = xStart; x <= worldMax; x += xStep) {
      const screenX = this.worldXToPixelX(x) * this.scale + this.offset.x;
      if (screenX < marginLeft || screenX > cw) continue;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      ctx.beginPath();
      ctx.moveTo(screenX, marginTop);
      ctx.lineTo(screenX, plotBottom);
      ctx.stroke();
      ctx.fillStyle = "#8a8d99";
      ctx.fillText(x.toFixed(2), screenX, plotBottom + 4);
    }

    // Axis border lines.
    ctx.strokeStyle = "#8a8d99";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(marginLeft, marginTop);
    ctx.lineTo(marginLeft, plotBottom);
    ctx.lineTo(cw, plotBottom);
    ctx.stroke();

    ctx.restore();
  }

  // ---------- status ----------

  private updateStatus() {
    if (this.pickingColorForName) {
      this.statusBar.textContent = `Click on the image to pick a color for "${this.pickingColorForName}"   •   Esc to cancel`;
      return;
    }
    const modeLabel: Record<Mode, string> = {
      pan: "Pan / Zoom",
      reference: "Set Reference Points",
      draw: "Draw Soil Layer",
    };
    const parts = [`Mode: ${modeLabel[this.mode]}`, `Zoom: ${(this.scale * 100).toFixed(0)}%`];
    if (this.mode === "reference") {
      parts.push(
        `Next click sets: ${this.referenceNextStep === "topLeft" ? "top-left" : "bottom-right"}`
      );
    }
    if (this.mode === "draw" && this.currentLinePoints) {
      parts.push(`Points: ${this.currentLinePoints.length}`);
    }
    this.statusBar.textContent = parts.join("   •   ");
  }
}
