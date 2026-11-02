// Fast capture composer: direction, name, amount (in whole thousands), comment
// and date chip. Enter anywhere in the form POSTs the entry, then the caller
// prepends the saved row — the month is never refetched for a new entry.
import { ApiError, createEntry } from "./api.js";
import { monthISOBounds, parseK, todayIso } from "./format.js";

const app = byId("app");
const form = byId("composer");
const expenseButton = form.querySelector('[data-kind="expense"]');
const incomeButton = form.querySelector('[data-kind="income"]');

const nameInput = byId("f-name");
const amountInput = byId("f-amt");
const commentInput = byId("f-note");
const dateWrap = byId("f-dwrap");
const dateLabel = byId("f-dlbl");
const dateInput = byId("f-date");
const saveButton = byId("f-go");
const errorLine = byId("f-error");

let kind = "expense";
let activeYm = null;
let busy = false;

/**
 * Wires the composer once and returns its small control surface. `onSaved`
 * receives `(entry, ym)` after a successful POST; `onSessionExpired` is called
 * on a 401 so the shell can show the passcode gate again.
 */
export function renderComposer({ onSaved, onSessionExpired }) {
  expenseButton.addEventListener("click", () => selectKind("expense"));
  incomeButton.addEventListener("click", () => selectKind("income"));

  dateInput.addEventListener("change", syncDateLabel);
  form.addEventListener("submit", (event) => void save(event));

  for (const input of [nameInput, amountInput, commentInput]) {
    input.addEventListener("input", clearError);
  }
  dateInput.addEventListener("change", clearError);

  document.addEventListener("keydown", onGlobalKey);

  selectKind(kind, { focus: false });
  setDate(defaultDate(currentYm()));

  return {
    /** Constrains the chip to the sheet the user is now looking at. */
    setMonth(ym) {
      activeYm = ym;
      const { min, max } = monthISOBounds(ym);
      dateInput.min = min;
      dateInput.max = max;

      // Keep a valid choice; a month change that strands "today" falls back to
      // the first day so a save can never post outside the open sheet.
      if (dateInput.value === "" || dateInput.value < min || dateInput.value > max) {
        setDate(defaultDate(ym));
      }
    },
    focusName() {
      nameInput.focus();
    },
  };

  async function save(event) {
    event.preventDefault();
    if (busy) return;

    clearError();

    if (activeYm === null) {
      showError("The month is still loading. Try again.");
      return;
    }

    const name = nameInput.value.trim();
    if (name === "") {
      showError("Add a name first.");
      nameInput.focus();
      return;
    }

    // `parseK` validates the typed thousands and gives the full-VND value the
    // row displays; the entry route itself accepts the k-scale number.
    const amount = parseK(amountInput.value);
    if (amount === null) {
      showError("Enter the amount in whole thousands, above 0.");
      amountInput.focus();
      return;
    }

    const date = dateInput.value;
    const { min, max } = monthISOBounds(activeYm);
    if (date === "" || date < min || date > max) {
      showError("Pick a day inside the open month.");
      dateInput.focus();
      return;
    }

    const comment = commentInput.value.trim();

    setBusy(true);
    try {
      const saved = await createEntry(activeYm, {
        kind,
        name,
        amount: amount / 1000,
        date,
        comment,
      });
      onSaved({ id: saved.id, kind, name, amount, date, comment }, activeYm);
      reset();
      nameInput.focus();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      showError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    nameInput.value = "";
    amountInput.value = "";
    commentInput.value = "";
    setDate(defaultDate(activeYm));
    clearError();
  }
}

// ── Direction ─────────────────────────────────────────────────────────────

function selectKind(next, { focus = true } = {}) {
  kind = next;

  for (const button of [expenseButton, incomeButton]) {
    const on = button.dataset.kind === kind;
    button.classList.toggle("on", on);
    button.classList.toggle("exp", on && kind === "expense");
    button.classList.toggle("inc", on && kind === "income");
    button.setAttribute("aria-pressed", String(on));
  }

  if (focus) nameInput.focus();
}

function onGlobalKey(event) {
  if (app.hidden) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === "Escape") {
    selectKind(kind === "expense" ? "income" : "expense");
    event.preventDefault();
    return;
  }

  if ((event.key === "n" || event.key === "N") && !isEditable(event.target)) {
    nameInput.focus();
    event.preventDefault();
  }
}

/** N is a shortcut, not a keystroke to steal from another field. */
function isEditable(node) {
  if (!(node instanceof HTMLElement)) return false;
  return (
    node.isContentEditable || node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.tagName === "SELECT"
  );
}

// ── Date chip ─────────────────────────────────────────────────────────────

function setDate(iso) {
  dateInput.value = iso;
  syncDateLabel();
}

/** Today when it belongs to `ym`, otherwise that month's first day. */
function defaultDate(ym) {
  const today = todayIso();
  const { min, max } = monthISOBounds(ym);
  return today >= min && today <= max ? today : min;
}

function syncDateLabel() {
  const value = dateInput.value;

  if (value === "") {
    setDate(defaultDate(activeYm ?? currentYm()));
    return;
  }

  if (value === todayIso()) {
    dateWrap.classList.remove("has");
    dateLabel.textContent = "Today";
  } else {
    dateWrap.classList.add("has");
    dateLabel.textContent = shortDate(value);
  }
}

/** `"2026-11-01"` → `"Nov 1"` for the compact chip. */
function shortDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ── Feedback ──────────────────────────────────────────────────────────────

function errorMessage(error) {
  if (error instanceof ApiError && error.status === 400) {
    switch (error.body?.error) {
      case "invalid_name":
        return "Add a name first.";
      case "invalid_amount":
        return "Amount must be a whole number of thousands.";
      case "date_out_of_month":
        return "Pick a day inside the open month.";
    }
  }

  return "Could not save. Try again.";
}

function showError(message) {
  errorLine.textContent = message;
  errorLine.hidden = false;
}

function clearError() {
  errorLine.textContent = "";
  errorLine.hidden = true;
}

function setBusy(value) {
  busy = value;
  saveButton.disabled = value;
  form.classList.toggle("busy", value);
}

function currentYm() {
  return todayIso().slice(0, 7);
}

function byId(name) {
  return document.getElementById(name);
}
