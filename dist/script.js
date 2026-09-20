"use strict";

const PROGRESS_FILE_NAME = "count-images.txt";
const HANDLE_DB_NAME = "SmartScanCargoLocalSettings";
const HANDLE_STORE_NAME = "file-system-handles";
const HANDLE_KEY = "dataset-root";

const elements = {
  upload: document.querySelector("#uploadButton"),
  undo: document.querySelector("#undoButton"),
  reset: document.querySelector("#resetButton"),
  report: document.querySelector("#reportButton"),
  reportText: document.querySelector("#reportText"),
  datasetPath: document.querySelector("#datasetPath"),
  status: document.querySelector("#status"),
  currentItem: document.querySelector("#currentItem"),
  xrayCanvas: document.querySelector("#xrayCanvas"),
  xrayPlaceholder: document.querySelector("#xrayPlaceholder"),
  hemdCanvas: document.querySelector("#hemdCanvas"),
  hemdPlaceholder: document.querySelector("#hemdPlaceholder"),
  dialog: document.querySelector("#confirmDialog"),
  initialChoiceDialog: document.querySelector("#initialChoiceDialog"),
  chooseReviewedButton: document.querySelector("#chooseReviewedButton"),
  messageDialog: document.querySelector("#messageDialog"),
  messageDialogTitle: document.querySelector("#messageDialogTitle"),
  messageDialogText: document.querySelector("#messageDialogText")
};

const ctx = elements.xrayCanvas.getContext("2d", { willReadFrequently: true });
const hemdCtx = elements.hemdCanvas.getContext("2d");
const originalCanvas = document.createElement("canvas");
const originalCtx = originalCanvas.getContext("2d", { willReadFrequently: true });
const hemdOriginalImage = new Image();

const state = {
  rootHandle: null,
  savedRootHandle: null,
  items: [],
  completedIndices: new Set(),
  currentPosition: -1,
  boxes: [],
  history: [],
  xrayUrl: null,
  hemdUrl: null,
  dragging: false,
  dragStart: null,
  draftBox: null,
  reportBeforeEdit: null,
  restoring: false
};

function setStatus(message, kind = "info") {
  elements.status.textContent = message;
  elements.status.className = `status${kind === "info" ? "" : ` ${kind}`}`;
}

function updateControls() {
  const loaded = state.currentPosition >= 0;
  elements.upload.textContent = loaded ? "Próxima Imagem" : "UpLoad Images";
  elements.undo.disabled = state.history.length === 0;
  elements.report.disabled = !loaded;
  elements.reportText.disabled = !loaded;
  elements.currentItem.textContent = loaded
    ? `Carga atual: Imagem${state.items[state.currentPosition].index}`
    : "Nenhuma carga selecionada";
}

function snapshot() {
  return {
    currentPosition: state.currentPosition,
    boxes: state.boxes.map(box => ({ ...box })),
    report: elements.reportText.value
  };
}

function pushHistory() {
  if (state.restoring) return;
  state.history.push(snapshot());
  if (state.history.length > 100) state.history.shift();
  updateControls();
}

function revokeUrls() {
  if (state.xrayUrl) URL.revokeObjectURL(state.xrayUrl);
  if (state.hemdUrl) URL.revokeObjectURL(state.hemdUrl);
  state.xrayUrl = null;
  state.hemdUrl = null;
}

async function getChildFile(directoryHandle, wantedName) {
  for await (const entry of directoryHandle.values()) {
    if (entry.kind === "file" && entry.name.toLowerCase() === wantedName.toLowerCase()) {
      return entry.getFile();
    }
  }
  throw new Error(`Arquivo não encontrado: ${wantedName}`);
}

async function discoverItems(rootHandle) {
  const found = [];
  for await (const entry of rootHandle.values()) {
    if (entry.kind !== "directory") continue;
    const match = /^imagem(\d+)$/i.exec(entry.name);
    if (match) found.push({ index: Number(match[1]), directory: entry });
  }
  found.sort((a, b) => a.index - b.index);
  return found;
}

async function readCompletedIndices(rootHandle) {
  try {
    const fileHandle = await rootHandle.getFileHandle(PROGRESS_FILE_NAME);
    const text = await (await fileHandle.getFile()).text();
    return new Set(
      (text.match(/\d+/g) || [])
        .map(Number)
        .filter(index => Number.isInteger(index) && index > 0)
    );
  } catch (error) {
    if (error.name === "NotFoundError") return new Set();
    throw error;
  }
}

async function writeCompletedIndices() {
  const fileHandle = await state.rootHandle.getFileHandle(PROGRESS_FILE_NAME, { create: true });
  const indices = [...state.completedIndices].sort((a, b) => a - b);
  const writable = await fileHandle.createWritable();
  await writable.write(indices.length ? `${indices.join("\n")}\n` : "");
  await writable.close();
}

function findNextPendingPosition(afterPosition = -1) {
  if (!state.items.length) return -1;
  for (let offset = 1; offset <= state.items.length; offset += 1) {
    const position = (afterPosition + offset) % state.items.length;
    if (!state.completedIndices.has(state.items[position].index)) return position;
  }
  return -1;
}

function ensureMessageDialog() {
  if (elements.messageDialog && elements.messageDialogTitle && elements.messageDialogText) return;

  const dialog = document.createElement("dialog");
  dialog.id = "messageDialog";
  dialog.className = "confirm-dialog";
  dialog.innerHTML = `
    <form method="dialog">
      <h2 id="messageDialogTitle">Aviso</h2>
      <p id="messageDialogText" class="message-text"></p>
      <div class="dialog-actions">
        <button value="ok" class="dialog-button confirm-button">OK</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  elements.messageDialog = dialog;
  elements.messageDialogTitle = dialog.querySelector("#messageDialogTitle");
  elements.messageDialogText = dialog.querySelector("#messageDialogText");
  elements.messageDialogText.style.whiteSpace = "pre-line";
}

function showMessage(title, message) {
  ensureMessageDialog();
  elements.messageDialogTitle.textContent = title;
  elements.messageDialogText.textContent = message;
  elements.messageDialog.returnValue = "";
  elements.messageDialog.showModal();
  return new Promise(resolve => {
    elements.messageDialog.addEventListener("close", resolve, { once: true });
  });
}

async function finishPendingQueue() {
  await showMessage(
    "Análise concluída",
    "Não existem mais imagens pendentes para análise. O sistema retornará ao início."
  );
  clearDisplayedState(false);
  setStatus("Todas as imagens foram analisadas. Sistema restaurado ao estado inicial.", "success");
}

function openHandleDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(HANDLE_STORE_NAME)) {
        request.result.createObjectStore(HANDLE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveDatasetHandle(handle) {
  const database = await openHandleDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(HANDLE_STORE_NAME, "readwrite");
    transaction.objectStore(HANDLE_STORE_NAME).put(handle, HANDLE_KEY);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function readDatasetHandle() {
  const database = await openHandleDatabase();
  const handle = await new Promise((resolve, reject) => {
    const request = database.transaction(HANDLE_STORE_NAME, "readonly")
      .objectStore(HANDLE_STORE_NAME)
      .get(HANDLE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return handle;
}

async function activateDataset(handle) {
  const items = await discoverItems(handle);
  if (!items.length) throw new Error("A pasta selecionada não contém diretórios Imagem<índice>.");
  clearDisplayedState(false);
  state.rootHandle = handle;
  state.savedRootHandle = handle;
  state.items = items;
  state.completedIndices = await readCompletedIndices(handle);
  elements.datasetPath.value = handle.name;
  elements.datasetPath.classList.add("selected");
  updateControls();
  const pendingCount = items.filter(item => !state.completedIndices.has(item.index)).length;
  setStatus(`Dataset ${handle.name} carregado: ${pendingCount} imagem(ns) pendente(s).`, "success");
}

async function restoreDatasetHandle() {
  try {
    const handle = await readDatasetHandle();
    if (!handle) return;
    state.savedRootHandle = handle;
    elements.datasetPath.value = handle.name;
    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission === "granted") {
      await activateDataset(handle);
    } else {
      setStatus(`Clique no campo da pasta para autorizar novamente o dataset ${handle.name}.`);
    }
  } catch (error) {
    setStatus(`Não foi possível recuperar a pasta salva: ${error.message}`, "error");
  }
}

async function chooseSpecificImagePosition(reviewedOnly = false) {
  try {
    const [fileHandle] = await window.showOpenFilePicker({
      startIn: state.rootHandle,
      multiple: false,
      excludeAcceptAllOption: true,
      types: [{
        description: "Imagem de raio X ou HEMD",
        accept: { "image/png": [".png"] }
      }]
    });
    const match = /^(?:xray|hemd)(\d+)\.png$/i.exec(fileHandle.name);
    if (!match) throw new Error("Selecione um arquivo com nome xray<índice>.png ou hemd<índice>.png.");
    const selectedIndex = Number(match[1]);
    const position = state.items.findIndex(item => item.index === selectedIndex);
    if (position < 0) throw new Error(`O dataset selecionado não contém o diretório Imagem${selectedIndex}.`);
    if (reviewedOnly && !state.completedIndices.has(selectedIndex)) {
      throw new Error(`A Imagem${selectedIndex} ainda está pendente. Para uma seleção manual, escolha uma imagem já analisada.`);
    }
    return position;
  } catch (error) {
    if (error.name === "AbortError") return -1;
    throw error;
  }
}

async function chooseAndActivateDataset() {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("Este navegador não permite acesso direto a pastas. Abra o sistema no Chrome ou Edge atualizado.");
  }
  const handle = await window.showDirectoryPicker({
    mode: "readwrite",
    startIn: state.rootHandle || state.savedRootHandle || "documents"
  });
  const permission = await handle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") throw new Error("A permissão de leitura e gravação não foi concedida.");
  await saveDatasetHandle(handle);
  await activateDataset(handle);
}

let initialChoiceResolve = null;

function askInitialChoice() {
  return new Promise(resolve => {
    initialChoiceResolve = resolve;
    elements.initialChoiceDialog.returnValue = "";
    elements.initialChoiceDialog.showModal();
  });
}

elements.initialChoiceDialog.addEventListener("close", () => {
  if (!initialChoiceResolve) return;
  const resolve = initialChoiceResolve;
  initialChoiceResolve = null;
  resolve(-1);
});

elements.chooseReviewedButton.addEventListener("click", async () => {
  if (!initialChoiceResolve) return;
  try {
    const position = await chooseSpecificImagePosition(true);
    if (position < 0) return;
    const resolve = initialChoiceResolve;
    initialChoiceResolve = null;
    elements.initialChoiceDialog.close("reviewed");
    resolve(position);
  } catch (error) {
    if (error.name === "AbortError") return;
    setStatus(error.message, "error");
  }
});

function parseInfo(text) {
  const values = {
    suspeito: "",
    mercadoria_nf: "",
    des_conteudo: "",
    mercadoria_manifestada: ""
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*([^:=]+?)\s*[:=]\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    if (Object.hasOwn(values, key)) values[key] = match[2].trim();
  }
  return values;
}

function buildReport(info) {
  return [
    `suspeito: ${info.suspeito}`,
    `mercadoria_nf: ${info.mercadoria_nf}`,
    `des_conteudo: ${info.des_conteudo}`,
    `mercadoria_manifestada: ${info.mercadoria_manifestada}`,
    "comentário: "
  ].join("\n");
}

function loadImage(url, imageElement) {
  return new Promise((resolve, reject) => {
    imageElement.onload = () => resolve(imageElement);
    imageElement.onerror = () => reject(new Error("Não foi possível abrir uma das imagens."));
    imageElement.src = url;
  });
}

async function loadItem(position, restored = null) {
  const item = state.items[position];
  if (!item) throw new Error("Não existe outra imagem no diretório selecionado.");

  const index = item.index;
  const [xrayFile, hemdFile, infoFile] = await Promise.all([
    getChildFile(item.directory, `xray${index}.png`),
    getChildFile(item.directory, `hemd${index}.png`),
    getChildFile(item.directory, `InfoSuspeitas${index}.txt`)
  ]);

  revokeUrls();
  state.xrayUrl = URL.createObjectURL(xrayFile);
  state.hemdUrl = URL.createObjectURL(hemdFile);

  const xrayImage = new Image();
  await Promise.all([
    loadImage(state.xrayUrl, xrayImage),
    loadImage(state.hemdUrl, hemdOriginalImage)
  ]);

  originalCanvas.width = xrayImage.naturalWidth;
  originalCanvas.height = xrayImage.naturalHeight;
  originalCtx.drawImage(xrayImage, 0, 0);
  elements.xrayCanvas.width = xrayImage.naturalWidth;
  elements.xrayCanvas.height = xrayImage.naturalHeight;
  elements.hemdCanvas.width = hemdOriginalImage.naturalWidth;
  elements.hemdCanvas.height = hemdOriginalImage.naturalHeight;

  state.currentPosition = position;
  state.boxes = restored ? restored.boxes.map(box => ({ ...box })) : [];
  elements.reportText.value = restored
    ? restored.report
    : buildReport(parseInfo(await infoFile.text()));

  elements.xrayCanvas.style.display = "block";
  elements.xrayPlaceholder.hidden = true;
  elements.hemdCanvas.style.display = "block";
  elements.hemdPlaceholder.hidden = true;
  redrawXray();
  updateControls();
  setStatus(`Imagem${index} carregada com sucesso.`, "success");
}

function equalizeRegion(imageData) {
  const data = imageData.data;
  for (let channel = 0; channel < 3; channel += 1) {
    const histogram = new Uint32Array(256);
    for (let i = channel; i < data.length; i += 4) histogram[data[i]] += 1;
    const cdf = new Uint32Array(256);
    let cumulative = 0;
    let first = 0;
    for (let i = 0; i < 256; i += 1) {
      cumulative += histogram[i];
      cdf[i] = cumulative;
      if (!first && histogram[i]) first = cumulative;
    }
    const total = imageData.width * imageData.height;
    const denominator = total - first;
    if (denominator <= 0) continue;
    for (let i = channel; i < data.length; i += 4) {
      data[i] = Math.round(((cdf[data[i]] - first) / denominator) * 255);
    }
  }
  return imageData;
}

function redrawXray() {
  if (state.currentPosition < 0) return;
  ctx.clearRect(0, 0, elements.xrayCanvas.width, elements.xrayCanvas.height);
  ctx.drawImage(originalCanvas, 0, 0);
  for (const box of state.boxes) {
    const region = ctx.getImageData(box.x, box.y, box.width, box.height);
    ctx.putImageData(equalizeRegion(region), box.x, box.y);
  }
  const boxesToDraw = state.draftBox ? [...state.boxes, state.draftBox] : state.boxes;
  ctx.save();
  ctx.lineWidth = Math.max(2, elements.xrayCanvas.width / 500);
  ctx.font = `bold ${Math.max(15, elements.xrayCanvas.width / 55)}px Segoe UI`;
  boxesToDraw.forEach((box, i) => {
    ctx.strokeStyle = state.draftBox && i === boxesToDraw.length - 1 ? "#facc15" : "#ef4444";
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(`BB ${i + 1}`, box.x + 5, Math.max(20, box.y - 7));
  });
  ctx.restore();
  redrawHemd();
}

function redrawHemd() {
  if (state.currentPosition < 0) return;
  const hemdWidth = elements.hemdCanvas.width;
  const hemdHeight = elements.hemdCanvas.height;
  const xrayWidth = elements.xrayCanvas.width;
  const xrayHeight = elements.xrayCanvas.height;
  if (!hemdWidth || !hemdHeight || !xrayWidth || !xrayHeight) return;

  hemdCtx.clearRect(0, 0, hemdWidth, hemdHeight);
  hemdCtx.drawImage(hemdOriginalImage, 0, 0, hemdWidth, hemdHeight);

  const boxesToDraw = state.draftBox ? [...state.boxes, state.draftBox] : state.boxes;
  const scaleX = hemdWidth / xrayWidth;
  const scaleY = hemdHeight / xrayHeight;
  hemdCtx.save();
  hemdCtx.lineWidth = Math.max(2, hemdWidth / 500);
  hemdCtx.font = `bold ${Math.max(15, hemdWidth / 55)}px Segoe UI`;
  boxesToDraw.forEach((box, i) => {
    const x = box.x * scaleX;
    const y = box.y * scaleY;
    const width = box.width * scaleX;
    const height = box.height * scaleY;
    hemdCtx.strokeStyle = state.draftBox && i === boxesToDraw.length - 1 ? "#facc15" : "#ef4444";
    hemdCtx.strokeRect(x, y, width, height);
    hemdCtx.fillStyle = hemdCtx.strokeStyle;
    hemdCtx.fillText(`BB ${i + 1}`, x + 5, Math.max(20, y - 7));
  });
  hemdCtx.restore();
}

function pointerPosition(event) {
  const rect = elements.xrayCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(elements.xrayCanvas.width, Math.round((event.clientX - rect.left) * elements.xrayCanvas.width / rect.width))),
    y: Math.max(0, Math.min(elements.xrayCanvas.height, Math.round((event.clientY - rect.top) * elements.xrayCanvas.height / rect.height)))
  };
}

function canvasPosition(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height))
  };
}

function findBoxAtPosition(position, scaleX = 1, scaleY = 1) {
  for (let index = state.boxes.length - 1; index >= 0; index -= 1) {
    const box = state.boxes[index];
    const x = box.x * scaleX;
    const y = box.y * scaleY;
    const width = box.width * scaleX;
    const height = box.height * scaleY;
    if (position.x >= x && position.x <= x + width && position.y >= y && position.y <= y + height) {
      return index;
    }
  }
  return -1;
}

function createBoxPreview(boxIndex, source) {
  const box = state.boxes[boxIndex];
  const preview = document.createElement("canvas");

  if (source === "hemd") {
    const scaleX = elements.hemdCanvas.width / elements.xrayCanvas.width;
    const scaleY = elements.hemdCanvas.height / elements.xrayCanvas.height;
    const sourceX = Math.round(box.x * scaleX);
    const sourceY = Math.round(box.y * scaleY);
    const sourceWidth = Math.max(1, Math.round(box.width * scaleX));
    const sourceHeight = Math.max(1, Math.round(box.height * scaleY));
    preview.width = sourceWidth;
    preview.height = sourceHeight;
    preview.getContext("2d").drawImage(
      hemdOriginalImage,
      sourceX, sourceY, sourceWidth, sourceHeight,
      0, 0, sourceWidth, sourceHeight
    );
    return preview;
  }

  preview.width = Math.max(1, Math.round(box.width));
  preview.height = Math.max(1, Math.round(box.height));
  const previewContext = preview.getContext("2d", { willReadFrequently: true });
  previewContext.drawImage(
    originalCanvas,
    box.x, box.y, box.width, box.height,
    0, 0, preview.width, preview.height
  );
  const imageData = previewContext.getImageData(0, 0, preview.width, preview.height);
  previewContext.putImageData(equalizeRegion(imageData), 0, 0);
  return preview;
}

function openBoxPreview(boxIndex, source) {
  const preview = createBoxPreview(boxIndex, source);
  const imageUrl = preview.toDataURL("image/png");
  const sourceLabel = source === "hemd" ? "HEMD" : "Raio-X";
  const popupWidth = Math.min(1100, Math.max(520, preview.width + 40));
  const popupHeight = Math.min(850, Math.max(420, preview.height + 90));
  const popup = window.open("", `SmartScanCargo_BB${boxIndex + 1}_${source}`, `width=${popupWidth},height=${popupHeight},resizable=yes,scrollbars=no`);

  if (!popup) {
    showMessage("Janela bloqueada", "O navegador bloqueou a janela do BB. Autorize pop-ups para este endereço e tente novamente.");
    return;
  }

  popup.document.open();
  popup.document.write(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BB${boxIndex + 1} — ${sourceLabel}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #080d19; }
    body { display: grid; grid-template-rows: auto 1fr; color: #fff; font-family: "Segoe UI", sans-serif; }
    header { padding: 10px 16px; background: #111827; font-weight: 700; display: flex; gap: 16px; align-items: center; justify-content: space-between; }
    header span { color: #cbd5e1; font-size: 13px; font-weight: 400; }
    .header-actions { display: flex; gap: 10px; align-items: center; }
    button { border: 1px solid #60a5fa; border-radius: 8px; padding: 8px 12px; background: #2563eb; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    button:disabled { border-color: #475569; background: #334155; color: #94a3b8; cursor: not-allowed; }
    button.active { border-color: #facc15; background: #b45309; }
    .preview { position: relative; min-width: 0; min-height: 0; padding: 12px; display: flex; align-items: center; justify-content: center; overflow: hidden; cursor: grab; outline: none; touch-action: none; }
    img { width: 100%; height: 100%; object-fit: contain; image-rendering: auto; transform: scale(1); transform-origin: center; user-select: none; -webkit-user-drag: none; }
    .local-selection { position: absolute; z-index: 2; border: 2px solid #facc15; background: rgba(250, 204, 21, 0.14); pointer-events: none; }
    .local-selection[hidden] { display: none; }
  </style>
</head>
<body>
  <header>
    <strong>BB${boxIndex + 1} — ${sourceLabel}</strong>
    <div class="header-actions">
      <span id="zoomStatus">Zoom: 100% · roda: zoom · botão esquerdo: arrastar</span>
      <button id="undoEqualization" type="button" disabled>Desfazer equalização</button>
      <button id="equalizeVisible" type="button">Equalização</button>
    </div>
  </header>
  <div class="preview" tabindex="0">
    <img src="${imageUrl}" alt="Ampliação do BB${boxIndex + 1}" draggable="false">
    <div id="localSelection" class="local-selection" hidden></div>
  </div>
</body>
</html>`);
  popup.document.close();
  const previewArea = popup.document.querySelector(".preview");
  const previewImage = popup.document.querySelector("img");
  const zoomStatus = popup.document.querySelector("#zoomStatus");
  const equalizeVisibleButton = popup.document.querySelector("#equalizeVisible");
  const undoEqualizationButton = popup.document.querySelector("#undoEqualization");
  const localSelection = popup.document.querySelector("#localSelection");
  const previewContext = preview.getContext("2d", { willReadFrequently: true });
  const equalizationHistory = [];
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let panning = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;
  let equalizationMode = false;
  let selectingEqualization = false;
  let selectionStartX = 0;
  let selectionStartY = 0;
  let selectionCurrentX = 0;
  let selectionCurrentY = 0;

  const updatePreviewTransform = () => {
    previewImage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    zoomStatus.textContent = `Zoom: ${Math.round(zoom * 100)}% · equalizações: ${equalizationHistory.length}`;
  };

  const setEqualizationMode = active => {
    equalizationMode = active;
    selectingEqualization = false;
    localSelection.hidden = true;
    equalizeVisibleButton.classList.toggle("active", active);
    equalizeVisibleButton.textContent = active ? "Desenhe a área" : "Equalização";
    previewArea.style.cursor = active ? "crosshair" : "grab";
    if (active) zoomStatus.textContent = "Desenhe a caixa que será equalizada";
    else updatePreviewTransform();
  };

  const clampedPreviewPoint = event => {
    const rect = previewArea.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top))
    };
  };

  const updateLocalSelection = () => {
    const left = Math.min(selectionStartX, selectionCurrentX);
    const top = Math.min(selectionStartY, selectionCurrentY);
    localSelection.style.left = `${left}px`;
    localSelection.style.top = `${top}px`;
    localSelection.style.width = `${Math.abs(selectionCurrentX - selectionStartX)}px`;
    localSelection.style.height = `${Math.abs(selectionCurrentY - selectionStartY)}px`;
  };

  const applyLocalEqualization = selectionRect => {
    const elementRect = previewImage.getBoundingClientRect();
    const sourceAspect = preview.width / preview.height;
    const elementAspect = elementRect.width / elementRect.height;
    let contentWidth;
    let contentHeight;

    if (elementAspect > sourceAspect) {
      contentHeight = elementRect.height;
      contentWidth = contentHeight * sourceAspect;
    } else {
      contentWidth = elementRect.width;
      contentHeight = contentWidth / sourceAspect;
    }

    const contentLeft = elementRect.left + (elementRect.width - contentWidth) / 2;
    const contentTop = elementRect.top + (elementRect.height - contentHeight) / 2;
    const visibleLeft = Math.max(selectionRect.left, contentLeft);
    const visibleTop = Math.max(selectionRect.top, contentTop);
    const visibleRight = Math.min(selectionRect.right, contentLeft + contentWidth);
    const visibleBottom = Math.min(selectionRect.bottom, contentTop + contentHeight);

    if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
      popup.alert("A caixa precisa conter uma parte visível da imagem.");
      return false;
    }

    const sourceX = Math.max(0, Math.floor((visibleLeft - contentLeft) * preview.width / contentWidth));
    const sourceY = Math.max(0, Math.floor((visibleTop - contentTop) * preview.height / contentHeight));
    const sourceRight = Math.min(preview.width, Math.ceil((visibleRight - contentLeft) * preview.width / contentWidth));
    const sourceBottom = Math.min(preview.height, Math.ceil((visibleBottom - contentTop) * preview.height / contentHeight));
    const sourceWidth = Math.max(1, sourceRight - sourceX);
    const sourceHeight = Math.max(1, sourceBottom - sourceY);
    const previousPixels = previewContext.getImageData(sourceX, sourceY, sourceWidth, sourceHeight);
    const equalizedPixels = previewContext.createImageData(previousPixels.width, previousPixels.height);
    equalizedPixels.data.set(previousPixels.data);
    equalizationHistory.push({ x: sourceX, y: sourceY, pixels: previousPixels });
    previewContext.putImageData(equalizeRegion(equalizedPixels), sourceX, sourceY);
    previewImage.src = preview.toDataURL("image/png");
    undoEqualizationButton.disabled = false;
    return true;
  };

  previewArea.addEventListener("click", () => previewArea.focus());
  previewArea.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = previewArea.getBoundingClientRect();
    const originX = ((event.clientX - rect.left) / rect.width) * 100;
    const originY = ((event.clientY - rect.top) / rect.height) * 100;
    previewImage.style.transformOrigin = `${originX}% ${originY}%`;
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoom = Math.max(0.25, Math.min(12, zoom * factor));
    updatePreviewTransform();
  }, { passive: false });

  previewArea.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (equalizationMode) {
      const point = clampedPreviewPoint(event);
      selectingEqualization = true;
      selectionStartX = point.x;
      selectionStartY = point.y;
      selectionCurrentX = point.x;
      selectionCurrentY = point.y;
      localSelection.hidden = false;
      updateLocalSelection();
      previewArea.setPointerCapture(event.pointerId);
      return;
    }
    panning = true;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    panStartX = panX;
    panStartY = panY;
    previewArea.style.cursor = "grabbing";
    previewArea.setPointerCapture(event.pointerId);
  });

  previewArea.addEventListener("pointermove", event => {
    if (selectingEqualization) {
      const point = clampedPreviewPoint(event);
      selectionCurrentX = point.x;
      selectionCurrentY = point.y;
      updateLocalSelection();
      return;
    }
    if (!panning) return;
    panX = panStartX + event.clientX - dragStartX;
    panY = panStartY + event.clientY - dragStartY;
    updatePreviewTransform();
  });

  const finishPanning = event => {
    if (selectingEqualization) {
      const point = clampedPreviewPoint(event);
      selectionCurrentX = point.x;
      selectionCurrentY = point.y;
      updateLocalSelection();
      selectingEqualization = false;
      localSelection.hidden = true;
      const previewRect = previewArea.getBoundingClientRect();
      const left = previewRect.left + Math.min(selectionStartX, selectionCurrentX);
      const top = previewRect.top + Math.min(selectionStartY, selectionCurrentY);
      const right = previewRect.left + Math.max(selectionStartX, selectionCurrentX);
      const bottom = previewRect.top + Math.max(selectionStartY, selectionCurrentY);
      if (right - left >= 3 && bottom - top >= 3 && applyLocalEqualization({ left, top, right, bottom })) {
        setEqualizationMode(false);
      }
      if (event.pointerId !== undefined && previewArea.hasPointerCapture(event.pointerId)) {
        previewArea.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (!panning) return;
    panning = false;
    previewArea.style.cursor = "grab";
    if (event.pointerId !== undefined && previewArea.hasPointerCapture(event.pointerId)) {
      previewArea.releasePointerCapture(event.pointerId);
    }
  };

  previewArea.addEventListener("pointerup", finishPanning);
  previewArea.addEventListener("pointercancel", finishPanning);
  previewArea.addEventListener("lostpointercapture", () => {
    panning = false;
    if (!selectingEqualization) previewArea.style.cursor = equalizationMode ? "crosshair" : "grab";
  });

  previewArea.addEventListener("dblclick", () => {
    zoom = 1;
    panX = 0;
    panY = 0;
    previewImage.style.transformOrigin = "center";
    previewArea.style.cursor = "grab";
    updatePreviewTransform();
  });

  equalizeVisibleButton.addEventListener("click", () => setEqualizationMode(!equalizationMode));

  undoEqualizationButton.addEventListener("click", () => {
    const lastEqualization = equalizationHistory.pop();
    if (!lastEqualization) return;
    previewContext.putImageData(lastEqualization.pixels, lastEqualization.x, lastEqualization.y);
    previewImage.src = preview.toDataURL("image/png");
    undoEqualizationButton.disabled = equalizationHistory.length === 0;
    zoomStatus.textContent = `Zoom: ${Math.round(zoom * 100)}% · equalizações: ${equalizationHistory.length}`;
    previewArea.focus();
  });
  popup.focus();
  previewArea.focus();
}

elements.xrayCanvas.addEventListener("contextmenu", event => {
  if (state.currentPosition < 0) return;
  const boxIndex = findBoxAtPosition(canvasPosition(event, elements.xrayCanvas));
  if (boxIndex < 0) return;
  event.preventDefault();
  openBoxPreview(boxIndex, "xray");
});

elements.hemdCanvas.addEventListener("contextmenu", event => {
  if (state.currentPosition < 0) return;
  const scaleX = elements.hemdCanvas.width / elements.xrayCanvas.width;
  const scaleY = elements.hemdCanvas.height / elements.xrayCanvas.height;
  const boxIndex = findBoxAtPosition(canvasPosition(event, elements.hemdCanvas), scaleX, scaleY);
  if (boxIndex < 0) return;
  event.preventDefault();
  openBoxPreview(boxIndex, "hemd");
});

function normalizedBox(start, end) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return { x, y, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

elements.xrayCanvas.addEventListener("pointerdown", event => {
  if (state.currentPosition < 0 || event.button !== 0) return;
  state.dragging = true;
  state.dragStart = pointerPosition(event);
  state.draftBox = { x: state.dragStart.x, y: state.dragStart.y, width: 0, height: 0 };
  elements.xrayCanvas.setPointerCapture(event.pointerId);
});

elements.xrayCanvas.addEventListener("pointermove", event => {
  if (!state.dragging) return;
  state.draftBox = normalizedBox(state.dragStart, pointerPosition(event));
  redrawXray();
});

elements.xrayCanvas.addEventListener("pointerup", event => {
  if (!state.dragging) return;
  const box = normalizedBox(state.dragStart, pointerPosition(event));
  state.dragging = false;
  state.dragStart = null;
  state.draftBox = null;
  if (box.width < 3 || box.height < 3) {
    redrawXray();
    return;
  }
  pushHistory();
  state.boxes.push(box);
  const reportPrefix = elements.reportText.value.trimEnd();
  elements.reportText.value = `${reportPrefix}\nBB${state.boxes.length}: comente ...`;
  redrawXray();
  updateControls();
  setStatus(`Bounding box ${state.boxes.length} criada e equalizada.`, "success");
});

elements.upload.addEventListener("click", async () => {
  try {
    if (!state.rootHandle) {
      await chooseAndActivateDataset();
      const selectedPosition = await askInitialChoice();
      const initialPosition = selectedPosition >= 0
        ? selectedPosition
        : findNextPendingPosition(-1);
      if (initialPosition < 0) {
        await finishPendingQueue();
        return;
      }
      pushHistory();
      await loadItem(initialPosition);
      return;
    }
    let selectedPosition = -1;
    if (state.currentPosition < 0) {
      if (!("showOpenFilePicker" in window)) {
        throw new Error("Este navegador não permite selecionar arquivos. Abra o sistema no Chrome ou Edge atualizado.");
      }
      selectedPosition = await chooseSpecificImagePosition(true);
    }
    const position = selectedPosition >= 0 ? selectedPosition : findNextPendingPosition(state.currentPosition);
    if (position < 0) {
      await finishPendingQueue();
      return;
    }
    pushHistory();
    await loadItem(position);
    if (selectedPosition >= 0) {
      setStatus(`Imagem${state.items[position].index} carregada para reavaliação.`, "success");
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    setStatus(error.message, "error");
  }
});

elements.datasetPath.addEventListener("click", async () => {
  try {
    if (!state.rootHandle && state.savedRootHandle) {
      const permission = await state.savedRootHandle.requestPermission({ mode: "readwrite" });
      if (permission === "granted") {
        await activateDataset(state.savedRootHandle);
        return;
      }
    }
    await chooseAndActivateDataset();
  } catch (error) {
    if (error.name === "AbortError") return;
    setStatus(error.message, "error");
  }
});

elements.undo.addEventListener("click", async () => {
  if (!state.history.length) return;
  const previous = state.history.pop();
  state.restoring = true;
  try {
    if (previous.currentPosition < 0) {
      clearDisplayedState(false);
      setStatus("Estado anterior restaurado.", "success");
    } else {
      await loadItem(previous.currentPosition, previous);
      setStatus("Passo anterior restaurado.", "success");
    }
  } catch (error) {
    setStatus(`Não foi possível restaurar o passo: ${error.message}`, "error");
  } finally {
    state.restoring = false;
    updateControls();
  }
});

elements.reportText.addEventListener("focus", () => {
  state.reportBeforeEdit = elements.reportText.value;
});

elements.reportText.addEventListener("blur", () => {
  if (state.reportBeforeEdit !== null && state.reportBeforeEdit !== elements.reportText.value) {
    const current = elements.reportText.value;
    elements.reportText.value = state.reportBeforeEdit;
    pushHistory();
    elements.reportText.value = current;
  }
  state.reportBeforeEdit = null;
});

elements.report.addEventListener("click", async () => {
  if (state.currentPosition < 0 || !state.rootHandle) return;
  let reportFileSaved = false;
  let savedIndex = null;
  try {
    let permission = await state.rootHandle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") permission = await state.rootHandle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") throw new Error("A permissão de gravação não foi concedida.");
    const reportsDirectory = await state.rootHandle.getDirectoryHandle("Relatorios", { create: true });
    const index = state.items[state.currentPosition].index;
    const reportHandle = await reportsDirectory.getFileHandle(`Relatorio${index}.txt`, { create: true });
    const boundingBoxes = state.boxes
      .map((box, position) => `BB${position + 1}: <${box.x},${box.y},${box.width},${box.height}>`)
      .join("\n");
    const visibleReport = elements.reportText.value.trimEnd();
    const savedReport = boundingBoxes
      ? `${visibleReport}\n\nCoordenadas dos BBs:\n${boundingBoxes}`
      : visibleReport;
    const writable = await reportHandle.createWritable();
    await writable.write(savedReport);
    await writable.close();
    reportFileSaved = true;
    savedIndex = index;
    state.completedIndices.add(index);
    await writeCompletedIndices();
    updateControls();
    const savedLocation = `${state.rootHandle.name}/Relatorios/Relatorio${index}.txt`;
    setStatus(`Relatorio${index}.txt salvo e ${PROGRESS_FILE_NAME} atualizado.`, "success");
    await showMessage(
      "Relatório salvo",
      `Relatório salvo em ${savedLocation}\n\nProgresso atualizado em ${state.rootHandle.name}/${PROGRESS_FILE_NAME}`
    );
    const nextPosition = findNextPendingPosition(state.currentPosition);
    if (nextPosition >= 0) {
      try {
        pushHistory();
        await loadItem(nextPosition);
        setStatus(`Relatorio${index}.txt salvo e ${PROGRESS_FILE_NAME} atualizado. Imagem${state.items[nextPosition].index} carregada como próxima pendente.`, "success");
      } catch (nextError) {
        setStatus(`Relatorio${index}.txt salvo e ${PROGRESS_FILE_NAME} atualizado, mas a próxima imagem não pôde ser carregada: ${nextError.message}`, "error");
      }
    } else {
      await finishPendingQueue();
    }
  } catch (error) {
    if (reportFileSaved) {
      setStatus(`Relatorio${savedIndex}.txt foi salvo, mas ocorreu uma falha depois da gravação: ${error.message}`, "error");
    } else {
      setStatus(`Não foi possível salvar o relatório: ${error.message}`, "error");
    }
  }
});

function clearDisplayedState(clearFolder = true) {
  revokeUrls();
  state.currentPosition = -1;
  state.boxes = [];
  state.history = [];
  state.dragging = false;
  state.dragStart = null;
  state.draftBox = null;
  state.reportBeforeEdit = null;
  if (clearFolder) {
    state.rootHandle = null;
    state.items = [];
    state.completedIndices = new Set();
  }
  ctx.clearRect(0, 0, elements.xrayCanvas.width, elements.xrayCanvas.height);
  hemdCtx.clearRect(0, 0, elements.hemdCanvas.width, elements.hemdCanvas.height);
  elements.xrayCanvas.style.display = "none";
  elements.xrayPlaceholder.hidden = false;
  elements.hemdCanvas.style.display = "none";
  elements.hemdPlaceholder.hidden = false;
  elements.reportText.value = "";
  updateControls();
}

elements.reset.addEventListener("click", () => elements.dialog.showModal());
elements.dialog.addEventListener("close", () => {
  if (elements.dialog.returnValue !== "confirm") return;
  clearDisplayedState(false);
  setStatus("Sistema restaurado. A pasta local do dataset foi mantida.", "success");
});

window.addEventListener("beforeunload", revokeUrls);
updateControls();
restoreDatasetHandle();
