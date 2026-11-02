// Frontend shell: passcode gate, first-run setup, month navigation.
//
// The API is the source of truth for every number on screen. This module boots
// the page, gates it behind the signed cookie, then fetches the visible month
// and hands it to `renderMonth`. Tasks 12–13 extend that seam with the five
// full tables, the composer and inline editing.
import {
  ApiError,
  getMe,
  getMonth,
  setInitialBalance,
  verifyPasscode,
} from "./api.js";
import { fmtVND, parseK, todayIso, ymLabel } from "./format.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const gate = byId("gate");
const gateForm = byId("gate-form");
const passcodeInput = byId("passcode");
const gateError = byId("gate-error");

const setup = byId("setup");
const setupForm = byId("setup-form");
const initialInput = byId("initial-k");
const setupError = byId("setup-error");

const app = byId("app");
const monthLabel = byId("month-label");
const prevMonth = byId("prev-month");
const nextMonth = byId("next-month");
const todayChip = byId("today");
const notice = byId("notice");

const tbIncome = byId("tb-income");
const tbExpense = byId("tb-expense");
const tbFixedIncome = byId("tb-fixedinc");
const tbFixedExpense = byId("tb-fixedexp");
const tbNotes = byId("tb-notes");

const sumFixedIncome = byId("sum-fixedinc");
const sumFixedExpense = byId("sum-fixedexp");

const balInitial = byId("bal-initial");
const balIncome = byId("bal-income");
const balExpense = byId("bal-expense");
const balEnding = byId("bal-ending");

/** Month currently being shown, even while its fetch is in flight. */
let activeYm = null;
/** Only the newest fetch may paint; older responses are discarded. */
let loadSeq = 0;
/** Navigation listeners are installed once, after the first successful gate. */
let started = false;

function byId(name) {
  return document.getElementById(name);
}

// ── Boot and gate ─────────────────────────────────────────────────────────

async function boot() {
  try {
    const me = await getMe();
    if (!me.verified) return showGate();
    if (!me.setup_done) return showSetup();

    startApp();
  } catch {
    showGate("Could not reach the server. Try again.");
  }
}

function showGate(message = "") {
  gate.hidden = false;
  setup.hidden = true;
  app.hidden = true;
  gateError.textContent = message;
  passcodeInput.focus();
}

function showSetup() {
  gate.hidden = true;
  setup.hidden = false;
  app.hidden = true;
  setupError.textContent = "";
  initialInput.focus();
}

gateForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const passcode = passcodeInput.value.trim();
  if (passcode === "") {
    gateError.textContent = "Enter the passcode.";
    passcodeInput.focus();
    return;
  }

  setBusy(gateForm, true);
  gateError.textContent = "";

  try {
    await verifyPasscode(passcode);
    passcodeInput.value = "";

    const me = await getMe();
    if (me.setup_done) startApp();
    else showSetup();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      gateError.textContent = "Wrong passcode.";
      shake(gateForm);
    } else if (error instanceof ApiError && error.status === 429) {
      gateError.textContent = "Too many attempts — wait a few minutes.";
    } else {
      gateError.textContent = "Could not verify. Try again.";
    }
  } finally {
    setBusy(gateForm, false);
    if (!gate.hidden) passcodeInput.select();
  }
});

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const value = parseK(initialInput.value);
  if (value === null) {
    setupError.textContent = "Enter a whole number of thousands, above 0.";
    initialInput.select();
    return;
  }

  setBusy(setupForm, true);
  setupError.textContent = "";

  try {
    await setInitialBalance(value);
    startApp();
  } catch {
    setupError.textContent = "Could not save the balance. Try again.";
  } finally {
    setBusy(setupForm, false);
  }
});

// ── App shell and month navigation ────────────────────────────────────────

function startApp() {
  gate.hidden = true;
  setup.hidden = true;
  app.hidden = false;

  if (!started) {
    started = true;
    prevMonth.addEventListener("click", () => stepMonth(-1));
    nextMonth.addEventListener("click", () => stepMonth(1));
    todayChip.addEventListener("click", () => navigate(currentYm()));
    window.addEventListener("hashchange", () => void loadMonth(monthFromHash()));

    for (const head of document.querySelectorAll(".sec-head")) {
      head.addEventListener("click", () => {
        head.closest(".section").classList.toggle("collapsed");
      });
    }
  }

  // A deep link wins; otherwise open the current month and write it to the URL.
  const ym = monthFromHash();
  if (location.hash.slice(1) !== ym) {
    history.replaceState(null, "", `#${ym}`);
  }
  void loadMonth(ym);
}

function currentYm() {
  return todayIso().slice(0, 7);
}

function monthFromHash() {
  const candidate = location.hash.slice(1);
  return MONTH_RE.test(candidate) ? candidate : currentYm();
}

function navigate(ym) {
  if (location.hash.slice(1) === ym) {
    void loadMonth(ym);
  } else {
    location.hash = ym;
  }
}

function stepMonth(delta) {
  const ym = activeYm ?? monthFromHash();
  const [year, month] = ym.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));

  navigate(
    `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`,
  );
}

async function loadMonth(ym) {
  const seq = ++loadSeq;
  activeYm = ym;
  monthLabel.textContent = ymLabel(ym);
  hideNotice();

  try {
    const view = await getMonth(ym);
    if (seq !== loadSeq) return;
    renderMonth(view);
  } catch (error) {
    if (seq !== loadSeq) return;

    if (error instanceof ApiError && error.status === 401) {
      showGate("Session expired — enter the passcode again.");
      return;
    }

    showNotice(`Could not load ${ymLabel(ym)}. Try again.`);
  }
}

// ── Screen rendering ──────────────────────────────────────────────────────

// Skeleton for now: fixed template rows plus the always-visible balance bar.
// Task 12 replaces this with the full five-section renderer (entries, notes,
// footers, composer); the data it needs is already in `view`.
function renderMonth(view) {
  const fixedIncome = renderFixed(view.fixed, "fixed_income", tbFixedIncome);
  const fixedExpense = renderFixed(view.fixed, "fixed_expense", tbFixedExpense);

  sumFixedIncome.textContent = fmtVND(fixedIncome);
  sumFixedExpense.textContent =
    fixedExpense === 0 ? fmtVND(0) : `−${fmtVND(fixedExpense)}`;

  for (const tbody of [tbIncome, tbExpense, tbNotes]) {
    tbody.replaceChildren();
  }

  renderBalance(view.summary);
}

/** Renders one fixed section and returns its total, for the SUM footer. */
function renderFixed(rows, kind, tbody) {
  const matching = rows.filter((row) => row.kind === kind);

  tbody.replaceChildren(...matching.map((row) => fixedRow(row, kind)));

  return matching.reduce((total, row) => total + row.amount, 0);
}

function fixedRow(row, kind) {
  const tr = el("tr");
  tr.dataset.id = String(row.id);
  if (row.id < 0) tr.dataset.virtual = "true";

  const handle = el("td");
  handle.append(el("span", "handle", "⠿⠿"));

  const name = el("td");
  const cellName = el("span", "cell-name");
  cellName.append(el("span", "page-icon", "📄"), el("span", "txt", row.name));
  name.append(cellName);

  const amount = el("td");
  const amountText = el("span", `amount ${kind === "fixed_income" ? "credit" : "debit"}`);
  if (kind === "fixed_expense") amountText.append("−");
  amountText.append(el("span", "txt", fmtVND(row.amount)));
  amount.append(amountText);

  const comment = el("td");
  comment.append(el("span", "comment", row.comment));

  const actions = el("td", "row-act", "⚙ ⋮");

  tr.append(handle, name, amount, comment, actions);
  return tr;
}

function renderBalance(summary) {
  balInitial.textContent = fmtVND(summary.initial);
  balIncome.textContent = fmtVND(summary.income);
  balExpense.textContent = summary.expense === 0 ? fmtVND(0) : `−${fmtVND(summary.expense)}`;
  balEnding.textContent = fmtVND(summary.ending);
  balEnding.classList.toggle("red", summary.ending < 0);
  balEnding.classList.toggle("gold", summary.ending >= 0);
}

// ── Small helpers ─────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setBusy(form, busy) {
  for (const control of form.elements) control.disabled = busy;
}

function shake(node) {
  node.classList.remove("shake");
  void node.offsetWidth; // restart the animation on repeated failures
  node.classList.add("shake");
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
}

function hideNotice() {
  notice.textContent = "";
  notice.hidden = true;
}

void boot();
