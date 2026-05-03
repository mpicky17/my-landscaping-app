// app.js — My Landscaping App
// Vanilla JS, no build step.

const APP_VERSION = 'my-landscaping-v6';

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
  multiViewPhotos: [null, null, null, null],
  settings: {
    googleMapsKey: '',
    claudeKey: '',
    firebaseEnabled: false,
    firebaseConfig: '',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

function saveState() {
  try {
    localStorage.setItem(APP_VERSION, JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save state:', e);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(APP_VERSION);
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
let drawControl = null;
let polygonFeatureGroup = null;   // shared across all maps
let multiPolyGroups = [];         // references added to each multi map
let previewMap = null;
let previewPhotoId = null;

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
}

function setMultiPanePhoto(paneIdx, photoId) {
  if (!mapMulti[paneIdx]) return;
  state.multiViewPhotos[paneIdx] = photoId;
  saveState();

  if (multiTileLayers[paneIdx]) mapMulti[paneIdx].removeLayer(multiTileLayers[paneIdx]);

  const photo = state.photos[photoId];
  if (!photo || !photo.tileUrl) {
    multiTileLayers[paneIdx] = L.tileLayer(ESRI_IMAGERY, { maxZoom: 22, maxNativeZoom: 19 }).addTo(mapMulti[paneIdx]);
    return;
  }

  if (photo.source === 'upload') {
    // For uploaded images, show a simple bounds-overlay
    loadImage(photoId).then(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const bounds = photo.bounds || mapMain.getBounds();
      const overlay = L.imageOverlay(url, bounds).addTo(mapMulti[paneIdx]);
      multiTileLayers[paneIdx] = overlay;
    });
    return;
  }

  multiTileLayers[paneIdx] = L.tileLayer(photo.tileUrl, {
    maxZoom: 22,
    maxNativeZoom: 19,
  }).addTo(mapMulti[paneIdx]);
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
  // USGS National Map NAIP Plus — free public tile service, no auth required.
  // naip.arcgis.com requires an Esri subscription and returns blank tiles without one.
  // Always overwrite so fixes to tileUrl/maxNativeZoom take effect without clearing data
  state.photos['naip_usgs'] = {
    id: 'naip_usgs',
    source: 'naip',
    label: 'NAIP (USGS Latest)',
    year: 'Latest',
    status: state.photos['naip_usgs']?.status || 'unreviewed', // preserve keep/ignore
    tileUrl: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/MapServer/tile/{z}/{y}/{x}',
    maxNativeZoom: 16,
  };

  // Always ensure we have the Esri current as a baseline
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
    tl.on('tileerror', e => console.error(`[thumb] tile error for ${photo.id}:`, e.coords, e.error || e));
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Photo upload
// ─────────────────────────────────────────────────────────────────────────────

async function handleUploadFiles(files) {
  for (const file of files) {
    const id = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const bounds = mapMain ? mapMain.getBounds() : null;
    const boundsArr = bounds ? [[bounds.getSouth(), bounds.getWest()], [bounds.getNorth(), bounds.getEast()]] : null;

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

    await saveImage(id, file);
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
  document.getElementById('firebase-toggle').checked = state.settings.firebaseEnabled || false;
  document.getElementById('firebase-config-input').value = state.settings.firebaseConfig || '';
  document.getElementById('firebase-config-section').style.display = state.settings.firebaseEnabled ? 'block' : 'none';
  updateSyncStatus();
}

function closeSettings() {
  document.getElementById('settings-modal').classList.remove('open');
}

function saveSettings() {
  state.settings.googleMapsKey = document.getElementById('google-maps-key-input').value.trim();
  state.settings.claudeKey = document.getElementById('claude-key-input').value.trim();
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
      loadImage(photoId).then(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const bounds = photo.bounds || previewMap.getBounds();
        L.imageOverlay(url, bounds, { opacity: 0.85 }).addTo(previewMap);
      });
    } else if (photo.tileUrl) {
      L.tileLayer(photo.tileUrl, { maxZoom: 22, maxNativeZoom: nativeZoom }).addTo(previewMap);
    }
  });
}

function closePhotoPreview() {
  document.getElementById('photo-preview-modal').classList.remove('open');
  previewPhotoId = null;
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
    localStorage.removeItem(APP_VERSION);
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
    if (firstKept && firstKept.tileUrl) {
      setMainTileLayer(firstKept.tileUrl);
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
  document.getElementById('version-badge').textContent = APP_VERSION.replace('my-landscaping-', 'v');

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
