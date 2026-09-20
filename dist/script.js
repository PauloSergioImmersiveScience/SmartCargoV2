"use strict";

const elements = {
  upload: document.querySelector("#uploadButton"),
  undo: document.querySelector("#undoButton"),
  reset: document.querySelector("#resetButton"),
  report: document.querySelector("#reportButton"),
  reportText: document.querySelector("#reportText"),
  status: document.querySelector("#status"),
  currentItem: document.querySelector("#currentItem"),
  xrayCanvas: document.querySelector("#xrayCanvas"),
  xrayPlaceholder: document.querySelector("#xrayPlaceholder"),
  hemdCanvas: document.querySelector("#hemdCanvas"),
  hemdPlaceholder: document.querySelector("#hemdPlaceholder"),
  dialog: document.querySelector("#confirmDialog")
};

const ctx = elements.xrayCanvas.getContext("2d", { willReadFrequently: true });
const hemdCtx = elements.hemdCanvas.getContext("2d");
const originalCanvas = document.createElement("canvas");
const originalCtx = originalCanvas.getContext("2d", { willReadFrequently: true });
const hemdOriginalImage = new Image();

const state = {
  rootHandle: null,
  items: [],
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

function normalizedBox(start, end) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return { x, y, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

elements.xrayCanvas.addEventListener("pointerdown", event => {
  if (state.currentPosition < 0) return;
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
      if (!("showDirectoryPicker" in window)) {
        throw new Error("Este navegador não permite gravação direta em pastas. Abra o sistema no Chrome ou Edge atualizado.");
      }
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      const permission = await handle.requestPermission({ mode: "readwrite" });
      if (permission !== "granted") throw new Error("A permissão de leitura e gravação não foi concedida.");
      const items = await discoverItems(handle);
      if (!items.length) throw new Error("A pasta selecionada não contém diretórios Imagem<índice>.");
      state.rootHandle = handle;
      state.items = items;
      pushHistory();
      await loadItem(0);
      return;
    }
    const next = state.currentPosition + 1;
    if (next >= state.items.length) {
      setStatus("A última imagem do diretório já está carregada.");
      return;
    }
    pushHistory();
    await loadItem(next);
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
    const savedLocation = `${state.rootHandle.name}/Relatorios/Relatorio${index}.txt`;
    setStatus(`Relatorio${index}.txt salvo na pasta Relatorios.`, "success");
    window.alert(`Relatório Salvo em ${savedLocation}`);
  } catch (error) {
    setStatus(`Não foi possível salvar o relatório: ${error.message}`, "error");
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
  clearDisplayedState(true);
  setStatus("Sistema restaurado ao estado inicial.", "success");
});

window.addEventListener("beforeunload", revokeUrls);
updateControls();
