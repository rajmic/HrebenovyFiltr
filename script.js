// Hrebenovy filter - hlavny JavaScript subor.
// Tento subor riesi grafiku, ovladanie, vypocet oneskorenia, zvukovu cast a vykreslenie spektier.

// Fyzikalne a graficke konstanty simulacie.
const C = 343;
const PIXELS_PER_METER = 150;
const DEFAULT_FREQ = 440;

// Cesty k externym zvukovym vzorkam.
const SAMPLE_URLS = {
  guitar: './zvuky/guitar.wav',
  drums: './zvuky/drums.wav',
  violin: './zvuky/violin.wav'
};

// Zosilnenie externych zvukovych vzoriek.
const SAMPLE_GAINS = {
  guitar: 3,
  drums: 3,
  violin: 3
};

// Nastavenie rozsahov frekvencnych grafov.
const MAX_SPECTRUM_FREQ = 5000;
const SPECTRUM_MIN_DB = -100;
const SPECTRUM_MAX_DB = 0;

// Rozsah zobrazenia amplitudovej charakteristiky hrebenoveho filtra.
const COMB_MIN_DB = -40;
const COMB_MAX_DB = 12;

// Rozlozenie pravych panelov so spektrom a charakteristikou filtra.
const RIGHT_PANEL_TOP = 120;
const RIGHT_PANEL_BOTTOM_MARGIN = 95;
const RIGHT_PANEL_GAP = 28;

// Odsadenie textoveho vypisu vzdialenosti a oneskorenia.
const INFO_MARGIN = 24;

// Parametre menene pouzivatelom cez ovladaci panel.
const params = {
  gain1: 0,
  gain2: 0,
  signalType: 'sine',
  frequency: DEFAULT_FREQ
};

// Premenne pre graficke rozlozenie sceny.
let dividerX = 0;

let sourcePos;
let mic1Pos;
let mic2Pos;
let mic1Default;
let mic2Default;

// Cislo mikrofonu, ktory je prave tahany mysou. Hodnota 0 znamena, ze sa nic netaha.
let draggedMic = 0;

// Vzdialenosti mikrofonov od zdroja a vypocitane oneskorenie.
let d1 = 0;
let d2 = 0;
let tau = 0;

let pane = null;

// Premenne pre zvukove spracovanie pomocou Web Audio API.
let audioCtx = null;
let sourceNode = null;

let noiseBuffer = null;
let sampleBuffers = {};

let sourceOutputGain = null;
let dryGain = null;
let wetGain = null;
let delayNode = null;
let masterGain = null;

// Analyzator a pole dat pre spektrum vysledneho signalu.
let analyserResult = null;
let spectrumDataResult = null;

// Stav prehravania.
let isPlaying = false;

// Inicializacia p5.js sceny po nacitani stranky.
function setup() {
  const app = document.getElementById('app');
  const canvas = createCanvas(app.clientWidth, app.clientHeight);
  canvas.parent('app');

  textFont('Arial');

  initLayout();
  makeUI();
  setupButtons();
  updateGeometry();
}

// Hlavna vykreslovacia slucka, ktoru opakovane vola kniznica p5.js.
function draw() {
  background(0);

  updateGeometry();
  updateAudioParameters();

  drawDivider();
  drawGuideLine(sourcePos, mic1Pos);
  drawGuideLine(sourcePos, mic2Pos);

  drawSource(sourcePos.x, sourcePos.y);
  drawMicrophone(mic1Pos.x, mic1Pos.y, 1, draggedMic === 1);
  drawMicrophone(mic2Pos.x, mic2Pos.y, 2, draggedMic === 2);

  drawInfo();
  drawSpectrumPanel();
  drawCombFilterPanel();
}

// Nastavenie pociatocnych poloh zdroja a mikrofonov.
function initLayout() {
  dividerX = width * 2 / 3;

  sourcePos = createVector(dividerX * 0.34, height * 0.52);

  mic1Default = createVector(dividerX * 0.58, height * 0.38);
  mic2Default = createVector(dividerX * 0.66, height * 0.62);

  mic1Pos = mic1Default.copy();
  mic2Pos = mic2Default.copy();
}

// Vytvorenie ovladacieho panelu s nastavenim zosilnenia oboch vetiev.
function makeUI() {
  pane = new Tweakpane.Pane({
    container: document.getElementById('pane')
  });

  pane.addInput(params, 'gain1', {
    label: 'GAIN 1 [dB]',
    min: -24,
    max: 12,
    step: 0.1
  });

  pane.addInput(params, 'gain2', {
    label: 'GAIN 2 [dB]',
    min: -24,
    max: 12,
    step: 0.1
  });
}

// Pripojenie tlacidiel a vyberu signalu k prislusnym funkciam.
function setupButtons() {
  document.getElementById('playBtn').onclick = togglePlay;
  document.getElementById('resetBtn').onclick = resetSimulation;

  const signalSelect = document.getElementById('signalSelect');
  signalSelect.value = 'sine_440';

  signalSelect.onchange = async (e) => {
    setSignalFromSelectValue(e.target.value);
    await switchSignalType();
  };
}

// Prevod hodnoty zo selectu na typ signalu a frekvenciu.
function setSignalFromSelectValue(value) {
  if (value === 'noise') {
    params.signalType = 'noise';
    params.frequency = DEFAULT_FREQ;
    return;
  }

  if (SAMPLE_URLS[value]) {
    params.signalType = value;
    params.frequency = DEFAULT_FREQ;
    return;
  }

  const parts = value.split('_');
  params.signalType = parts[0];
  params.frequency = Number(parts[1]);
}

// Vypocet polohy a velkosti pravych panelov so spektrom a charakteristikou filtra.
function getRightPanelsLayout() {
  const panelX = dividerX + 22;
  const panelW = width - dividerX - 44;
  const availableH = height - RIGHT_PANEL_TOP - RIGHT_PANEL_BOTTOM_MARGIN;
  const panelH = Math.max(120, (availableH - RIGHT_PANEL_GAP) / 2);

  return {
    panelX,
    panelY: RIGHT_PANEL_TOP,
    panelW,
    panelH,
    gap: RIGHT_PANEL_GAP
  };
}

// Vypocet vzdialenosti mikrofonov od zdroja a casoveho oneskorenia tau.
function updateGeometry() {
  d1 = dist(sourcePos.x, sourcePos.y, mic1Pos.x, mic1Pos.y) / PIXELS_PER_METER;
  d2 = dist(sourcePos.x, sourcePos.y, mic2Pos.x, mic2Pos.y) / PIXELS_PER_METER;
  tau = (d2 - d1) / C;
}

// Prevod zosilnenia z decibelov na linearnu hodnotu.
function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

// Inicializacia zvukoveho retazca Web Audio API.
async function initAudio() {
  if (audioCtx) return;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContextClass();

  sourceOutputGain = audioCtx.createGain();
  dryGain = audioCtx.createGain();
  wetGain = audioCtx.createGain();
  delayNode = audioCtx.createDelay(1.0);
  masterGain = audioCtx.createGain();

  // Analyzator meria spektrum vysledneho signalu za hrebenovym filtrom.
  analyserResult = audioCtx.createAnalyser();
  analyserResult.fftSize = 2048;
  analyserResult.smoothingTimeConstant = 0.8;
  analyserResult.minDecibels = SPECTRUM_MIN_DB;
  analyserResult.maxDecibels = SPECTRUM_MAX_DB;
  spectrumDataResult = new Float32Array(analyserResult.frequencyBinCount);

  sourceOutputGain.gain.value = 1;
  dryGain.gain.value = 0;
  wetGain.gain.value = 0;
  delayNode.delayTime.value = 0;
  masterGain.gain.value = 0;

  // Zdroj signalu sa rozdeluje na priamu a oneskorenu vetvu.
  sourceOutputGain.connect(dryGain);
  sourceOutputGain.connect(delayNode);

  delayNode.connect(wetGain);

  // Obe vetvy sa znovu scitaju do vystupneho signalu.
  dryGain.connect(masterGain);
  wetGain.connect(masterGain);

  masterGain.connect(analyserResult);
  masterGain.connect(audioCtx.destination);

  await createAndStartSource();
  updateAudioParameters();
}

// Vytvorenie buffera s bielym sumom.
function createNoiseBuffer() {
  const durationSeconds = 2;
  const bufferSize = Math.floor(audioCtx.sampleRate * durationSeconds);
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  return buffer;
}

// Nacitanie a dekodovanie externej zvukovej vzorky.
async function loadSampleBuffer(sampleName) {
  if (sampleBuffers[sampleName]) {
    return sampleBuffers[sampleName];
  }

  const response = await fetch(SAMPLE_URLS[sampleName]);

  if (!response.ok) {
    throw new Error('Nepodarilo sa načítať súbor ' + SAMPLE_URLS[sampleName]);
  }

  const arrayBuffer = await response.arrayBuffer();
  const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  sampleBuffers[sampleName] = decodedBuffer;
  return decodedBuffer;
}

// Zastavenie aktualneho zdroja zvuku pred vytvorenim noveho.
function stopAndDisconnectSource() {
  if (!sourceNode) return;

  try {
    sourceNode.stop();
  } catch (e) {}

  try {
    sourceNode.disconnect();
  } catch (e) {}

  sourceNode = null;
}

// Vytvorenie zdroja zvuku podla aktualne zvoleneho signalu.
async function createAndStartSource() {
  if (!audioCtx) return;

  stopAndDisconnectSource();

  if (params.signalType === 'noise') {
    if (!noiseBuffer) {
      noiseBuffer = createNoiseBuffer();
    }

    // Pri sume sa pouziva cyklicky prehravany buffer s nahodnymi vzorkami.
    const noiseSource = audioCtx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;

    sourceOutputGain.gain.value = 0.7;
    sourceNode = noiseSource;
  } else if (SAMPLE_URLS[params.signalType]) {
    try {
      // Externe zvuky sa nacitaju zo suborov v priecinku zvuky.
      const buffer = await loadSampleBuffer(params.signalType);

      const sampleSource = audioCtx.createBufferSource();
      sampleSource.buffer = buffer;
      sampleSource.loop = true;

      sourceOutputGain.gain.value = SAMPLE_GAINS[params.signalType];
      sourceNode = sampleSource;
    } catch (error) {
      console.error(error);

      // Ak sa vzorka nepodari nacitat, pouzije sa nahradny sinusovy signal.
      const fallbackOsc = audioCtx.createOscillator();
      fallbackOsc.type = 'sine';
      fallbackOsc.frequency.value = DEFAULT_FREQ;

      sourceOutputGain.gain.value = 0.5;
      sourceNode = fallbackOsc;
    }
  } else {
    // Oscilator sa pouziva pre sinus a obdlznik.
    const osc = audioCtx.createOscillator();
    osc.type = params.signalType === 'square' ? 'square' : 'sine';
    osc.frequency.value = params.frequency;

    sourceOutputGain.gain.value = 0.35;
    sourceNode = osc;
  }

  sourceNode.connect(sourceOutputGain);
  sourceNode.start();
}

// Prepnutie typu signalu pocas behu appletu.
async function switchSignalType() {
  if (!audioCtx) return;
  await createAndStartSource();
}

// Aktualizacia oneskorenia a zosilneni oboch vetiev hrebenoveho filtra.
function updateAudioParameters() {
  if (!audioCtx) return;

  const now = audioCtx.currentTime;
  const smooth = 0.02;
  const g1 = dbToLinear(params.gain1);
  const g2 = dbToLinear(params.gain2);
  const absTau = Math.abs(tau);

  let targetDry = g1;
  let targetWet = g2;

  // Ak je tau zaporne, oneskoruje sa opacna vetva, preto sa zosilnenia prehodia.
  if (tau < 0) {
    targetDry = g2;
    targetWet = g1;
  }

  dryGain.gain.cancelScheduledValues(now);
  wetGain.gain.cancelScheduledValues(now);
  delayNode.delayTime.cancelScheduledValues(now);
  masterGain.gain.cancelScheduledValues(now);

  dryGain.gain.setTargetAtTime(targetDry, now, smooth);
  wetGain.gain.setTargetAtTime(targetWet, now, smooth);
  delayNode.delayTime.setTargetAtTime(absTau, now, smooth);
  masterGain.gain.setTargetAtTime(isPlaying ? 0.08 : 0.0, now, 0.01);
}

// Spustenie alebo zastavenie prehravania.
async function togglePlay() {
  await initAudio();

  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  isPlaying = !isPlaying;
  document.getElementById('playBtn').textContent = isPlaying ? 'STOP' : 'PLAY';
  updateAudioParameters();
}

// Vratenie mikrofonov, zosilnenia a prehravania do pociatocneho stavu.
function resetSimulation() {
  mic1Pos = mic1Default.copy();
  mic2Pos = mic2Default.copy();

  params.gain1 = 0;
  params.gain2 = 0;
  if (pane) pane.refresh();

  updateGeometry();

  isPlaying = false;
  document.getElementById('playBtn').textContent = 'PLAY';
  updateAudioParameters();
}

// Vykreslenie deliacej ciary medzi scenou a grafmi.
function drawDivider() {
  stroke(255);
  strokeWeight(2);
  line(dividerX, 0, dividerX, height);
}

// Pomocna ciara znazornujuca vzdialenost mikrofonu od zdroja.
function drawGuideLine(a, b) {
  push();
  stroke(180);
  strokeWeight(0.6);
  drawingContext.setLineDash([4, 6]);
  line(a.x, a.y, b.x, b.y);
  drawingContext.setLineDash([]);
  pop();
}

// Vykreslenie zvukoveho zdroja.
function drawSource(x, y) {
  push();
  stroke(255);
  strokeWeight(2);
  noFill();
  rectMode(CENTER);
  rect(x, y, 34, 34);

  noStroke();
  fill(255);
  textAlign(CENTER, TOP);
  textSize(15);
  text('ZDROJ', x, y + 26);
  pop();
}

// Vykreslenie mikrofonu a jeho cisla.
function drawMicrophone(x, y, number, active) {
  push();
  stroke(255);
  strokeWeight(active ? 3 : 2);
  noFill();
  rectMode(CENTER);

  rect(x, y - 8, 16, 22, 6);
  line(x, y + 3, x, y + 24);
  line(x - 11, y + 29, x + 11, y + 29);

  noStroke();
  fill(255);
  textAlign(LEFT, CENTER);
  textSize(18);
  text(number, x + 16, y - 10);
  pop();
}

// Vypis vzdialenosti mikrofonov od zdroja a casoveho oneskorenia.
function drawInfo() {
  push();

  const x = INFO_MARGIN;
  const fontSize = 22;
  const lineStep = 34;
  const separatorOffset = 72;
  const tauOffset = 86;
  const blockH = tauOffset + fontSize;
  const y = height - INFO_MARGIN - blockH;

  const d1Text = 'd1 = ' + d1.toFixed(2) + ' m';
  const d2Text = 'd2 = ' + d2.toFixed(2) + ' m';
  const tauText = 'τ = ' + (tau * 1000).toFixed(2) + ' ms';

  textSize(fontSize);
  textAlign(LEFT, TOP);

  const textW = Math.max(
    textWidth(d1Text),
    textWidth(d2Text),
    textWidth(tauText)
  );

  noStroke();
  fill(255);

  text(d1Text, x, y);
  text(d2Text, x, y + lineStep);

  stroke(255);
  strokeWeight(1);
  line(x, y + separatorOffset, x + textW, y + separatorOffset);

  noStroke();
  fill(255);
  text(tauText, x, y + tauOffset);

  pop();
}

// Vykreslenie frekvencneho spektra vysledneho signalu.
function drawSpectrumPanel() {
  const layout = getRightPanelsLayout();

  const panelX = layout.panelX;
  const panelY = layout.panelY;
  const panelW = layout.panelW;
  const panelH = layout.panelH;

  push();

  noFill();
  stroke(255);
  strokeWeight(1);
  rect(panelX, panelY, panelW, panelH);

  // Mriezka grafu.
  stroke(70);
  strokeWeight(1);
  for (let i = 1; i < 4; i++) {
    const y = panelY + (panelH * i) / 4;
    line(panelX, y, panelX + panelW, y);
  }

  const freqMarks = [0, 1000, 2000, 3000, 4000, 5000];
  for (const freq of freqMarks) {
    const x = map(freq, 0, MAX_SPECTRUM_FREQ, panelX, panelX + panelW);
    line(x, panelY, x, panelY + panelH);
  }

  noStroke();
  fill(180);
  textSize(11);

  textAlign(LEFT, TOP);
  text('0 Hz', panelX, panelY + panelH + 6);

  textAlign(CENTER, TOP);
  text('1 kHz', map(1000, 0, MAX_SPECTRUM_FREQ, panelX, panelX + panelW), panelY + panelH + 6);
  text('2 kHz', map(2000, 0, MAX_SPECTRUM_FREQ, panelX, panelX + panelW), panelY + panelH + 6);
  text('3 kHz', map(3000, 0, MAX_SPECTRUM_FREQ, panelX, panelX + panelW), panelY + panelH + 6);
  text('4 kHz', map(4000, 0, MAX_SPECTRUM_FREQ, panelX, panelX + panelW), panelY + panelH + 6);

  textAlign(RIGHT, TOP);
  text('5 kHz', panelX + panelW, panelY + panelH + 6);

  fill(180);
  textAlign(LEFT, CENTER);
  text('0 dB', panelX + 6, panelY + 10);
  text('-50 dB', panelX + 6, panelY + panelH * 0.5);
  text('-100 dB', panelX + 6, panelY + panelH - 10);

  if (analyserResult && spectrumDataResult) {
    analyserResult.getFloatFrequencyData(spectrumDataResult);

    const nyquist = audioCtx.sampleRate / 2;
    const maxBin = Math.min(
      spectrumDataResult.length - 1,
      Math.floor((MAX_SPECTRUM_FREQ / nyquist) * spectrumDataResult.length)
    );

    noFill();
    stroke(255);
    strokeWeight(1.4);
    beginShape();

    // Prevod frekvencnych kosov analyzatora na suradnice v grafe.
    for (let i = 0; i <= maxBin; i++) {
      const freq = (i / (spectrumDataResult.length - 1)) * nyquist;
      const db = constrain(spectrumDataResult[i], SPECTRUM_MIN_DB, SPECTRUM_MAX_DB);

      const x = map(freq, 0, MAX_SPECTRUM_FREQ, panelX, panelX + panelW);
      const y = map(db, SPECTRUM_MAX_DB, SPECTRUM_MIN_DB, panelY, panelY + panelH);

      vertex(x, y);
    }

    endShape();
  }

  pop();
}

// Vykreslenie teoretickej amplitudovej charakteristiky hrebenoveho filtra.
function drawCombFilterPanel() {
  const layout = getRightPanelsLayout();

  const panelX = layout.panelX;
  const panelY = layout.panelY + layout.panelH + layout.gap;
  const panelW = layout.panelW;
  const panelH = layout.panelH;

  const g1 = dbToLinear(params.gain1);
  const g2 = dbToLinear(params.gain2);
  const absTau = Math.abs(tau);
  const eps = 1e-6;

  push();

  noFill();
  stroke(255);
  strokeWeight(1);
  rect(panelX, panelY, panelW, panelH);

  // Mriezka grafu.
  stroke(70);
  strokeWeight(1);
  for (let i = 1; i < 4; i++) {
    const y = panelY + (panelH * i) / 4;
    line(panelX, y, panelX + panelW, y);
  }

  const freqMarks = [0, 1000, 2000, 3000, 4000, 5000];
  for (const freq of freqMarks) {
    const x = map(freq, 0, MAX_SPECTRUM_FREQ, panelX, panelX + panelW);
    line(x, panelY, x, panelY + panelH);
  }

  noStroke();
  fill(180);
  textSize(11);

  textAlign(LEFT, TOP);
  text('0 Hz', panelX, panelY + panelH + 6);

  textAlign(CENTER, TOP);
  text('1 kHz', map(1000, 0, MAX_SPECTRUM_FREQ, panelX, panelX + panelW), panelY + panelH + 6);
  text('2 kHz', map(2000, 0, MAX_SPECTRUM_FREQ, panelX, panelX + panelW), panelY + panelH + 6);
  text('3 kHz', map(3000, 0, MAX_SPECTRUM_FREQ, panelX, panelX + panelW), panelY + panelH + 6);
  text('4 kHz', map(4000, 0, MAX_SPECTRUM_FREQ, panelX, panelX + panelW), panelY + panelH + 6);

  textAlign(RIGHT, TOP);
  text('5 kHz', panelX + panelW, panelY + panelH + 6);

  fill(180);
  textAlign(LEFT, CENTER);
  text('+12 dB', panelX + 6, panelY + 10);
  text('-14 dB', panelX + 6, panelY + panelH * 0.5);
  text('-40 dB', panelX + 6, panelY + panelH - 10);

  noFill();
  stroke(255);
  strokeWeight(1.4);
  beginShape();

  const points = 320;
  for (let i = 0; i <= points; i++) {
    const freq = (i / points) * MAX_SPECTRUM_FREQ;

    // Vypocet velkosti prenosovej funkcie dvoch scitanych vetiev.
    const mag = Math.sqrt(
      g1 * g1 +
      g2 * g2 +
      2 * g1 * g2 * Math.cos(2 * Math.PI * freq * absTau)
    );

    const db = constrain(
      20 * Math.log10(Math.max(mag, eps)),
      COMB_MIN_DB,
      COMB_MAX_DB
    );

    const x = map(freq, 0, MAX_SPECTRUM_FREQ, panelX, panelX + panelW);
    const y = map(db, COMB_MAX_DB, COMB_MIN_DB, panelY, panelY + panelH);

    vertex(x, y);
  }

  endShape();

  pop();
}

// Zaciatok tahania mikrofonu mysou.
function mousePressed() {
  if (isOverMic(mouseX, mouseY, mic1Pos)) {
    draggedMic = 1;
  } else if (isOverMic(mouseX, mouseY, mic2Pos)) {
    draggedMic = 2;
  }
}

// Presuvanie zvoleneho mikrofonu mysou v lavej casti sceny.
function mouseDragged() {
  if (draggedMic === 0) return;

  const x = constrain(mouseX, 20, dividerX - 20);
  const y = constrain(mouseY, 20, height - 20);

  if (draggedMic === 1) {
    mic1Pos.set(x, y);
  } else if (draggedMic === 2) {
    mic2Pos.set(x, y);
  }
}

// Ukoncenie tahania mikrofonu.
function mouseReleased() {
  draggedMic = 0;
}

// Kontrola, ci kurzor lezi nad niektorym mikrofonom.
function isOverMic(mx, my, micPos) {
  return dist(mx, my, micPos.x, micPos.y - 4) < 22;
}

// Prisposobenie platna pri zmene velkosti okna.
function windowResized() {
  const app = document.getElementById('app');
  resizeCanvas(app.clientWidth, app.clientHeight);
  initLayout();
  updateGeometry();
  updateAudioParameters();
}
