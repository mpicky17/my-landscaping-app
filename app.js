// app.js — My Landscaping App
// Vanilla JS, no build step.

const APP_VERSION = 'my-landscaping-v14';

// Saved data lives under a FIXED key so version bumps don't wipe it.
// (Up to v13 the key was APP_VERSION itself — loadState migrates from those.)
const STATE_KEY = 'my-landscaping-state';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let state = {
  address: '',
  center: { lat: 41.8781, lng: -87.6298 },
  zoom: 18,
  photos: {},       // [id]: photo object
  polygons: {},     // [id]: GeoJSON feature object
  activeView: 'single',
  mainViewPhoto: null,
  multiViewPhotos: [null, null, null, null],
  alignAnchor: null,  // { photoId, lat, lng } | null
  settings: {
    googleMapsKey: '',
    claudeKey: '',
    usgsToken: '',
    firebaseEnabled: false,
    firebaseConfig: '',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save state:', e);
  }
}

// Find data saved by older versions under 'my-landscaping-v{N}' keys (newest N wins)
function findLegacyStateKey() {
  let best = null, bestN = -1;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    const m = /^my-landscaping-v(\d+)$/.exec(key || '');
    if (m && Number(m[1]) > bestN) { bestN = Number(m[1]); best = key; }
  }
  return best;
}

function loadState() {
  try {
    let raw = localStorage.getItem(STATE_KEY);
    if (!raw) {
      const legacyKey = findLegacyStateKey();
      if (legacyKey) {
        raw = localStorage.getItem(legacyKey);
        console.log(`Migrated saved data from ${legacyKey} to ${STATE_KEY}`);
      }
    }
    if (raw) {
      const saved = JSON.parse(raw);
      // Merge (preserve defaults for new keys)
      state = Object.assign({}, state, saved);
      state.settings = Object.assign({}, state.settings, saved.settings || {});
    }
  } catch (e) {
    console.warn('Failed to load state:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IndexedDB for uploaded images
// ─────────────────────────────────────────────────────────────────────────────

let idb = null;

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('landscaping-photos', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('images', { keyPath: 'id' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function saveImage(id, blob) {
  if (!idb) return;
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('images', 'readwrite');
    tx.objectStore('images').put({ id, blob });
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}

async function loadImage(id) {
  if (!idb) return null;
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('images', 'readonly');
    const req = tx.objectStore('images').get(id);
    req.onsuccess = e => resolve(e.target.result ? e.target.result.blob : null);
    req.onerror = reject;
  });
}

async function deleteImage(id) {
  if (!idb) return;
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('images', 'readwrite');
    tx.objectStore('images').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Leaflet map instances
// ─────────────────────────────────────────────────────────────────────────────

let mapMain = null;
let mapMulti = [null, null, null, null];
let mainTileLayer = null;
let multiTileLayers = [null, null, null, null];
let alignAnchorMarker = null;  // L.circleMarker — green dot on mapMain
let alignClickMode = false;    // true while waiting for user map click
let drawControl = null;
let polygonFeatureGroup = null;   // shared across all maps
let multiPolyGroups = [];         // references added to each multi map
let previewMap = null;
let previewPhotoId = null;
let previewUploadLayer = null;

const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_IMAGERY_ATTR = 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community';

function initMainMap() {
  mapMain = L.map('map-main', {
    center: [state.center.lat, state.center.lng],
    zoom: state.zoom,
    zoomControl: true,
    attributionControl: false,
  });

  mainTileLayer = L.tileLayer(ESRI_IMAGERY, {
    maxZoom: 22,
    maxNativeZoom: 19,
    attribution: ESRI_IMAGERY_ATTR,
  }).addTo(mapMain);

  // Shared polygon feature group
  polygonFeatureGroup = new L.FeatureGroup();
  polygonFeatureGroup.addTo(mapMain);

  // Drawing control
  drawControl = new L.Control.Draw({
    draw: {
      polygon: {
        allowIntersection: false,
        showArea: true,
        shapeOptions: {
          color: '#16a34a',
          fillColor: 'rgba(34,197,94,0.35)',
          fillOpacity: 1,
          weight: 2,
        },
      },
      polyline: false,
      rectangle: false,
      circle: false,
      circlemarker: false,
      marker: false,
    },
    edit: {
      featureGroup: polygonFeatureGroup,
      remove: true,
    },
  });
  // Don't add drawControl to map by default — we manage it via our toolbar buttons

  // Save center/zoom on move
  mapMain.on('moveend', () => {
    const c = mapMain.getCenter();
    state.center = { lat: c.lat, lng: c.lng };
    state.zoom = mapMain.getZoom();
    saveState();
  });

  mapMain.on('zoomend', () => { applyMainTileOffset(getCurrentMainPhoto()); });

  // Draw events
  mapMain.on(L.Draw.Event.CREATED, onPolygonCreated);
  mapMain.on(L.Draw.Event.EDITED, onPolygonsEdited);
  mapMain.on(L.Draw.Event.DELETED, onPolygonsDeleted);

  // Click on drawn polygons
  polygonFeatureGroup.on('click', e => {
    if (currentDrawMode !== 'none') return;
    const polyId = e.layer._polyId;
    if (polyId) showPolyPopup(e.layer, polyId);
  });
}

function initMultiMaps() {
  for (let i = 0; i < 4; i++) {
    if (mapMulti[i]) continue;

    mapMulti[i] = L.map(`map-multi-${i}`, {
      center: [state.center.lat, state.center.lng],
      zoom: state.zoom,
      zoomControl: i === 0,
      attributionControl: false,
    });

    // Default tile layer
    multiTileLayers[i] = L.tileLayer(ESRI_IMAGERY, {
      maxZoom: 22,
      maxNativeZoom: 19,
    }).addTo(mapMulti[i]);

    // Add shared polygon group to each multi map
    const cloneGroup = new L.FeatureGroup();
    multiPolyGroups.push(cloneGroup);
    cloneGroup.addTo(mapMulti[i]);

    // Sync all multi maps together
    if (i > 0) {
      mapMain.sync(mapMulti[i]);
      mapMulti[i].sync(mapMain);
      for (let j = 0; j < i; j++) {
        mapMulti[j].sync(mapMulti[i]);
        mapMulti[i].sync(mapMulti[j]);
      }
    }
  }

  // Restore pane selections
  state.multiViewPhotos.forEach((photoId, i) => {
    if (photoId) setMultiPanePhoto(i, photoId);
  });

  // Rebuild polygon layers on multi maps
  rebuildMultiPolyGroups();
}

function setMainTileLayer(tileUrl) {
  if (!mapMain) return;
  if (mainTileLayer) mapMain.removeLayer(mainTileLayer);
  mainTileLayer = L.tileLayer(tileUrl || ESRI_IMAGERY, {
    maxZoom: 22,
    maxNativeZoom: 19,
  }).addTo(mapMain);
  mainTileLayer.bringToBack();
  polygonFeatureGroup.bringToFront();
  applyMainTileOffset(getCurrentMainPhoto());
}

// ─────────────────────────────────────────────────────────────────────────────
// Alignment
// ─────────────────────────────────────────────────────────────────────────────

function getPixelOffset(map, dlat, dlng) {
  const center = map.getCenter();
  const zoom = map.getZoom();
  const centerPx  = map.project(center, zoom);
  const shiftedPx = map.project(L.latLng(center.lat + dlat, center.lng + dlng), zoom);
  return { dx: shiftedPx.x - centerPx.x, dy: shiftedPx.y - centerPx.y };
}

function applyMainTileOffset(photo) {
  if (!mainTileLayer) return;
  const container = mainTileLayer.getContainer();
  if (!container) return;
  if (!photo || !photo.offset) { container.style.transform = ''; return; }
  const { dx, dy } = getPixelOffset(mapMain, photo.offset.dlat, photo.offset.dlng);
  container.style.transform = `translate(${dx}px, ${dy}px)`;
}

function getCurrentMainPhoto() {
  return state.mainViewPhoto ? state.photos[state.mainViewPhoto] : null;
}

function placeAnchorMarker(lat, lng) {
  if (alignAnchorMarker) { alignAnchorMarker.setLatLng([lat, lng]); return; }
  alignAnchorMarker = L.circleMarker([lat, lng], {
    radius: 6, color: '#16a34a', fillColor: '#16a34a',
    fillOpacity: 0.85, weight: 2, interactive: false,
  }).addTo(mapMain);
}

function removeAnchorMarker() {
  if (alignAnchorMarker) { mapMain.removeLayer(alignAnchorMarker); alignAnchorMarker = null; }
}

function updateAlignResetBtn() {
  const visible = !!state.alignAnchor || Object.values(state.photos).some(p => p.offset);
  document.getElementById('align-reset-btn').classList.toggle('visible', visible);
}

function enterAlignClickMode() {
  alignClickMode = true;
  document.getElementById('align-btn').classList.add('align-active');
  document.getElementById('map-main').classList.add('align-picking');
  mapMain.once('click', onAlignMapClick);
}

function exitAlignClickMode() {
  alignClickMode = false;
  document.getElementById('align-btn').classList.remove('align-active');
  document.getElementById('map-main').classList.remove('align-picking');
  mapMain.off('click', onAlignMapClick);
}

function onAlignMapClick(e) {
  exitAlignClickMode();
  const { lat, lng } = e.latlng;
  const photo = getCurrentMainPhoto();

  if (!state.alignAnchor) {
    state.alignAnchor = { photoId: photo ? photo.id : null, lat, lng };
    saveState();
    placeAnchorMarker(lat, lng);
    updateAlignResetBtn();
    showToast('Reference point set. Switch to another photo and click Align to align it.');
  } else if (photo && photo.id === state.alignAnchor.photoId) {
    state.alignAnchor.lat = lat;
    state.alignAnchor.lng = lng;
    saveState();
    placeAnchorMarker(lat, lng);
    showToast('Reference point updated.');
  } else {
    const dlat = state.alignAnchor.lat - lat;
    const dlng = state.alignAnchor.lng - lng;
    if (photo) {
      photo.offset = { dlat, dlng };
      saveState();
      applyMainTileOffset(photo);
      updateAlignResetBtn();
      const mLat = 111320;
      const mLng = 111320 * Math.cos(lat * Math.PI / 180);
      const nVal = Math.round(dlat * mLat);
      const eVal = Math.round(dlng * mLng);
      const nStr = nVal >= 0 ? `${nVal}m N` : `${-nVal}m S`;
      const eStr = eVal >= 0 ? `${eVal}m E` : `${-eVal}m W`;
      showToast(`Aligned. Offset: ${nStr}, ${eStr}`);
    }
  }
}

function onAlignBtnClick() {
  if (alignClickMode) { exitAlignClickMode(); showToast('Alignment cancelled.'); return; }
  const photo = getCurrentMainPhoto();
  if (!state.alignAnchor)
    showToast('Click a landmark on this photo as the reference point');
  else if (photo && photo.id === state.alignAnchor.photoId)
    showToast('Click to update the reference point');
  else
    showToast('Click the same landmark on this photo to align it');
  enterAlignClickMode();
}

function resetAllAlignments() {
  state.alignAnchor = null;
  Object.values(state.photos).forEach(p => { delete p.offset; });
  saveState();
  removeAnchorMarker();
  if (mainTileLayer) {
    const c = mainTileLayer.getContainer();
    if (c) c.style.transform = '';
  }
  updateAlignResetBtn();
  showToast('All alignments cleared.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Uploaded photos: 4-corner image overlay (move / resize / rotate / skew)
// ─────────────────────────────────────────────────────────────────────────────
//
// An uploaded photo is drawn as an <img> whose four corners are pinned to four
// lat/lng points (NW, NE, SE, SW = image top-left, top-right, bottom-right,
// bottom-left). A CSS matrix3d (projective transform) maps the image rectangle
// onto those four screen points, so any placement is possible — including the
// trapezoid shape that a ground-level photo covers.

const UPLOAD_PANE = 'uploadPane';    // between tiles (200) and polygons (400)
const UPLOAD_DEFAULT_OPACITY = 0.8;

// 3×3 matrix helpers for the projective transform (row-major arrays of 9)
function m3adj(m) {
  return [
    m[4]*m[8]-m[5]*m[7], m[2]*m[7]-m[1]*m[8], m[1]*m[5]-m[2]*m[4],
    m[5]*m[6]-m[3]*m[8], m[0]*m[8]-m[2]*m[6], m[2]*m[3]-m[0]*m[5],
    m[3]*m[7]-m[4]*m[6], m[1]*m[6]-m[0]*m[7], m[0]*m[4]-m[1]*m[3],
  ];
}
function m3mul(a, b) {
  const c = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      c[3*i+j] = a[3*i]*b[j] + a[3*i+1]*b[3+j] + a[3*i+2]*b[6+j];
  return c;
}
function m3vec(m, v) {
  return [m[0]*v[0]+m[1]*v[1]+m[2]*v[2], m[3]*v[0]+m[4]*v[1]+m[5]*v[2], m[6]*v[0]+m[7]*v[1]+m[8]*v[2]];
}
// Matrix sending the unit basis to 4 points p[0..3] ({x,y})
function m3basis(p) {
  const m = [p[0].x, p[1].x, p[2].x, p[0].y, p[1].y, p[2].y, 1, 1, 1];
  const v = m3vec(m3adj(m), [p[3].x, p[3].y, 1]);
  return m3mul(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
}
// CSS matrix3d() mapping 4 source points onto 4 destination points
function projectiveMatrix3d(src, dst) {
  const t = m3mul(m3basis(dst), m3adj(m3basis(src)));
  const n = t.map(x => x / t[8]);
  return `matrix3d(${n[0]},${n[3]},0,${n[6]},${n[1]},${n[4]},0,${n[7]},0,0,1,0,${n[2]},${n[5]},0,${n[8]})`;
}

const CornerImageLayer = L.Layer.extend({
  options: { opacity: UPLOAD_DEFAULT_OPACITY, pane: UPLOAD_PANE },

  initialize(url, corners, width, height, options) {
    this._url = url;
    this._corners = corners.map(c => L.latLng(c));
    this._w = width;
    this._h = height;
    L.setOptions(this, options);
  },

  onAdd(map) {
    if (!map.getPane(UPLOAD_PANE)) {
      const pane = map.createPane(UPLOAD_PANE);
      pane.style.zIndex = 350;
      pane.style.pointerEvents = 'none';
    }
    if (!this._img) {
      const img = this._img = L.DomUtil.create('img', 'corner-image-layer');
      img.src = this._url;
      img.alt = '';
      img.draggable = false;
      Object.assign(img.style, {
        position: 'absolute', left: '0', top: '0',
        width: `${this._w}px`, height: `${this._h}px`,
        maxWidth: 'none', transformOrigin: '0 0', pointerEvents: 'none',
      });
      if (map.options.zoomAnimation && L.Browser.any3d) L.DomUtil.addClass(img, 'leaflet-zoom-animated');
    }
    this._img.style.opacity = this.options.opacity;
    this.getPane().appendChild(this._img);
    this._reset();
  },

  onRemove() { L.DomUtil.remove(this._img); },

  getEvents() {
    const events = { viewreset: this._reset, zoomend: this._reset, resize: this._reset };
    if (this._map._zoomAnimated) events.zoomanim = this._animateZoom;
    return events;
  },

  // Release the image's memory (object URL). Call when the layer is discarded.
  dispose() {
    if (this._map) this._map.removeLayer(this);
    if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
  },

  getCorners() { return this._corners.map(c => [c.lat, c.lng]); },
  setCorners(corners) { this._corners = corners.map(c => L.latLng(c)); this._reset(); return this; },
  getBounds() { return L.latLngBounds(this._corners); },
  setOpacity(o) { this.options.opacity = o; if (this._img) this._img.style.opacity = o; return this; },
  getImageSize() { return { w: this._w, h: this._h }; },

  _animateZoom(e) {
    this._apply(this._corners.map(c => this._map._latLngToNewLayerPoint(c, e.zoom, e.center)));
  },

  _reset() {
    if (!this._map || !this._img) return;
    this._apply(this._corners.map(c => this._map.latLngToLayerPoint(c)));
  },

  _apply(pts) {
    const w = this._w, h = this._h;
    const src = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    this._img.style.transform = projectiveMatrix3d(src, pts);
  },
});

// Starting corners: the photo at its own proportions, centered in `bounds`
// ([[s,w],[n,e]]). Falls back to a ~30 m box around the map center.
function defaultCorners(bounds, imgW, imgH) {
  const crs = L.CRS.EPSG3857, Z = 22; // high zoom = fine pixel precision
  let sw, ne;
  if (bounds && bounds[0][0] !== bounds[1][0] && bounds[0][1] !== bounds[1][1]) {
    sw = crs.latLngToPoint(L.latLng(bounds[0]), Z);
    ne = crs.latLngToPoint(L.latLng(bounds[1]), Z);
  } else {
    const c = crs.latLngToPoint(L.latLng(state.center.lat, state.center.lng), Z);
    const half = 15 / (crs.distance(crs.pointToLatLng(c, Z), crs.pointToLatLng(c.add([1, 0]), Z)) || 1);
    sw = c.add([-half, half]);
    ne = c.add([half, -half]);
  }
  const cx = (sw.x + ne.x) / 2, cy = (sw.y + ne.y) / 2;
  const boxW = Math.abs(ne.x - sw.x), boxH = Math.abs(sw.y - ne.y);
  const ratio = imgW / imgH;
  let w = boxW, h = boxW / ratio;
  if (h > boxH) { h = boxH; w = boxH * ratio; }
  const toLL = (x, y) => { const ll = crs.pointToLatLng(L.point(x, y), Z); return [ll.lat, ll.lng]; };
  return [
    toLL(cx - w/2, cy - h/2), toLL(cx + w/2, cy - h/2),
    toLL(cx + w/2, cy + h/2), toLL(cx - w/2, cy + h/2),
  ];
}

function getImageDims(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = url;
  });
}

// Build (but don't add) the overlay layer for an uploaded photo.
// Returns null if the image isn't stored on this device.
async function createUploadLayer(photo) {
  const blob = await loadImage(photo.id);
  if (!blob) {
    showToast('This photo’s image isn’t stored on this device');
    return null;
  }
  const url = URL.createObjectURL(blob);
  let dims;
  try { dims = await getImageDims(url); }
  catch (e) { URL.revokeObjectURL(url); showToast('Could not read this photo'); return null; }

  if (!photo.corners) {
    photo.corners = defaultCorners(photo.bounds, dims.w, dims.h);
    saveState();
  }
  return new CornerImageLayer(url, photo.corners, dims.w, dims.h, {
    opacity: photo.opacity ?? UPLOAD_DEFAULT_OPACITY,
  });
}

// ── Single view: show the selected photo (tiles or upload) ───────────────────

let mainUploadLayer = null;
let mainPhotoSeq = 0;   // guards against out-of-order async loads

function setMainPhoto(photoId) {
  if (photoAdjust) exitPhotoAdjust(true);
  if (mainUploadLayer) { mainUploadLayer.dispose(); mainUploadLayer = null; }
  const seq = ++mainPhotoSeq;

  const photo = photoId ? state.photos[photoId] : null;
  const isUpload = !!photo && photo.source === 'upload';
  setMainTileLayer(isUpload ? ESRI_IMAGERY : (photo && photo.tileUrl) || ESRI_IMAGERY);
  updatePhotoToolButtons(isUpload);
  if (!isUpload) return;

  createUploadLayer(photo).then(layer => {
    if (!layer) return;
    if (seq !== mainPhotoSeq) { layer.dispose(); return; }  // user picked another photo meanwhile
    mainUploadLayer = layer.addTo(mapMain);
    // Bring the photo into view if it's off-screen
    if (!mapMain.getBounds().intersects(layer.getBounds())) {
      mapMain.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 21 });
    }
  });
}

// Show "Adjust" only for uploads; Align applies to satellite photos only
function updatePhotoToolButtons(isUpload) {
  document.getElementById('photo-adjust-btn').style.display = isUpload ? '' : 'none';
  document.getElementById('align-btn').style.display = isUpload ? 'none' : '';
}

// ── Adjust mode: drag handles to move / resize+rotate / bend the photo ───────

let photoAdjust = null; // { photo, layer, mode: 'rigid'|'free', handles[], centerHandle, original, originalOpacity }

function makeHandleIcon(kind) {
  return L.divIcon({
    className: `photo-handle photo-handle-${kind}`,
    html: '<span></span>',
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

function cornerCentroid(corners) {
  const n = corners.length;
  return [corners.reduce((s, c) => s + c[0], 0) / n, corners.reduce((s, c) => s + c[1], 0) / n];
}

function syncAdjustHandles() {
  const corners = photoAdjust.layer.getCorners();
  photoAdjust.handles.forEach((h, i) => h.setLatLng(corners[i]));
  photoAdjust.centerHandle.setLatLng(cornerCentroid(corners));
}

function enterPhotoAdjust() {
  const photo = getCurrentMainPhoto();
  if (!photo || photo.source !== 'upload') return;
  if (!mainUploadLayer) { showToast('Photo is still loading — try again'); return; }
  setDrawMode('none');
  if (alignClickMode) exitAlignClickMode();

  const layer = mainUploadLayer;
  photoAdjust = {
    photo, layer, mode: 'rigid', handles: [], centerHandle: null,
    original: layer.getCorners(), originalOpacity: layer.options.opacity,
  };

  // Corner handles
  layer.getCorners().forEach((c, i) => {
    let start = null; // { pts: layer points of all corners, center } at drag start
    const h = L.marker(c, { icon: makeHandleIcon('corner'), draggable: true, keyboard: false, zIndexOffset: 1000 })
      .addTo(mapMain);
    h.on('dragstart', () => {
      const pts = layer.getCorners().map(cc => mapMain.project(cc));
      const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
      start = { pts, center: L.point(cx, cy) };
    });
    h.on('drag', e => {
      if (!start) return;
      const p = mapMain.project(e.target.getLatLng());
      let corners;
      if (photoAdjust.mode === 'free') {
        corners = layer.getCorners();
        const ll = e.target.getLatLng();
        corners[i] = [ll.lat, ll.lng];
      } else {
        // Rigid: scale + rotate all corners about the center, keeping proportions
        const v0 = start.pts[i].subtract(start.center), v1 = p.subtract(start.center);
        const len0 = Math.hypot(v0.x, v0.y);
        if (len0 < 1) return;
        const s = Math.max(0.05, Math.hypot(v1.x, v1.y) / len0);
        const a = Math.atan2(v1.y, v1.x) - Math.atan2(v0.y, v0.x);
        const cos = Math.cos(a) * s, sin = Math.sin(a) * s;
        corners = start.pts.map(q => {
          const dx = q.x - start.center.x, dy = q.y - start.center.y;
          const ll = mapMain.unproject(L.point(start.center.x + dx*cos - dy*sin, start.center.y + dx*sin + dy*cos));
          return [ll.lat, ll.lng];
        });
      }
      layer.setCorners(corners);
      // Move the other handles to match (not the one being dragged)
      const latest = layer.getCorners();
      photoAdjust.handles.forEach((hh, j) => { if (j !== i) hh.setLatLng(latest[j]); });
      photoAdjust.centerHandle.setLatLng(cornerCentroid(latest));
    });
    h.on('dragend', () => { start = null; syncAdjustHandles(); });
    photoAdjust.handles.push(h);
  });

  // Center handle: move the whole photo
  let moveStart = null;
  const ch = L.marker(cornerCentroid(layer.getCorners()), {
    icon: makeHandleIcon('center'), draggable: true, keyboard: false, zIndexOffset: 1001,
  }).addTo(mapMain);
  ch.on('dragstart', () => {
    moveStart = {
      pts: layer.getCorners().map(cc => mapMain.project(cc)),
      from: mapMain.project(ch.getLatLng()),
    };
  });
  ch.on('drag', e => {
    if (!moveStart) return;
    const d = mapMain.project(e.target.getLatLng()).subtract(moveStart.from);
    layer.setCorners(moveStart.pts.map(q => {
      const ll = mapMain.unproject(q.add(d));
      return [ll.lat, ll.lng];
    }));
    const latest = layer.getCorners();
    photoAdjust.handles.forEach((hh, j) => hh.setLatLng(latest[j]));
  });
  ch.on('dragend', () => { moveStart = null; syncAdjustHandles(); });
  photoAdjust.centerHandle = ch;

  // Toolbar state
  document.getElementById('photo-adjust-bar').classList.add('open');
  document.getElementById('photo-opacity-input').value = Math.round(layer.options.opacity * 100);
  setAdjustMode('rigid');
  document.getElementById('photo-adjust-btn').classList.add('active');
  document.querySelectorAll('#draw-toolbar .draw-btn').forEach(b => {
    if (b.id === 'photo-adjust-btn') return;
    b.dataset.adjustDisabled = b.disabled ? 'was' : 'yes';  // remember buttons that were already disabled
    b.disabled = true;
  });
}

function setAdjustMode(mode) {
  if (!photoAdjust) return;
  photoAdjust.mode = mode;
  document.getElementById('adjust-mode-rigid').classList.toggle('active', mode === 'rigid');
  document.getElementById('adjust-mode-free').classList.toggle('active', mode === 'free');
  showToast(mode === 'rigid'
    ? 'Drag a corner to resize/rotate • drag the center to move'
    : 'Drag each corner on its own to bend the photo');
}

function resetPhotoAdjust() {
  if (!photoAdjust) return;
  const { w, h } = photoAdjust.layer.getImageSize();
  photoAdjust.layer.setCorners(defaultCorners(photoAdjust.photo.bounds, w, h));
  syncAdjustHandles();
}

function exitPhotoAdjust(save) {
  if (!photoAdjust) return;
  const { photo, layer } = photoAdjust;
  photoAdjust.handles.forEach(h => mapMain.removeLayer(h));
  mapMain.removeLayer(photoAdjust.centerHandle);

  if (save) {
    photo.corners = layer.getCorners();
    photo.opacity = layer.options.opacity;
    saveState();
    syncFirebase();
    refreshMultiUploadLayers(photo.id);
  } else {
    layer.setCorners(photoAdjust.original);
    layer.setOpacity(photoAdjust.originalOpacity);
  }
  photoAdjust = null;

  document.getElementById('photo-adjust-bar').classList.remove('open');
  document.getElementById('photo-adjust-btn').classList.remove('active');
  document.querySelectorAll('#draw-toolbar .draw-btn').forEach(b => {
    if (b.dataset.adjustDisabled) { b.disabled = b.dataset.adjustDisabled === 'was'; delete b.dataset.adjustDisabled; }
  });
}

// ── Multi view ───────────────────────────────────────────────────────────────

let multiUploadLayers = [null, null, null, null];
let multiPaneSeq = [0, 0, 0, 0];

// After the photo is adjusted in Single view, update any Multi-view pane showing it
function refreshMultiUploadLayers(photoId) {
  const photo = state.photos[photoId];
  if (!photo) return;
  multiUploadLayers.forEach((layer, i) => {
    if (layer && state.multiViewPhotos[i] === photoId) {
      layer.setCorners(photo.corners).setOpacity(photo.opacity ?? UPLOAD_DEFAULT_OPACITY);
    }
  });
}

function setMultiPanePhoto(paneIdx, photoId) {
  const map = mapMulti[paneIdx];
  if (!map) return;
  state.multiViewPhotos[paneIdx] = photoId;
  saveState();

  if (multiTileLayers[paneIdx]) map.removeLayer(multiTileLayers[paneIdx]);
  if (multiUploadLayers[paneIdx]) { multiUploadLayers[paneIdx].dispose(); multiUploadLayers[paneIdx] = null; }
  const seq = ++multiPaneSeq[paneIdx];

  const photo = state.photos[photoId];
  const isUpload = !!photo && photo.source === 'upload';

  // Uploads sit on top of the current Esri imagery so the surroundings aren't blank
  multiTileLayers[paneIdx] = L.tileLayer(
    isUpload ? ESRI_IMAGERY : (photo && photo.tileUrl) || ESRI_IMAGERY,
    { maxZoom: 22, maxNativeZoom: 19 },
  ).addTo(map);

  if (isUpload) {
    createUploadLayer(photo).then(layer => {
      if (!layer) return;
      if (seq !== multiPaneSeq[paneIdx]) { layer.dispose(); return; }
      multiUploadLayers[paneIdx] = layer.addTo(map);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-map polygon sync
// ─────────────────────────────────────────────────────────────────────────────

function rebuildMultiPolyGroups() {
  multiPolyGroups.forEach(group => group.clearLayers());

  polygonFeatureGroup.eachLayer(layer => {
    multiPolyGroups.forEach(group => {
      const clone = cloneLayer(layer);
      group.addLayer(clone);
    });
  });
}

function cloneLayer(layer) {
  const geojson = layer.toGeoJSON();
  const clone = L.geoJSON(geojson, {
    style: layer.options,
  }).getLayers()[0];
  clone._polyId = layer._polyId;
  return clone;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drawing system
// ─────────────────────────────────────────────────────────────────────────────

let currentDrawMode = 'none'; // 'none' | 'draw' | 'edit' | 'delete'
let pendingLayer = null;
let editHandler = null;
let deleteHandler = null;

function setDrawMode(mode) {
  if (alignClickMode) exitAlignClickMode();
  // Cancel any active handler
  if (editHandler) { try { editHandler.disable(); } catch(e){} editHandler = null; }
  if (deleteHandler) { try { deleteHandler.disable(); } catch(e){} deleteHandler = null; }
  if (currentDrawMode === 'draw' && window._activeDrawHandler) {
    try { window._activeDrawHandler.disable(); } catch(e) {}
    window._activeDrawHandler = null;
  }

  currentDrawMode = mode;
  updateDrawBtnStates();

  if (mode === 'draw') {
    const handler = new L.Draw.Polygon(mapMain, {
      allowIntersection: false,
      shapeOptions: {
        color: '#16a34a',
        fillColor: 'rgba(34,197,94,0.35)',
        fillOpacity: 1,
        weight: 2,
      },
    });
    handler.enable();
    window._activeDrawHandler = handler;
  } else if (mode === 'edit') {
    editHandler = new L.EditToolbar.Edit(mapMain, {
      featureGroup: polygonFeatureGroup,
    });
    editHandler.enable();
  } else if (mode === 'delete') {
    deleteHandler = new L.EditToolbar.Delete(mapMain, {
      featureGroup: polygonFeatureGroup,
    });
    deleteHandler.enable();
  }
}

function updateDrawBtnStates() {
  document.getElementById('draw-polygon-btn').classList.toggle('active', currentDrawMode === 'draw');
  document.getElementById('draw-edit-btn').classList.toggle('active', currentDrawMode === 'edit');
  document.getElementById('draw-delete-btn').classList.toggle('active', currentDrawMode === 'delete');
}

function onPolygonCreated(e) {
  window._activeDrawHandler = null;
  currentDrawMode = 'none';
  updateDrawBtnStates();
  pendingLayer = e.layer;
  showLabelModal();
}

function onPolygonsEdited(e) {
  e.layers.eachLayer(layer => {
    const id = layer._polyId;
    if (id && state.polygons[id]) {
      state.polygons[id].geometry = layer.toGeoJSON().geometry;
      state.polygons[id].properties.areaSqFt = calcAreaSqFt(layer);
    }
  });
  saveState();
  renderPolygonList();
  rebuildMultiPolyGroups();
  syncFirebase();

  editHandler = null;
  currentDrawMode = 'none';
  updateDrawBtnStates();
}

function onPolygonsDeleted(e) {
  e.layers.eachLayer(layer => {
    const id = layer._polyId;
    if (id) delete state.polygons[id];
  });
  saveState();
  renderPolygonList();
  rebuildMultiPolyGroups();
  syncFirebase();

  deleteHandler = null;
  currentDrawMode = 'none';
  updateDrawBtnStates();
}

function addPolygonWithLabel(label, color) {
  if (!pendingLayer) return;

  const id = 'poly_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const areaSqFt = calcAreaSqFt(pendingLayer);

  // Style the layer
  const borderColor = color.replace(/[\d.]+\)$/, '1)');
  pendingLayer.setStyle({
    color: borderColor,
    fillColor: color,
    fillOpacity: 1,
    weight: 2,
  });

  // Permanent tooltip
  pendingLayer.bindTooltip(label, {
    permanent: true,
    direction: 'center',
    className: 'poly-label-tooltip',
  });

  pendingLayer._polyId = id;
  polygonFeatureGroup.addLayer(pendingLayer);

  // Save to state
  const feature = pendingLayer.toGeoJSON();
  feature.properties = {
    label,
    color,
    notes: '',
    areaSqFt,
    source: 'manual',
    createdAt: Date.now(),
  };
  state.polygons[id] = feature;
  state.polygons[id].id = id;

  pendingLayer = null;
  saveState();
  renderPolygonList();
  rebuildMultiPolyGroups();
  syncFirebase();
  showToast(`Added: ${label}`);
}

function calcAreaSqFt(layer) {
  try {
    // Use Leaflet's geodesic area calculation
    const latlngs = layer.getLatLngs()[0];
    const areaM2 = L.GeometryUtil.geodesicArea(latlngs);
    return Math.round(areaM2 * 10.7639); // m² to ft²
  } catch (e) {
    return 0;
  }
}

function restorePolygons() {
  polygonFeatureGroup.clearLayers();
  Object.values(state.polygons).forEach(feature => {
    const layer = L.geoJSON(feature).getLayers()[0];
    if (!layer) return;

    const { label, color } = feature.properties;
    const borderColor = (color || '#16a34a').replace(/[\d.]+\)$/, '1)');
    layer.setStyle({
      color: borderColor,
      fillColor: color || 'rgba(34,197,94,0.35)',
      fillOpacity: 1,
      weight: 2,
    });
    layer.bindTooltip(label || 'Unlabeled', {
      permanent: true,
      direction: 'center',
      className: 'poly-label-tooltip',
    });
    layer._polyId = feature.id;
    polygonFeatureGroup.addLayer(layer);
  });

  renderPolygonList();
}

// ─────────────────────────────────────────────────────────────────────────────
// Polygon popup
// ─────────────────────────────────────────────────────────────────────────────

function showPolyPopup(layer, polyId) {
  const feature = state.polygons[polyId];
  if (!feature) return;
  const { label, areaSqFt, notes } = feature.properties;

  const container = document.createElement('div');
  container.className = 'poly-popup';
  container.innerHTML = `
    <h4>${escHtml(label)}</h4>
    <p class="poly-popup-meta">${areaSqFt ? areaSqFt.toLocaleString() + ' sq ft' : ''}</p>
    <textarea placeholder="Notes…" id="poly-notes-ta">${escHtml(notes || '')}</textarea>
    <div class="poly-popup-actions">
      <button id="poly-save-btn" style="background:var(--green);color:#fff">Save</button>
      <button id="poly-delete-btn" style="background:#fef2f2;color:#ef4444">Delete</button>
    </div>
  `;

  layer.bindPopup(container).openPopup();

  setTimeout(() => {
    const saveBtn = document.getElementById('poly-save-btn');
    const deleteBtn = document.getElementById('poly-delete-btn');
    const ta = document.getElementById('poly-notes-ta');

    if (saveBtn) saveBtn.onclick = () => {
      feature.properties.notes = ta.value;
      saveState();
      syncFirebase();
      layer.closePopup();
      showToast('Notes saved');
    };

    if (deleteBtn) deleteBtn.onclick = () => {
      delete state.polygons[polyId];
      polygonFeatureGroup.removeLayer(layer);
      saveState();
      renderPolygonList();
      rebuildMultiPolyGroups();
      syncFirebase();
      layer.closePopup();
      showToast('Polygon deleted');
    };
  }, 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Polygon list sidebar
// ─────────────────────────────────────────────────────────────────────────────

function renderPolygonList() {
  const list = document.getElementById('polygon-list');
  const polys = Object.values(state.polygons);

  if (polys.length === 0) {
    list.innerHTML = '<p class="polygon-list-empty">No polygons yet.<br>Use Draw to add one.</p>';
    return;
  }

  list.innerHTML = polys.sort((a, b) => (a.properties.createdAt || 0) - (b.properties.createdAt || 0)).map(f => {
    const { label, color, areaSqFt } = f.properties;
    const swatchColor = color || 'rgba(34,197,94,0.35)';
    return `
      <div class="polygon-item" data-id="${f.id}">
        <span class="polygon-swatch" style="background:${swatchColor}"></span>
        <span class="polygon-item-label">${escHtml(label)}</span>
        ${areaSqFt ? `<span class="polygon-item-area">${areaSqFt.toLocaleString()} ft²</span>` : ''}
      </div>
    `;
  }).join('');

  // Click to pan to polygon
  list.querySelectorAll('.polygon-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      polygonFeatureGroup.eachLayer(layer => {
        if (layer._polyId === id) {
          mapMain.fitBounds(layer.getBounds(), { padding: [40, 40] });
          showPolyPopup(layer, id);
        }
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Address geocoding (Step 4)
// ─────────────────────────────────────────────────────────────────────────────

async function geocodeAddress(address) {
  const btn = document.getElementById('search-btn');
  btn.disabled = true;
  btn.textContent = '…';

  try {
    let lat, lng;

    const googleKey = state.settings.googleMapsKey;
    if (googleKey) {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${encodeURIComponent(googleKey)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.results && data.results[0]) {
        const loc = data.results[0].geometry.location;
        lat = loc.lat;
        lng = loc.lng;
      }
    } else {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      const data = await res.json();
      if (data[0]) {
        lat = parseFloat(data[0].lat);
        lng = parseFloat(data[0].lon);
      }
    }

    if (lat !== undefined && lng !== undefined) {
      state.address = address;
      state.center = { lat, lng };
      state.zoom = 19;
      saveState();

      mapMain.setView([lat, lng], 19);
      document.getElementById('welcome-overlay').classList.add('hidden');
      showToast('Location found');
      return true;
    } else {
      showToast('Address not found — try a more specific address');
      return false;
    }
  } catch (e) {
    showToast('Geocoding failed — check connection');
    console.error(e);
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Imagery discovery (Step 5)
// ─────────────────────────────────────────────────────────────────────────────

async function discoverImagery() {
  if (!state.address) {
    showToast('Search for an address first');
    return;
  }

  const btn = document.getElementById('discover-btn');
  btn.disabled = true;
  btn.textContent = '…';
  document.getElementById('photo-loading').style.display = 'block';

  try {
    await discoverEsriWayback();
    await discoverNAIP();
  } catch (e) {
    console.error('Discovery error:', e);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 Discover';
    document.getElementById('photo-loading').style.display = 'none';
    renderPhotoLibrary();
    if (Object.keys(state.photos).length > 0) {
      document.getElementById('photo-review-done').style.display = 'block';
      document.getElementById('google-prompt').style.display = state.settings.googleMapsKey ? 'none' : 'flex';
    }
    saveState();
  }
}

async function discoverEsriWayback() {
  // Fetch the official Wayback release catalog (public S3 JSON, no auth required)
  try {
    const res = await fetch(
      'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json'
    );
    if (!res.ok) throw new Error(`Wayback config fetch failed: ${res.status}`);
    const catalog = await res.json();

    // catalog keys are numeric release IDs; each entry has releaseDatetime
    const releases = Object.entries(catalog)
      .map(([id, meta]) => ({
        releaseId: Number(id),
        storageUrl: meta.storageUrl || null,
        date: meta.releaseDatetime || '',
        label: meta.releaseDatetime
          ? `Esri Wayback ${meta.releaseDatetime.slice(0, 10)}`
          : `Esri Wayback #${id}`,
        year: meta.releaseDatetime ? meta.releaseDatetime.slice(0, 4) : id,
      }))
      .sort((a, b) => b.releaseId - a.releaseId) // newest first
      .slice(0, 12);

    releases.forEach(v => {
      const id = `wb_${v.releaseId}`;
      if (!state.photos[id]) {
        // Use storageUrl from config (correct path order) if present, converting
        // Esri's {level}/{row}/{col} template to Leaflet's {z}/{y}/{x}
        const storageUrl = v.storageUrl
          ? v.storageUrl.replace('{level}', '{z}').replace('{row}', '{y}').replace('{col}', '{x}')
          : `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${v.releaseId}/{z}/{y}/{x}`;
        state.photos[id] = {
          id,
          source: 'esri-wayback',
          label: v.label,
          year: v.year,
          releaseId: v.releaseId,
          status: 'unreviewed',
          tileUrl: storageUrl,
          maxNativeZoom: 19,
        };
      }
    });
  } catch (e) {
    console.warn('Esri Wayback discovery failed:', e);
    addEsriCurrentPhoto();
  }
}

function addEsriCurrentPhoto() {
  const id = 'esri_current';
  if (!state.photos[id]) {
    state.photos[id] = {
      id,
      source: 'esri',
      label: 'Esri World Imagery (Current)',
      year: 'Current',
      status: 'unreviewed',
      tileUrl: ESRI_IMAGERY,
    };
  }
}

async function discoverNAIP() {
  // Clean up stale broken NAIP entries from previous versions
  delete state.photos['naip_current'];

  const token = state.settings.usgsToken;
  if (token) {
    // USDA APFO NAIP imagery — requires a free USGS EarthExplorer token
    // Get one at: https://ers.cr.usgs.gov/register
    const baseUrl = 'https://gis.apfo.usda.gov/arcgis/rest/services/NAIP/USDA_CONUS_PRIME/ImageServer/tile/{z}/{y}/{x}';
    state.photos['naip_usgs'] = {
      id: 'naip_usgs',
      source: 'naip',
      label: 'NAIP (USDA Latest)',
      year: 'Latest',
      status: state.photos['naip_usgs']?.status || 'unreviewed',
      tileUrl: `${baseUrl}?token=${encodeURIComponent(token)}`,
      maxNativeZoom: 17,
    };
  } else {
    delete state.photos['naip_usgs'];
    showToast('Add a USGS token in \u2699\ufe0f Settings to enable NAIP imagery');
  }

  addEsriCurrentPhoto();
}

// ─────────────────────────────────────────────────────────────────────────────
// Photo library UI (Step 5 continued)
// ─────────────────────────────────────────────────────────────────────────────

function renderPhotoLibrary() {
  const grid = document.getElementById('photo-grid');
  const photos = Object.values(state.photos);

  if (photos.length === 0) {
    grid.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem">No imagery found yet. Click Discover or upload a photo.</p>';
    return;
  }

  grid.innerHTML = photos.map(photo => {
    const isKept    = photo.status === 'keep';
    const isIgnored = photo.status === 'ignore';
    return `
      <div class="photo-card ${isKept ? 'kept' : isIgnored ? 'ignored' : ''}" data-id="${photo.id}">
        <div class="photo-thumb" id="thumb-${photo.id}">
          <span>Loading preview…</span>
        </div>
        <div class="photo-card-body">
          <div class="photo-meta">
            <span class="photo-source-badge">${escHtml(photo.source)}</span>
            <span class="photo-year">${escHtml(String(photo.year || ''))}</span>
          </div>
          <input
            type="text"
            class="photo-label-input"
            placeholder="Label (e.g. 'Summer 2022')"
            value="${escHtml(photo.label || '')}"
            data-id="${photo.id}"
          />
          <div class="photo-actions">
            <button class="photo-keep-btn ${isKept ? 'active' : ''}" data-id="${photo.id}">&#10003; Keep</button>
            <button class="photo-ignore-btn ${isIgnored ? 'active' : ''}" data-id="${photo.id}">&#10007; Ignore</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Attach tile preview maps
  photos.forEach(photo => {
    if (photo.source !== 'upload') {
      renderPhotoThumbMap(photo);
    } else {
      loadImage(photo.id).then(blob => {
        if (!blob) return;
        const thumb = document.getElementById(`thumb-${photo.id}`);
        if (!thumb) return;
        const url = URL.createObjectURL(blob);
        thumb.innerHTML = `<img src="${url}" alt="${escHtml(photo.label)}" />`;
      });
    }
  });

  // Thumbnail click → full-size preview
  grid.querySelectorAll('.photo-thumb').forEach(el => {
    el.style.cursor = 'zoom-in';
    el.addEventListener('click', () => showPhotoPreview(el.closest('.photo-card').dataset.id));
  });

  // Event listeners
  grid.querySelectorAll('.photo-label-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const id = e.target.dataset.id;
      if (state.photos[id]) {
        state.photos[id].label = e.target.value;
        saveState();
        updateMultiPaneSelects();
      }
    });
  });

  grid.querySelectorAll('.photo-keep-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = e.target.dataset.id;
      if (state.photos[id]) {
        state.photos[id].status = 'keep';
        saveState();
        renderPhotoLibrary();
        updateMultiPaneSelects();
      }
    });
  });

  grid.querySelectorAll('.photo-ignore-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = e.target.dataset.id;
      if (state.photos[id]) {
        state.photos[id].status = 'ignore';
        saveState();
        renderPhotoLibrary();
        updateMultiPaneSelects();
      }
    });
  });
}

function renderPhotoThumbMap(photo) {
  const thumbEl = document.getElementById(`thumb-${photo.id}`);
  if (!thumbEl) return;

  const miniMap = document.createElement('div');
  miniMap.className = 'photo-thumb-map';
  thumbEl.innerHTML = '';
  thumbEl.appendChild(miniMap);

  const m = L.map(miniMap, {
    center: [state.center.lat, state.center.lng],
    zoom: Math.min(17, photo.maxNativeZoom || 17),
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    tap: false,
  });

  if (photo.tileUrl) {
    console.log(`[thumb] ${photo.id} tileUrl=${photo.tileUrl} zoom=${Math.min(17, photo.maxNativeZoom || 17)} maxNativeZoom=${photo.maxNativeZoom || 19}`);
    const tl = L.tileLayer(photo.tileUrl, { maxZoom: 22, maxNativeZoom: photo.maxNativeZoom || 19 });
    tl.on('tileerror', e => {
      const url = tl.getTileUrl(e.coords);
      console.error(`[thumb] TILE FAILED — open this URL in a new tab to see the error:\n${url}`);
    });
    tl.on('tileload', () => console.log(`[thumb] tile loaded OK for ${photo.id}`));
    tl.addTo(m);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-view pane selects
// ─────────────────────────────────────────────────────────────────────────────

function updateMultiPaneSelects() {
  const kept = Object.values(state.photos).filter(p => p.status === 'keep');

  for (let i = 0; i < 4; i++) {
    const sel = document.getElementById(`pane-select-${i}`);
    if (!sel) continue;

    const current = sel.value;
    sel.innerHTML = '<option value="">Select photo…</option>' +
      kept.map(p => `<option value="${p.id}" ${p.id === current ? 'selected' : ''}>${escHtml(p.label || p.year)}</option>`).join('');
  }

  const mainSel = document.getElementById('main-photo-select');
  if (mainSel) {
    const cur = mainSel.value;
    mainSel.innerHTML = '<option value="">Select photo…</option>' +
      kept.map(p => `<option value="${p.id}" ${p.id === cur ? 'selected' : ''}>${escHtml(p.label || p.year)}</option>`).join('');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Photo upload
// ─────────────────────────────────────────────────────────────────────────────

// Starting placement box for a new upload: centered on the property, about half
// the width of the main map view. Computed from the saved center/zoom because
// the main map is hidden while the Photo Library tab is open.
function uploadStartBounds() {
  const crs = L.CRS.EPSG3857;
  const z = state.zoom || 19;
  const size = mapMain && mapMain.getSize().x > 0 ? mapMain.getSize() : L.point(400, 400);
  const c = crs.latLngToPoint(L.latLng(state.center.lat, state.center.lng), z);
  const half = Math.min(size.x, size.y) / 4;
  const sw = crs.pointToLatLng(c.add([-half, half]), z);
  const ne = crs.pointToLatLng(c.add([half, -half]), z);
  return [[sw.lat, sw.lng], [ne.lat, ne.lng]];
}

// Shrink big phone photos (e.g. 4032×3024) so they don't exhaust memory on the
// iPhone when shown in several maps at once. Returns the original if it's small.
const UPLOAD_MAX_PX = 2048;
async function downscaleImage(file) {
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    URL.revokeObjectURL(url);
    const scale = Math.min(1, UPLOAD_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.88));
    return blob || file;
  } catch (e) {
    console.warn('Could not downscale upload, storing original:', e);
    return file;
  }
}

async function handleUploadFiles(files) {
  for (const file of files) {
    const id = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const boundsArr = uploadStartBounds();

    state.photos[id] = {
      id,
      source: 'upload',
      label: file.name.replace(/\.[^.]+$/, ''),
      year: new Date().getFullYear().toString(),
      status: 'unreviewed',
      tileUrl: null,
      bounds: boundsArr,
      uploadKey: id,
    };

    await saveImage(id, await downscaleImage(file));
    showToast(`Uploaded: ${file.name}`);
  }

  saveState();
  renderPhotoLibrary();
  document.getElementById('photo-review-done').style.display = 'block';
}

// ─────────────────────────────────────────────────────────────────────────────
// Firebase cloud sync (Step 9)
// ─────────────────────────────────────────────────────────────────────────────

let firebaseApp = null;
let firebaseDB = null;
let firebaseAuth = null;
let currentUser = null;
let syncDebounceTimer = null;

function initFirebase(config) {
  try {
    if (firebaseApp) firebaseApp.delete();
    firebaseApp = firebase.initializeApp(config, 'landscaping-' + Date.now());
    firebaseAuth = firebase.auth(firebaseApp);
    firebaseDB = firebase.database(firebaseApp);

    firebaseAuth.onAuthStateChanged(user => {
      currentUser = user;
      updateSyncStatus();
      if (user) {
        setSyncDot('syncing');
        listenFirebase();
      }
    });

    return true;
  } catch (e) {
    console.error('Firebase init error:', e);
    showToast('Firebase config invalid');
    return false;
  }
}

function signInWithGoogle() {
  if (!firebaseAuth) return;
  const provider = new firebase.auth.GoogleAuthProvider();
  firebaseAuth.signInWithPopup(provider)
    .then(() => showToast('Signed in'))
    .catch(e => showToast('Sign-in failed: ' + e.message));
}

function signOut() {
  if (!firebaseAuth) return;
  firebaseAuth.signOut().then(() => {
    currentUser = null;
    setSyncDot('');
    showToast('Signed out');
  });
}

function syncFirebase() {
  if (!currentUser || !firebaseDB) return;
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => {
    setSyncDot('syncing');
    // Don't sync photos (binary); sync everything else
    const payload = {
      address: state.address,
      center: state.center,
      zoom: state.zoom,
      polygons: state.polygons,
      photos: Object.fromEntries(
        Object.entries(state.photos).map(([k, v]) => [k, { ...v, uploadKey: undefined }])
      ),
      multiViewPhotos: state.multiViewPhotos,
    };
    firebaseDB.ref(`users/${currentUser.uid}/landscaping`)
      .set(payload)
      .then(() => setSyncDot('ok'))
      .catch(e => { setSyncDot('error'); console.error('Sync error:', e); });
  }, 1000);
}

function listenFirebase() {
  if (!currentUser || !firebaseDB) return;
  firebaseDB.ref(`users/${currentUser.uid}/landscaping`)
    .on('value', snap => {
      const data = snap.val();
      if (!data) { setSyncDot('ok'); return; }
      // Merge: keep local binary upload refs, use remote data for everything else
      const localUploadPhotos = Object.fromEntries(
        Object.entries(state.photos).filter(([, v]) => v.source === 'upload')
      );
      state.address = data.address || state.address;
      state.center = data.center || state.center;
      state.zoom = data.zoom || state.zoom;
      state.polygons = data.polygons || {};
      state.photos = { ...(data.photos || {}), ...localUploadPhotos };
      state.multiViewPhotos = data.multiViewPhotos || state.multiViewPhotos;

      saveState();
      restorePolygons();
      renderPhotoLibrary();
      updateMultiPaneSelects();
      if (mapMain) mapMain.setView([state.center.lat, state.center.lng], state.zoom);
      setSyncDot('ok');
    });
}

function setSyncDot(status) {
  const dot = document.getElementById('sync-dot');
  dot.className = 'sync-dot' + (status ? ' ' + status : '');
}

function updateSyncStatus() {
  const status = document.getElementById('firebase-status');
  if (!status) return;
  if (currentUser) {
    status.textContent = `Signed in as ${currentUser.email || currentUser.displayName || currentUser.uid}`;
    document.getElementById('firebase-signout-btn').style.display = 'inline-block';
    document.getElementById('firebase-save-btn').textContent = 'Reconnect';
  } else {
    status.textContent = '';
    document.getElementById('firebase-signout-btn').style.display = 'none';
    document.getElementById('firebase-save-btn').textContent = 'Save & Connect';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

function openSettings() {
  document.getElementById('settings-modal').classList.add('open');
  document.getElementById('google-maps-key-input').value = state.settings.googleMapsKey || '';
  document.getElementById('claude-key-input').value = state.settings.claudeKey || '';
  document.getElementById('usgs-token-input').value = state.settings.usgsToken || '';
  document.getElementById('firebase-toggle').checked = state.settings.firebaseEnabled || false;
  document.getElementById('firebase-config-input').value = state.settings.firebaseConfig || '';
  document.getElementById('firebase-config-section').style.display = state.settings.firebaseEnabled ? 'block' : 'none';
  updateSyncStatus();
}

function closeSettings() {
  saveSettings();
  document.getElementById('settings-modal').classList.remove('open');
}

function saveSettings() {
  state.settings.googleMapsKey = document.getElementById('google-maps-key-input').value.trim();
  state.settings.claudeKey = document.getElementById('claude-key-input').value.trim();
  state.settings.usgsToken = document.getElementById('usgs-token-input').value.trim();
  state.settings.firebaseEnabled = document.getElementById('firebase-toggle').checked;
  state.settings.firebaseConfig = document.getElementById('firebase-config-input').value.trim();
  saveState();
}

// ─────────────────────────────────────────────────────────────────────────────
// Label modal
// ─────────────────────────────────────────────────────────────────────────────

function showPhotoPreview(photoId) {
  const photo = state.photos[photoId];
  if (!photo) return;
  previewPhotoId = photoId;

  document.getElementById('preview-title').textContent = photo.label || photo.source;
  document.getElementById('preview-subtitle').textContent =
    [photo.source, photo.year].filter(Boolean).join(' · ');
  document.getElementById('preview-keep-btn').classList.toggle('active', photo.status === 'keep');
  document.getElementById('preview-ignore-btn').classList.toggle('active', photo.status === 'ignore');

  document.getElementById('photo-preview-modal').classList.add('open');

  if (previewUploadLayer) { previewUploadLayer.dispose(); previewUploadLayer = null; }
  if (previewMap) { previewMap.remove(); previewMap = null; }

  requestAnimationFrame(() => {
    const nativeZoom = photo.maxNativeZoom || 19;
    previewMap = L.map('preview-map', {
      center: [state.center.lat, state.center.lng],
      zoom: Math.min(18, nativeZoom),
      zoomControl: true,
      attributionControl: false,
    });

    if (photo.source === 'upload') {
      L.tileLayer(ESRI_IMAGERY, { maxZoom: 22, maxNativeZoom: 19 }).addTo(previewMap);
      const forMap = previewMap;
      createUploadLayer(photo).then(layer => {
        if (!layer) return;
        if (previewMap !== forMap) { layer.dispose(); return; }  // preview closed meanwhile
        previewUploadLayer = layer.addTo(previewMap);
        previewMap.fitBounds(layer.getBounds(), { padding: [20, 20], maxZoom: 21 });
      });
    } else if (photo.tileUrl) {
      L.tileLayer(photo.tileUrl, { maxZoom: 22, maxNativeZoom: nativeZoom }).addTo(previewMap);
    }
  });
}

function closePhotoPreview() {
  document.getElementById('photo-preview-modal').classList.remove('open');
  previewPhotoId = null;
  if (previewUploadLayer) { previewUploadLayer.dispose(); previewUploadLayer = null; }
  if (previewMap) { previewMap.remove(); previewMap = null; }
}

function showLabelModal() {
  document.getElementById('label-modal').classList.add('open');
  document.getElementById('label-custom-input').value = '';
}

function closeLabelModal() {
  document.getElementById('label-modal').classList.remove('open');
  if (pendingLayer) {
    pendingLayer = null; // cancelled
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// View tabs
// ─────────────────────────────────────────────────────────────────────────────

function switchView(view) {
  state.activeView = view;
  saveState();

  document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${view}`));

  if (view === 'multi') {
    initMultiMaps();
    // Invalidate map sizes after layout
    setTimeout(() => mapMulti.forEach(m => m && m.invalidateSize()), 100);
  } else if (view === 'single') {
    setTimeout(() => mapMain && mapMain.invalidateSize(), 100);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function latLngToTile(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event wiring
// ─────────────────────────────────────────────────────────────────────────────

function wireEvents() {
  // Address search
  const addrInput = document.getElementById('address-input');
  const searchBtn = document.getElementById('search-btn');

  addrInput.value = state.address || '';

  addrInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') searchBtn.click();
  });

  searchBtn.addEventListener('click', async () => {
    const addr = addrInput.value.trim();
    if (!addr) return;
    await geocodeAddress(addr);
  });

  // View tabs
  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Drawing toolbar
  document.getElementById('draw-polygon-btn').addEventListener('click', () => {
    setDrawMode(currentDrawMode === 'draw' ? 'none' : 'draw');
  });

  document.getElementById('draw-edit-btn').addEventListener('click', () => {
    setDrawMode(currentDrawMode === 'edit' ? 'none' : 'edit');
  });

  document.getElementById('draw-delete-btn').addEventListener('click', () => {
    setDrawMode(currentDrawMode === 'delete' ? 'none' : 'delete');
  });

  document.getElementById('ai-detect-btn').addEventListener('click', () => {
    showToast('AI detection coming soon — Phase 2');
  });

  // Polygon panel toggle
  const polyPanel = document.getElementById('polygon-panel');
  document.getElementById('toggle-panel-btn').addEventListener('click', () => {
    polyPanel.classList.toggle('open');
  });
  document.getElementById('layers-btn').addEventListener('click', () => {
    polyPanel.classList.toggle('open');
  });
  document.getElementById('panel-close-btn').addEventListener('click', () => {
    polyPanel.classList.remove('open');
  });

  // Photo preview modal
  document.getElementById('preview-modal-close').addEventListener('click', closePhotoPreview);
  document.getElementById('photo-preview-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePhotoPreview();
  });
  document.getElementById('preview-keep-btn').addEventListener('click', () => {
    if (!previewPhotoId) return;
    state.photos[previewPhotoId].status = 'keep';
    saveState();
    updateMultiPaneSelects();
    renderPhotoLibrary();
    closePhotoPreview();
  });
  document.getElementById('preview-ignore-btn').addEventListener('click', () => {
    if (!previewPhotoId) return;
    state.photos[previewPhotoId].status = 'ignore';
    saveState();
    updateMultiPaneSelects();
    renderPhotoLibrary();
    closePhotoPreview();
  });

  // Label modal
  document.getElementById('label-modal-close').addEventListener('click', closeLabelModal);
  document.getElementById('label-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeLabelModal();
  });

  document.querySelectorAll('.label-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const label = btn.dataset.label;
      const color = btn.dataset.color;
      addPolygonWithLabel(label, color); // must run before closeLabelModal (which nulls pendingLayer)
      closeLabelModal();
    });
  });

  document.getElementById('label-custom-btn').addEventListener('click', () => {
    const label = document.getElementById('label-custom-input').value.trim();
    if (!label) { showToast('Enter a label name'); return; }
    const hexColor = document.getElementById('label-color-input').value;
    const color = hexToRgba(hexColor, 0.4);
    addPolygonWithLabel(label, color); // must run before closeLabelModal (which nulls pendingLayer)
    closeLabelModal();
  });

  document.getElementById('label-custom-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('label-custom-btn').click();
  });

  // Settings
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-modal-close').addEventListener('click', closeSettings);
  document.getElementById('settings-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSettings();
  });

  document.getElementById('firebase-toggle').addEventListener('change', e => {
    const section = document.getElementById('firebase-config-section');
    section.style.display = e.target.checked ? 'block' : 'none';
    state.settings.firebaseEnabled = e.target.checked;
    saveState();
  });

  document.getElementById('firebase-save-btn').addEventListener('click', () => {
    saveSettings();
    const configStr = document.getElementById('firebase-config-input').value.trim();
    if (!configStr) { showToast('Paste your Firebase config JSON'); return; }
    try {
      const config = JSON.parse(configStr);
      if (initFirebase(config)) {
        signInWithGoogle();
      }
    } catch (e) {
      showToast('Invalid JSON in Firebase config');
    }
  });

  document.getElementById('firebase-signout-btn').addEventListener('click', signOut);

  document.getElementById('clear-data-btn').addEventListener('click', () => {
    if (!confirm('Clear all local data? This cannot be undone.')) return;
    localStorage.removeItem(STATE_KEY);
    // Also remove old per-version keys, or loadState would migrate them back
    while (findLegacyStateKey()) localStorage.removeItem(findLegacyStateKey());
    location.reload();
  });

  // Photo library
  document.getElementById('discover-btn').addEventListener('click', discoverImagery);

  document.getElementById('upload-input').addEventListener('change', async e => {
    if (e.target.files.length > 0) await handleUploadFiles(Array.from(e.target.files));
    e.target.value = '';
  });

  document.getElementById('done-reviewing-btn').addEventListener('click', () => {
    switchView('single');
    // Set main map tile to first kept photo
    const firstKept = Object.values(state.photos).find(p => p.status === 'keep');
    if (firstKept) {
      state.mainViewPhoto = firstKept.id;
      document.getElementById('main-photo-select').value = firstKept.id;
      saveState();
      setMainPhoto(firstKept.id);
    }
    document.getElementById('welcome-overlay').classList.add('hidden');
    showToast('Photo review complete');
    syncFirebase();
  });

  document.getElementById('google-fetch-btn').addEventListener('click', () => {
    const key = document.getElementById('google-api-input').value.trim();
    if (!key) { showToast('Enter a Google API key'); return; }
    state.settings.googleMapsKey = key;
    saveState();
    document.getElementById('google-prompt').style.display = 'none';
    // Fetch Google static map tile layer
    const id = 'google_satellite';
    state.photos[id] = {
      id,
      source: 'google',
      label: 'Google Satellite',
      year: 'Current',
      status: 'unreviewed',
      tileUrl: `https://maps.googleapis.com/maps/api/staticmap?center=${state.center.lat},${state.center.lng}&zoom={z}&size=256x256&maptype=satellite&key=${encodeURIComponent(key)}`,
    };
    saveState();
    renderPhotoLibrary();
    showToast('Google satellite added');
  });

  // Single-view photo selector
  document.getElementById('main-photo-select').addEventListener('change', e => {
    if (alignClickMode) exitAlignClickMode();
    const photoId = e.target.value;
    state.mainViewPhoto = photoId || null;
    saveState();
    setMainPhoto(photoId);
  });

  // Adjust uploaded photo
  document.getElementById('photo-adjust-btn').addEventListener('click', () => {
    if (photoAdjust) exitPhotoAdjust(true); else enterPhotoAdjust();
  });
  document.getElementById('adjust-mode-rigid').addEventListener('click', () => setAdjustMode('rigid'));
  document.getElementById('adjust-mode-free').addEventListener('click', () => setAdjustMode('free'));
  document.getElementById('photo-opacity-input').addEventListener('input', e => {
    if (photoAdjust) photoAdjust.layer.setOpacity(Number(e.target.value) / 100);
  });
  document.getElementById('adjust-reset-btn').addEventListener('click', resetPhotoAdjust);
  document.getElementById('adjust-cancel-btn').addEventListener('click', () => exitPhotoAdjust(false));
  document.getElementById('adjust-done-btn').addEventListener('click', () => {
    exitPhotoAdjust(true);
    showToast('Photo placement saved');
  });

  // Align buttons
  document.getElementById('align-btn').addEventListener('click', onAlignBtnClick);
  document.getElementById('align-reset-btn').addEventListener('click', () => {
    if (!confirm('Clear all alignment offsets and the reference point?')) return;
    resetAllAlignments();
  });

  // Multi-view pane selects
  for (let i = 0; i < 4; i++) {
    document.getElementById(`pane-select-${i}`).addEventListener('change', e => {
      setMultiPanePhoto(i, e.target.value);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service worker registration
// ─────────────────────────────────────────────────────────────────────────────

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('SW registered:', reg.scope))
      .catch(e => console.warn('SW registration failed:', e));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

async function boot() {
  loadState();

  // Version badge
  document.getElementById('version-badge').textContent = APP_VERSION.replace('my-landscaping-', '');

  // Restore address input
  document.getElementById('address-input').value = state.address || '';

  // Open IndexedDB
  try { idb = await openIDB(); } catch (e) { console.warn('IDB unavailable:', e); }

  // Init main map
  initMainMap();

  // Restore polygons from state
  restorePolygons();

  // Restore photo library
  renderPhotoLibrary();
  updateMultiPaneSelects();

  // Restore single-view selected photo
  if (state.mainViewPhoto && state.photos[state.mainViewPhoto]) {
    document.getElementById('main-photo-select').value = state.mainViewPhoto;
  }
  setMainPhoto(state.mainViewPhoto && state.photos[state.mainViewPhoto] ? state.mainViewPhoto : null);

  // Restore alignment anchor marker and reset button visibility
  if (state.alignAnchor) placeAnchorMarker(state.alignAnchor.lat, state.alignAnchor.lng);
  updateAlignResetBtn();

  // Show welcome overlay only if no address has been set
  if (state.address) {
    document.getElementById('welcome-overlay').classList.add('hidden');
  }

  // Wire UI events
  wireEvents();

  // Restore active view
  switchView(state.activeView || 'single');

  // Firebase auto-init if configured
  if (state.settings.firebaseEnabled && state.settings.firebaseConfig) {
    try {
      const config = JSON.parse(state.settings.firebaseConfig);
      initFirebase(config);
    } catch (e) {
      console.warn('Firebase auto-init failed:', e);
    }
  }

  // Register service worker
  registerSW();
}

boot();
