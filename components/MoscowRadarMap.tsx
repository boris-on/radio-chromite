"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker as MapLibreMarker, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const MOSCOW: [number, number] = [37.6176, 55.7558];
const MOSCOW_BOUNDS: [[number, number], [number, number]] = [[36.8, 55.3], [38.6, 56.1]];
const OPEN_FREE_MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";
type MapLibreRuntime = typeof import("maplibre-gl");

declare global {
  interface Window {
    maplibregl?: MapLibreRuntime;
    radioChromiteMapLibre?: Promise<MapLibreRuntime>;
  }
}

function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (window.radioChromiteMapLibre) return window.radioChromiteMapLibre;
  window.radioChromiteMapLibre = new Promise<MapLibreRuntime>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/maplibre-gl.js";
    script.async = true;
    script.onload = () => window.maplibregl ? resolve(window.maplibregl) : reject(new Error("MapLibre global missing"));
    script.onerror = () => reject(new Error("MapLibre browser bundle unavailable"));
    document.head.appendChild(script);
  });
  return window.radioChromiteMapLibre;
}

type Coordinates = { lat: number; lon: number };
type Probe = Coordinates & { distance: number; bearing: number };
type MapState = Coordinates & { zoom: number; bearing: number };
type RadarFrame = { time: number; path: string };

const degreesToRadians = (value: number) => value * Math.PI / 180;
const radiansToDegrees = (value: number) => value * 180 / Math.PI;
const coordinateText = (value: number, positive: string, negative: string) => `${Math.abs(value).toFixed(5)} ${value >= 0 ? positive : negative}`;

function probeFrom(lat: number, lon: number): Probe {
  const earthRadiusKm = 6371.0088;
  const lat1 = degreesToRadians(MOSCOW[1]);
  const lat2 = degreesToRadians(lat);
  const deltaLat = degreesToRadians(lat - MOSCOW[1]);
  const deltaLon = degreesToRadians(lon - MOSCOW[0]);
  const haversine = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const distance = earthRadiusKm * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  const bearing = (radiansToDegrees(Math.atan2(y, x)) + 360) % 360;
  return { lat, lon, distance, bearing };
}

const radarLayers: StyleSpecification["layers"] = [
  { id: "rc-background", type: "background", paint: { "background-color": "#031019" } },
  { id: "rc-landcover", type: "fill", source: "openmaptiles", "source-layer": "landcover", paint: { "fill-color": "#071b25", "fill-opacity": 0.62 } },
  { id: "rc-landuse", type: "fill", source: "openmaptiles", "source-layer": "landuse", paint: { "fill-color": "#0b2631", "fill-opacity": 0.48 } },
  { id: "rc-water", type: "fill", source: "openmaptiles", "source-layer": "water", paint: { "fill-color": "#0c3d4d", "fill-opacity": 0.96, "fill-outline-color": "#3b6675" } },
  { id: "rc-waterway", type: "line", source: "openmaptiles", "source-layer": "waterway", paint: { "line-color": "#416b79", "line-opacity": 0.78, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.4, 14, 1.2] } },
  { id: "rc-boundary", type: "line", source: "openmaptiles", "source-layer": "boundary", paint: { "line-color": "#3a5a67", "line-opacity": 0.34, "line-dasharray": [2, 3], "line-width": 0.7 } },
  { id: "rc-roads-minor", type: "line", source: "openmaptiles", "source-layer": "transportation", filter: ["match", ["get", "class"], ["minor", "service", "path", "track"], true, false], paint: { "line-color": "#3d5965", "line-opacity": 0.32, "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.25, 14, 0.85] } },
  { id: "rc-roads-secondary", type: "line", source: "openmaptiles", "source-layer": "transportation", filter: ["match", ["get", "class"], ["secondary", "tertiary", "street"], true, false], paint: { "line-color": "#567481", "line-opacity": 0.58, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.4, 14, 1.3] } },
  { id: "rc-roads-major", type: "line", source: "openmaptiles", "source-layer": "transportation", filter: ["match", ["get", "class"], ["motorway", "trunk", "primary"], true, false], paint: { "line-color": "#7896a0", "line-opacity": 0.76, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.7, 14, 2.2] } },
];

export default function MoscowRadarMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const radarRef = useRef<HTMLDivElement>(null);
  const probeMarkerRef = useRef<MapLibreMarker | null>(null);
  const radarFramesRef = useRef<RadarFrame[]>([]);
  const selectedFrameRef = useRef(0);
  const [sourceOnline, setSourceOnline] = useState(false);
  const [cursor, setCursor] = useState<Coordinates>({ lat: MOSCOW[1], lon: MOSCOW[0] });
  const [probe, setProbe] = useState<Probe | null>(null);
  const [mapState, setMapState] = useState<MapState>({ lat: MOSCOW[1], lon: MOSCOW[0], zoom: 10.2, bearing: 0 });
  const [radarHost, setRadarHost] = useState("");
  const [radarFrames, setRadarFrames] = useState<RadarFrame[]>([]);
  const [selectedFrame, setSelectedFrame] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const abortController = new AbortController();
    let cancelled = false;
    let loaded = false;
    let map: MapLibreMap | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let visibilityObserver: IntersectionObserver | null = null;
    let sourceTimeout = 0;

    const initializeMap = async () => {
      try {
        const maplibre = await loadMapLibre();
        const [styleResponse, tileJsonResponse] = await Promise.all([
          fetch(OPEN_FREE_MAP_STYLE, { signal: abortController.signal }),
          fetch("https://tiles.openfreemap.org/planet", { signal: abortController.signal }),
        ]);
        if (!styleResponse.ok || !tileJsonResponse.ok) throw new Error("OpenFreeMap source unavailable");
        const style = await styleResponse.json() as StyleSpecification;
        const tileJson = await tileJsonResponse.json() as { tiles: string[]; minzoom?: number; maxzoom?: number; attribution?: string };
        if (!tileJson.tiles?.length) throw new Error("OpenFreeMap tile endpoint missing");
        style.sources.openmaptiles = {
          type: "vector",
          tiles: tileJson.tiles,
          minzoom: tileJson.minzoom,
          maxzoom: tileJson.maxzoom,
          attribution: tileJson.attribution,
        };
        style.layers = radarLayers;
        delete style.sprite;
        delete style.glyphs;
        if (cancelled) return;

        map = new maplibre.Map({
      container,
      style,
      center: MOSCOW,
      zoom: 10.2,
      bearing: 0,
      pitch: 0,
      minZoom: 8.5,
      maxZoom: 15.5,
      maxBounds: MOSCOW_BOUNDS,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      cooperativeGestures: false,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    const activeMap = map;
    mapRef.current = activeMap;
    activeMap.dragRotate.disable();
    activeMap.touchZoomRotate.disableRotation();
    activeMap.addControl(new maplibre.AttributionControl({ compact: true, customAttribution: "OpenFreeMap" }), "bottom-right");

    const updateMapState = () => {
      const center = activeMap.getCenter();
      setMapState({ lat: center.lat, lon: center.lng, zoom: activeMap.getZoom(), bearing: activeMap.getBearing() });
      const radarPoint = activeMap.project(MOSCOW);
      if (radarRef.current) radarRef.current.style.transform = `translate3d(${radarPoint.x}px,${radarPoint.y}px,0)`;
    };

    activeMap.once("style.load", () => {
      loaded = true;
      setSourceOnline(true);
      updateMapState();
      activeMap.resize();
      activeMap.triggerRepaint();
    });
    activeMap.on("move", updateMapState);
    activeMap.on("mousemove", (event) => setCursor({ lat: event.lngLat.lat, lon: event.lngLat.lng }));
    activeMap.on("click", (event) => {
      const nextProbe = probeFrom(event.lngLat.lat, event.lngLat.lng);
      setProbe(nextProbe);
      probeMarkerRef.current?.remove();
      const markerElement = document.createElement("div");
      markerElement.className = "map-probe-marker";
      markerElement.setAttribute("aria-label", "PROBE_01");
      probeMarkerRef.current = new maplibre.Marker({ element: markerElement, anchor: "center" })
        .setLngLat([nextProbe.lon, nextProbe.lat])
        .addTo(activeMap);
    });
    activeMap.on("error", () => { if (!loaded) setSourceOnline(false); });

    sourceTimeout = window.setTimeout(() => { if (!loaded) setSourceOnline(false); }, 10_000);
    resizeObserver = new ResizeObserver(() => activeMap.resize());
    resizeObserver.observe(container);
    visibilityObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        activeMap.resize();
        activeMap.triggerRepaint();
      }
    });
    visibilityObserver.observe(container);
    updateMapState();
      } catch (error) {
        console.error("Moscow map initialization failed", error);
        if (!cancelled && !(error instanceof DOMException && error.name === "AbortError")) setSourceOnline(false);
      }
    };

    void initializeMap();

    return () => {
      cancelled = true;
      abortController.abort();
      window.clearTimeout(sourceTimeout);
      resizeObserver?.disconnect();
      visibilityObserver?.disconnect();
      probeMarkerRef.current?.remove();
      probeMarkerRef.current = null;
      mapRef.current = null;
      map?.remove();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    const loadRadarMetadata = async () => {
      try {
        const response = await fetch("/api/rainviewer", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`Radar metadata ${response.status}`);
        const data = await response.json() as { host?: string; frames?: RadarFrame[] };
        const nextFrames = data.frames ?? [];
        if (!data.host || nextFrames.length === 0) {
          radarFramesRef.current = [];
          setRadarFrames([]);
          return;
        }

        const previousFrames = radarFramesRef.current;
        const previousIndex = selectedFrameRef.current;
        const wasNewest = previousFrames.length === 0 || previousIndex >= previousFrames.length - 1;
        const previousTime = previousFrames[previousIndex]?.time;
        let nextIndex = nextFrames.length - 1;
        if (!wasNewest && previousTime) {
          const retainedIndex = nextFrames.findIndex((frame) => frame.time === previousTime);
          nextIndex = retainedIndex >= 0 ? retainedIndex : Math.min(previousIndex, nextFrames.length - 1);
        }

        radarFramesRef.current = nextFrames;
        selectedFrameRef.current = nextIndex;
        setRadarHost(data.host);
        setRadarFrames(nextFrames);
        setSelectedFrame(nextIndex);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    };

    void loadRadarMetadata();
    const refreshTimer = window.setInterval(loadRadarMetadata, 5 * 60_000);
    return () => {
      controller.abort();
      window.clearInterval(refreshTimer);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !sourceOnline) return;
    const frame = radarFrames[selectedFrame];
    const layerId = "rainviewer-radar-layer";
    const sourceId = "rainviewer-radar";

    if (!frame || !radarHost) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      return;
    }

    const tileUrl = `/weather-radar-tile/{z}/{x}/{y}?host=${encodeURIComponent(radarHost)}&path=${encodeURIComponent(frame.path)}`;
    try {
      const existingSource = map.getSource(sourceId) as unknown as { setTiles?: (tiles: string[]) => void } | undefined;
      if (existingSource?.setTiles) {
        existingSource.setTiles([tileUrl]);
      } else {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
        map.addSource(sourceId, { type: "raster", tiles: [tileUrl], tileSize: 256, maxzoom: 7 });
        map.addLayer({
          id: layerId,
          type: "raster",
          source: sourceId,
          paint: { "raster-opacity": 0.46, "raster-fade-duration": 300, "raster-saturation": -0.28, "raster-contrast": 0.12 },
        });
      }
    } catch { /* Keep the Moscow basemap active when precipitation tiles fail. */ }
  }, [radarFrames, radarHost, selectedFrame, sourceOnline]);

  const relock = () => {
    probeMarkerRef.current?.remove();
    probeMarkerRef.current = null;
    setProbe(null);
    mapRef.current?.easeTo({ center: MOSCOW, zoom: 10.2, bearing: 0, pitch: 0, duration: 700 });
  };

  return (
    <div className={`moscow-map-module ${sourceOnline ? "map-source-online" : "map-source-offline"}`}>
      <div ref={containerRef} className="moscow-map-canvas" />

      <div ref={radarRef} className="map-radar" aria-hidden="true">
        <span className="radar-fixed-axis radar-fixed-axis-h" />
        <span className="radar-fixed-axis radar-fixed-axis-v" />
        <span className="radar-node" />
        <span className="radar-node-label">MOW_001</span>
      </div>

      <div className="map-state-readout">
        <span>MAP_ZOOM</span><b>{mapState.zoom.toFixed(2)}</b>
        <span>BEARING</span><b>{mapState.bearing.toFixed(1).padStart(5, "0")}</b>
        <span>CENTER</span><b>{mapState.lat.toFixed(3)} / {mapState.lon.toFixed(3)}</b>
        <span>SCAN</span><b>{sourceOnline ? "ACTIVE" : "OFFLINE"}</b>
      </div>

      <div className="map-cursor-readout">
        <strong>CURSOR</strong>
        <span>{coordinateText(cursor.lat, "N", "S")}</span>
        <span>{coordinateText(cursor.lon, "E", "W")}</span>
      </div>

      <div className={`map-probe-readout ${probe ? "is-locked" : ""}`}>
        <div><strong>PROBE_01</strong><b>{probe ? "LOCKED" : "STANDBY"}</b></div>
        <span>LAT <b>{probe ? coordinateText(probe.lat, "N", "S") : "--.----- N"}</b></span>
        <span>LON <b>{probe ? coordinateText(probe.lon, "E", "W") : "--.----- E"}</b></span>
        <span>DISTANCE <b>{probe ? `${probe.distance.toFixed(2).padStart(5, "0")} KM` : "--.-- KM"}</b></span>
        <span>AZIMUTH <b>{probe ? `${probe.bearing.toFixed(1).padStart(5, "0")} DEG` : "---.- DEG"}</b></span>
        <button type="button" onClick={relock}>[ RELOCK ]</button>
      </div>

      {!sourceOnline && (
        <div className="map-offline-fallback">
          <span>MAP_SOURCE // OFFLINE</span>
          <b>MOW_001 // 55.7558N 37.6176E</b>
        </div>
      )}
    </div>
  );
}
