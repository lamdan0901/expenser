// Frontend coordinator: passcode gate, first-run setup, month navigation.
//
// The API is the source of truth for every number on screen. This module boots
// the page, gates it behind the signed cookie, decides which month is visible
// and hands the fetched sheet to `render.js`; `composer.js` owns the fast
// capture form. Keep this file a thin shell — inline editing, drag and the
// action menus land in `render.js`/`editing.js` (Task 13).
import { ApiError, getMe, getMonth, setInitialBalance, verifyPasscode } from "./api.js";
import { renderComposer } from "./composer.js";
import { initEditing, parseInitialK } from "./editing.js";
import { todayIso, ymLabel } from "./format.js";
import {
  addEntry,
  addFixedRow,
  forgetRow,
  getInitial,
  markRowDeleting,
  patchRowModel,
  renderMonth,
  restoreRow,
  setInitial,
} from "./render.js";

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

/** Month currently being shown, even while its fetch is in flight. */
let activeYm = null;
/** Only the newest fetch may paint; older responses are discarded. */
let loadSeq = 0;
/** Navigation listeners are installed once, after the first successful gate. */
let started = false;

const composer = renderComposer({
  onSaved: addEntry,
  onSessionExpired: () => showGate("Session expired — enter the passcode again."),
});

const editing = initEditing({
  getInitial,
  onEntryCreated: addEntry,
  onFixedCreated: addFixedRow,
  onRowPatched: patchRowModel,
  onRowDeleting: markRowDeleting,
  onRowRestored: restoreRow,
  onRowForgotten: forgetRow,
  onInitialSaved: setInitial,
  onRefresh: () => {
    if (activeYm !== null) void loadMonth(activeYm);
  },
  onNotice: showNotice,
  onSessionExpired: () => showGate("Session expired — enter the passcode again."),
});

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

  // Shares the ⚙ dialog's validator: an opening balance of 0 is valid.
  const value = parseInitialK(initialInput.value);
  if (value === null) {
    setupError.textContent = "Enter a whole number of thousands, zero or above.";
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
        const collapsed = head.closest(".section").classList.toggle("collapsed");
        head.setAttribute("aria-expanded", String(!collapsed));
      });
      head.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          head.click();
        }
      });
    }
  }

  // A deep link wins; otherwise open the current month and write it to the URL.
  const ym = monthFromHash();
  if (location.hash.slice(1) !== ym) {
    history.replaceState(null, "", `#${ym}`);
  }
  void loadMonth(ym);
  composer.focusName();
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
  composer.setMonth(ym);
  editing.setMonth(ym);
  hideNotice();

  try {
    const view = await getMonth(ym);
    if (seq !== loadSeq) return;
    composer.setMonth(view.ym);
    editing.setMonth(view.ym);
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

// ── Small helpers ─────────────────────────────────────────────────────────

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
