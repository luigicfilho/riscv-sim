import init, { WasmSimulator } from './pkg/riscv_sim.js';

// Preset sample programs
const PRESETS = {
  'test.s': {
    format: 's',
    base: '0x80000000',
    code: `.global _start

_start:
    li   x1, 10
    li   x2, 20
    add  x3, x1, x2
    mul  x4, x1, x2
    li   a0, 65
    li   a7, 11
    ecall          # print_char 'A'
    li   a7, 93
    ecall          # exit
`
  },
  '2tests.s': {
    format: 's',
    base: '0x80000000',
    code: `# 04_loads_stores.s — lb/lbu/lh/lhu/lw + sb/sh/sw, sign extension, LE layout.

    li   s0, 0x200            # scratch area

    # store word 0x80FF7F01 (bytes: 01 7F FF 80)
    li   t0, 0x80FF7F01
    sw   t0, 0(s0)

    # 1: lb sign-extends byte 0 (0x01 -> 1)
    lb   t1, 0(s0)
    li   t2, 1
    bne  t1, t2, fail1

    # 2: lb sign-extends byte 3 (0x80 -> -128)
    lb   t1, 3(s0)
    li   t2, -128
    bne  t1, t2, fail2

    # 3: lbu does not sign-extend
    lbu  t1, 3(s0)
    li   t2, 0x80
    bne  t1, t2, fail3

    # 4: lh sign-extends half 2 (0x80FF -> -32513)
    lh   t1, 2(s0)
    li   t2, 0xFFFF80FF
    bne  t1, t2, fail4

    # 5: lhu does not sign-extend
    lhu  t1, 2(s0)
    li   t2, 0x80FF
    bne  t1, t2, fail5

    # 6: sb writes only one byte
    li   t0, 0x12
    sb   t0, 4(s0)
    lw   t1, 4(s0)
    li   t2, 0x12
    bne  t1, t2, fail6

    # 7: sh writes two bytes
    li   t0, 0xBEEF
    sh   t0, 8(s0)
    lw   t1, 8(s0)
    li   t2, 0xBEEF
    bne  t1, t2, fail7

    # 8: read back the full word
    lw   t1, 0(s0)
    li   t2, 0x80FF7F01
    bne  t1, t2, fail8

    li   a0, 0
    j    exit
fail1: li a0, 1
    j    exit
fail2: li a0, 2
    j    exit
fail3: li a0, 3
    j    exit
fail4: li a0, 4
    j    exit
fail5: li a0, 5
    j    exit
fail6: li a0, 6
    j    exit
fail7: li a0, 7
    j    exit
fail8: li a0, 8
    j    exit
exit:
    li   a7, 93
    ecall
`
  },
  'test.hex': {
    format: 'hex',
    base: '0x80000000',
    code: `# Exemplo HEX - carrega em 0x80000000
@80000000
93 00 00 05    # addi x1, x0, 5
13 01 10 00    # addi x2, x0, 1
B3 81 20 00    # add x3, x1, x2
73 00 00 00    # ecall
`
  }
};

const ABI_NAMES = [
  "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2",
  "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5",
  "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7",
  "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6"
];

// App State
let sim = null;
let currentCode = '';
let currentFormat = 's';
let activeLine = 1;
let prevRegs = new Array(32).fill(0);
let changedRegs = new Set();
let isRunning = false;
let runTimer = null;
let regDisplayFormat = 'hex'; // 'hex' or 'dec'
let currentMemAddr = 0x80000000;
let lastMemAccess = null;

// DOM Elements
const statusPill = document.getElementById('statusPill');
const presetSelect = document.getElementById('presetSelect');
const baseAddrInput = document.getElementById('baseAddrInput');
const stepBtn = document.getElementById('stepBtn');
const runBtn = document.getElementById('runBtn');
const runBtnText = document.getElementById('runBtnText');
const resetBtn = document.getElementById('resetBtn');
const speedSlider = document.getElementById('speedSlider');
const speedLabel = document.getElementById('speedLabel');
const codeContainer = document.getElementById('codeContainer');
const followPcCheckbox = document.getElementById('followPcCheckbox');
const editCodeBtn = document.getElementById('editCodeBtn');
const regFormatBtn = document.getElementById('regFormatBtn');
const pcVal = document.getElementById('pcVal');
const stepsVal = document.getElementById('stepsVal');
const cyclesVal = document.getElementById('cyclesVal');
const regsGrid = document.getElementById('regsGrid');
const memAddrInput = document.getElementById('memAddrInput');
const memGoBtn = document.getElementById('memGoBtn');
const memPcBtn = document.getElementById('memPcBtn');
const memSpBtn = document.getElementById('memSpBtn');
const memBanner = document.getElementById('memBanner');
const memAccessDesc = document.getElementById('memAccessDesc');
const hexTableBody = document.getElementById('hexTableBody');
const consoleOutput = document.getElementById('consoleOutput');
const clearConsoleBtn = document.getElementById('clearConsoleBtn');

// Modal Elements
const codeModal = document.getElementById('codeModal');
const modalFormatSelect = document.getElementById('modalFormatSelect');
const modalTextarea = document.getElementById('modalTextarea');
const fileInput = document.getElementById('fileInput');
const applyModalBtn = document.getElementById('applyModalBtn');
const cancelModalBtn = document.getElementById('cancelModalBtn');
const closeModalBtn = document.getElementById('closeModalBtn');

function setStatus(text, type) {
  statusPill.textContent = text;
  statusPill.className = `status-pill status-${type}`;
}

function parseAddr(str) {
  if (typeof str === 'number') return str >>> 0;
  str = str.trim();
  if (str.startsWith('0x') || str.startsWith('0X')) {
    return parseInt(str.slice(2), 16) >>> 0;
  }
  return parseInt(str, 10) >>> 0;
}

function toHex(val, padding = 8) {
  return '0x' + (val >>> 0).toString(16).toUpperCase().padStart(padding, '0');
}

// Initialize Registers DOM
function initRegsGrid() {
  regsGrid.innerHTML = '';
  for (let i = 0; i < 32; i++) {
    const item = document.createElement('div');
    item.className = 'reg-item';
    item.id = `reg-${i}`;

    const name = document.createElement('span');
    name.className = 'reg-name';
    name.textContent = `x${i} (${ABI_NAMES[i]})`;

    const val = document.createElement('span');
    val.className = 'reg-val';
    val.id = `reg-val-${i}`;
    val.textContent = '0x00000000';

    item.appendChild(name);
    item.appendChild(val);
    regsGrid.appendChild(item);
  }
}

// Render Registers
function renderRegisters(regs, changedList = []) {
  changedRegs = new Set(changedList);
  for (let i = 0; i < 32; i++) {
    const item = document.getElementById(`reg-${i}`);
    const valEl = document.getElementById(`reg-val-${i}`);
    const val = regs[i] >>> 0;

    if (regDisplayFormat === 'hex') {
      valEl.textContent = toHex(val, 8);
    } else {
      valEl.textContent = (val | 0).toString();
    }

    if (changedRegs.has(i)) {
      item.classList.add('changed');
    } else {
      item.classList.remove('changed');
    }
  }
}

// Render Code with Line Highlighting
function renderCode(codeText, currentExecutingLine) {
  codeContainer.innerHTML = '';
  const lines = codeText.split('\n');
  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const row = document.createElement('div');
    row.className = 'code-line';
    row.id = `code-line-${lineNum}`;

    if (lineNum === currentExecutingLine) {
      row.classList.add('active-line');
    }

    const numEl = document.createElement('div');
    numEl.className = 'code-line-num';
    numEl.textContent = lineNum;

    const contentEl = document.createElement('div');
    contentEl.className = 'code-line-content';
    contentEl.textContent = line;

    row.appendChild(numEl);
    row.appendChild(contentEl);
    codeContainer.appendChild(row);
  });

  if (followPcCheckbox.checked && currentExecutingLine) {
    const activeEl = document.getElementById(`code-line-${currentExecutingLine}`);
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

function updateActiveLine(newActiveLine) {
  if (activeLine === newActiveLine) return;
  const oldEl = document.getElementById(`code-line-${activeLine}`);
  if (oldEl) oldEl.classList.remove('active-line');

  activeLine = newActiveLine;
  const newEl = document.getElementById(`code-line-${activeLine}`);
  if (newEl) {
    newEl.classList.add('active-line');
    if (followPcCheckbox.checked) {
      newEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

// Render Memory Hex Table
function renderMemory(baseAddr) {
  if (!sim) return;
  currentMemAddr = baseAddr >>> 0;
  memAddrInput.value = toHex(currentMemAddr, 8);

  const length = 256; // 16 rows of 16 bytes
  try {
    const jsonStr = sim.get_memory(currentMemAddr, length);
    const bytes = JSON.parse(jsonStr);

    hexTableBody.innerHTML = '';
    for (let r = 0; r < 16; r++) {
      const row = document.createElement('tr');
      const rowAddr = (currentMemAddr + r * 16) >>> 0;

      const addrTd = document.createElement('td');
      addrTd.className = 'hex-addr';
      addrTd.textContent = toHex(rowAddr, 8);
      row.appendChild(addrTd);

      let asciiStr = '';
      for (let c = 0; c < 16; c++) {
        const byteInfo = bytes[r * 16 + c];
        const byteTd = document.createElement('td');
        byteTd.className = 'hex-byte';
        byteTd.textContent = byteInfo.val.toString(16).toUpperCase().padStart(2, '0');

        if (byteInfo.is_written) {
          byteTd.classList.add('written');
          byteTd.title = `Modified at ${toHex(byteInfo.addr, 8)}`;
        }

        if (lastMemAccess && byteInfo.addr >= lastMemAccess.addr && byteInfo.addr < (lastMemAccess.addr + lastMemAccess.size)) {
          byteTd.classList.add('recent-access');
        }

        row.appendChild(byteTd);

        // ASCII char
        const charCode = byteInfo.val;
        asciiStr += (charCode >= 32 && charCode <= 126) ? String.fromCharCode(charCode) : '.';
      }

      const asciiTd = document.createElement('td');
      asciiTd.className = 'hex-ascii';
      asciiTd.textContent = asciiStr;
      row.appendChild(asciiTd);

      hexTableBody.appendChild(row);
    }
  } catch (err) {
    console.error('Failed to render memory:', err);
  }
}

// Load Program into Simulator
function loadProgram(code, format, baseStr) {
  pause();
  const base = parseAddr(baseStr || baseAddrInput.value);
  const memSize = 128 * 1024 * 1024; // 128 MB

  try {
    sim = new WasmSimulator(base, memSize);
    sim.load_program(code, format);
    currentCode = code;
    currentFormat = format;

    // Reset UI state
    prevRegs = new Array(32).fill(0);
    activeLine = 1;
    lastMemAccess = null;
    memAccessDesc.textContent = 'None';
    memAccessDesc.className = '';

    pcVal.textContent = toHex(sim.get_pc(), 8);
    stepsVal.textContent = '0';
    cyclesVal.textContent = '0';

    // Special auto-view for scratch memory (e.g. 0x200 in 2tests.s)
    if (code.includes('0x200') && base === 0x80000000) {
      currentMemAddr = 0x200;
    } else {
      currentMemAddr = base;
    }

    renderCode(currentCode, activeLine);
    renderRegisters(prevRegs, []);
    renderMemory(currentMemAddr);
    setStatus('Ready', 'ready');
    appendConsole(`[System] Loaded ${format.toUpperCase()} program at ${toHex(base, 8)}\n`);
  } catch (err) {
    setStatus('Error', 'exception');
    appendConsole(`[Error] Failed to load program: ${err}\n`);
    console.error(err);
  }
}

function appendConsole(text) {
  if (!text) return;
  consoleOutput.textContent += text;
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

// Step Execution
function step() {
  if (!sim) return;
  try {
    const reportJson = sim.step();
    const report = JSON.parse(reportJson);

    pcVal.textContent = toHex(report.pc_after, 8);
    stepsVal.textContent = report.step;
    cyclesVal.textContent = report.csr_mcycle;

    // Line highlight
    if (report.current_line) {
      updateActiveLine(report.current_line);
    }

    // Register update & changed highlight
    renderRegisters(report.regs, report.changed_regs);
    prevRegs = report.regs;

    // Memory access update
    if (report.mem_access) {
      lastMemAccess = report.mem_access;
      const type = lastMemAccess.is_write ? 'WRITE' : 'READ';
      const badgeClass = lastMemAccess.is_write ? 'write' : 'read';
      memAccessDesc.innerHTML = `<span class="mem-badge ${badgeClass}">${type}</span> ${lastMemAccess.size}B @ ${toHex(lastMemAccess.addr, 8)} = ${toHex(lastMemAccess.value, lastMemAccess.size * 2)}`;

      // Auto scroll memory to accessed address if not in view
      if (lastMemAccess.addr < currentMemAddr || lastMemAccess.addr >= (currentMemAddr + 256)) {
        currentMemAddr = (lastMemAccess.addr & ~0xF) >>> 0;
      }
    }

    renderMemory(currentMemAddr);

    if (report.console_output) {
      appendConsole(report.console_output);
    }

    if (report.exception) {
      pause();
      setStatus(`Exception: ${report.exception}`, 'exception');
      appendConsole(`\n[Exception] ${report.exception}\n`);
    } else if (report.halted) {
      pause();
      setStatus('Halted', 'halted');
      appendConsole(`\n[Execution] Program halted normally after ${report.step} steps.\n`);
    } else {
      if (!isRunning) setStatus('Paused', 'paused');
    }
  } catch (err) {
    pause();
    setStatus('Error', 'exception');
    appendConsole(`[Error] ${err}\n`);
  }
}

// Run / Pause Loop
function run() {
  if (!sim || isRunning) return;
  if (sim.is_halted()) {
    reset();
  }
  isRunning = true;
  setStatus('Running', 'running');
  runBtnText.textContent = 'Pause';
  runBtn.className = 'btn btn-danger';

  const speedVal = parseInt(speedSlider.value, 10);

  if (speedVal < 50) {
    // Step-by-step timer
    const intervalMs = Math.max(10, Math.floor(1000 / speedVal));
    runTimer = setInterval(() => {
      if (!isRunning || sim.is_halted()) {
        pause();
      } else {
        step();
      }
    }, intervalMs);
  } else {
    // High-speed batch loop with requestAnimationFrame
    const batchSize = speedVal >= 90 ? 5000 : 250;
    const runFrame = () => {
      if (!isRunning || sim.is_halted()) {
        pause();
        return;
      }
      try {
        const batchReportJson = sim.run_batch(batchSize);
        const report = JSON.parse(batchReportJson);

        pcVal.textContent = toHex(report.pc, 8);
        stepsVal.textContent = report.total_steps;
        cyclesVal.textContent = report.csr_mcycle;

        if (report.current_line) {
          updateActiveLine(report.current_line);
        }

        renderRegisters(report.regs, []);
        renderMemory(currentMemAddr);

        if (report.console_output) {
          appendConsole(report.console_output);
        }

        if (report.exception) {
          pause();
          setStatus(`Exception: ${report.exception}`, 'exception');
          appendConsole(`\n[Exception] ${report.exception}\n`);
        } else if (report.halted) {
          pause();
          setStatus('Halted', 'halted');
          appendConsole(`\n[Execution] Program halted normally after ${report.total_steps} steps.\n`);
        } else {
          requestAnimationFrame(runFrame);
        }
      } catch (err) {
        pause();
        setStatus('Error', 'exception');
        appendConsole(`[Error] ${err}\n`);
      }
    };
    requestAnimationFrame(runFrame);
  }
}

function pause() {
  isRunning = false;
  if (runTimer) {
    clearInterval(runTimer);
    runTimer = null;
  }
  runBtnText.textContent = 'Run';
  runBtn.className = 'btn btn-success';
  if (sim && !sim.is_halted()) {
    setStatus('Paused', 'paused');
  }
}

function reset() {
  pause();
  if (!sim) return;
  try {
    sim.reset();
    activeLine = 1;
    lastMemAccess = null;
    memAccessDesc.textContent = 'None';
    prevRegs = new Array(32).fill(0);

    pcVal.textContent = toHex(sim.get_pc(), 8);
    stepsVal.textContent = '0';
    cyclesVal.textContent = '0';

    renderCode(currentCode, activeLine);
    renderRegisters(prevRegs, []);
    renderMemory(currentMemAddr);
    setStatus('Ready', 'ready');
    consoleOutput.textContent = '';
    appendConsole('[System] Simulator reset.\n');
  } catch (err) {
    setStatus('Error', 'exception');
    appendConsole(`[Error] Reset failed: ${err}\n`);
  }
}

// Event Listeners
stepBtn.addEventListener('click', step);
runBtn.addEventListener('click', () => {
  if (isRunning) pause();
  else run();
});
resetBtn.addEventListener('click', reset);

speedSlider.addEventListener('input', (e) => {
  const val = parseInt(e.target.value, 10);
  if (val >= 90) {
    speedLabel.textContent = 'Max';
  } else {
    speedLabel.textContent = `${val} Hz`;
  }
  if (isRunning) {
    pause();
    run();
  }
});

presetSelect.addEventListener('change', (e) => {
  const key = e.target.value;
  if (key === 'custom') {
    openModal();
  } else if (PRESETS[key]) {
    baseAddrInput.value = PRESETS[key].base;
    loadProgram(PRESETS[key].code, PRESETS[key].format, PRESETS[key].base);
  }
});

regFormatBtn.addEventListener('click', () => {
  regDisplayFormat = regDisplayFormat === 'hex' ? 'dec' : 'hex';
  regFormatBtn.textContent = regDisplayFormat === 'hex' ? 'Hex / Dec' : 'Dec / Hex';
  renderRegisters(prevRegs, Array.from(changedRegs));
});

memGoBtn.addEventListener('click', () => {
  renderMemory(parseAddr(memAddrInput.value));
});
memAddrInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') renderMemory(parseAddr(memAddrInput.value));
});

memPcBtn.addEventListener('click', () => {
  if (sim) renderMemory(sim.get_pc() & ~0xF);
});
memSpBtn.addEventListener('click', () => {
  renderMemory(prevRegs[2] & ~0xF);
});

clearConsoleBtn.addEventListener('click', () => {
  consoleOutput.textContent = '';
});

// Modal Logic
function openModal() {
  modalTextarea.value = currentCode;
  modalFormatSelect.value = currentFormat;
  codeModal.classList.remove('hidden');
}
function closeModal() {
  codeModal.classList.add('hidden');
}

editCodeBtn.addEventListener('click', openModal);
closeModalBtn.addEventListener('click', closeModal);
cancelModalBtn.addEventListener('click', closeModal);

applyModalBtn.addEventListener('click', () => {
  const code = modalTextarea.value;
  const format = modalFormatSelect.value;
  closeModal();
  loadProgram(code, format, baseAddrInput.value);
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    modalTextarea.value = evt.target.result;
    if (file.name.endsWith('.hex') || file.name.endsWith('.txt')) {
      modalFormatSelect.value = 'hex';
    } else {
      modalFormatSelect.value = 's';
    }
  };
  reader.readAsText(file);
});

// Keyboard shortcuts (F10 = step, Space = run/pause)
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'F10') {
    e.preventDefault();
    step();
  } else if (e.code === 'Space') {
    e.preventDefault();
    if (isRunning) pause();
    else run();
  }
});

// Startup Initialization
async function main() {
  initRegsGrid();
  setStatus('Loading WASM...', 'ready');
  try {
    await init();
    setStatus('Ready', 'ready');
    // Load default preset test.s
    const defaultPreset = PRESETS['test.s'];
    baseAddrInput.value = defaultPreset.base;
    loadProgram(defaultPreset.code, defaultPreset.format, defaultPreset.base);
  } catch (err) {
    setStatus('WASM Error', 'exception');
    appendConsole(`[Fatal] Failed to initialize WASM module: ${err}\n`);
    console.error(err);
  }
}

main();
