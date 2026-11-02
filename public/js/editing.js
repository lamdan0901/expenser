// Sheet interactions: inline cell editing, drag reorder, the row action menu,
// blank draft rows, the CSV link and the initial-balance editor.
//
// `render.js` owns the sheet model and the totals; this module only mutates the
// DOM and reports back through the callbacks `initEditing` receives. That keeps
// the amount rules in one place: an existing amount is edited as full VND
// ({ amount: 500000 }), while a new draft's amount is typed in the composer's
// thousands scale (500 → 500,000 ₫).
import {
  ApiError,
  createEntry,
  createFixedRow,
  deleteEntry,
  deleteFixedRow,
  deleteTemplate,
  exportMonthUrl,
  patchEntry,
  patchFixedRow,
  patchTemplate,
  reorderEntries,
  reorderFixed,
  setInitialBalance,
} from "./api.js";
import { fmtVND, monthISOBounds, parseK, prettyDate, todayIso } from "./format.js";

/** How long the "Deleted ✕ Undo" chip waits before the DELETE is sent. */
const UNDO_MS = 5000;

const KIND_BY_TBODY = {
  "tb-income": "income",
  "tb-expense": "expense",
  "tb-fixedinc": "fixed_income",
  "tb-fixedexp": "fixed_expense",
  "tb-notes": "note",
};

const TBODY_BY_KIND = {
  income: "tb-income",
  expense: "tb-expense",
  fixed_income: "tb-fixedinc",
  fixed_expense: "tb-fixedexp",
  note: "tb-notes",
};

let config = null;
let activeYm = null;
let openRowMenu = null;

/** Editable context for a rendered row: `{ym, kind, id, name, amount, ...}`. */
const rowData = new WeakMap();
/** In-flight edit for a `.txt` cell. */
const editState = new WeakMap();
/** Local draft row state. */
const draftState = new WeakMap();
/** Optimistic deletes waiting on the undo window, keyed by row. */
const pendingDeletes = new Map();

/**
 * Wires the static sheet chrome once and returns its small control surface.
 * `render.js` calls `wireRow` for every row it paints; the callbacks let this
 * module report edits without owning the sheet model.
 */
export function initEditing(callbacks) {
  config = callbacks;

  for (const add of document.querySelectorAll("[data-add]")) {
    add.addEventListener("click", () => addDraft(add.dataset.add));
  }

  const settingsButton = byId("settings");
  if (settingsButton !== null) settingsButton.addEventListener("click", openSettings);

  const settingsCancel = byId("settings-cancel");
  if (settingsCancel !== null) {
    settingsCancel.addEventListener("click", () => {
      const dialog = byId("settings-dialog");
      if (dialog !== null) dialog.close();
    });
  }

  const settingsForm = byId("settings-form");
  if (settingsForm !== null) {
    settingsForm.addEventListener("submit", (event) => void saveSettings(event));
  }

  for (const tbody of document.querySelectorAll("tbody[id]")) wireSortable(tbody);

  document.addEventListener("click", (event) => {
    if (openRowMenu === null) return;
    if (openRowMenu.menu.contains(event.target) || openRowMenu.anchor.contains(event.target)) {
      return;
    }
    closeRowMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openRowMenu !== null) {
      closeRowMenu();
      event.preventDefault();
    }
  });

  return {
    /** Keeps the export link and drafts in step with the visible month. */
    setMonth(ym) {
      activeYm = ym;
      closeRowMenu();
      discardDrafts();

      const exportLink = byId("export");
      if (exportLink !== null) exportLink.href = exportMonthUrl(ym);
    },
  };
}

/** Attaches editing, the action menu and drag metadata to one rendered row. */
export function wireRow(row, item) {
  rowData.set(row, { ...item });

  for (const text of row.querySelectorAll(".txt[data-field]")) {
    prepareEditable(text, row);
  }

  const handle = row.querySelector(".handle");
  if (handle !== null && isFixedKind(item.kind) && item.virtual) {
    handle.draggable = false;
    handle.title = "Preview row — log something in this month to reorder";
    row.classList.add("preview-row");
  }

  row.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (action === null || !row.contains(action)) return;

    event.stopPropagation();
    if (action.dataset.action === "menu") openMenu(row, action);
    else if (action.dataset.action === "edit") focusField(row, "name");
  });
}

// ── Inline editing ────────────────────────────────────────────────────────

function prepareEditable(text, row) {
  text.setAttribute("contenteditable", "true");
  text.setAttribute("spellcheck", "false");
  if (text.dataset.field === "amount") text.setAttribute("inputmode", "decimal");

  text.addEventListener("focus", () => beginEdit(text, row));
  text.addEventListener("blur", () => void commitEdit(text));
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      text.blur();
    } else if (event.key === "Escape") {
      // Stop the composer's document-level Esc handler: cancel the cell edit
      // instead of flipping the composer's direction.
      event.preventDefault();
      event.stopPropagation();
      cancelEdit(text);
    }
  });
}

function beginEdit(text, row) {
  if (editState.has(text)) return;

  const item = rowData.get(row);
  if (item === undefined) return;

  const field = text.dataset.field;
  const original = displayValue(field, item[field]);
  text.textContent = original;
  editState.set(text, { row, item, field, original, busy: false });
}

function cancelEdit(text) {
  const state = editState.get(text);
  if (state === undefined) return;

  text.textContent = state.original;
  editState.delete(text);
  text.blur();
}

async function commitEdit(text) {
  const state = editState.get(text);
  if (state === undefined || state.busy) return;

  const { row, item, field, original } = state;
  const parsed = parseField(field, text.textContent);
  if (!parsed.ok) {
    text.textContent = original;
    editState.delete(text);
    config.onNotice(parsed.message);
    text.blur();
    return;
  }

  const value = parsed.value;
  if (value === item[field]) {
    text.textContent = displayValue(field, value);
    editState.delete(text);
    return;
  }

  state.busy = true;
  row.classList.add("row-busy");

  try {
    if (isFixedKind(item.kind)) {
      if (item.virtual) await patchTemplate(-item.id, { [field]: value });
      else await patchFixedRow(item.ym, item.id, { [field]: value });
    } else {
      await patchEntry(item.id, { [field]: value });
    }

    item[field] = value;
    rowData.set(row, item);
    text.textContent = displayValue(field, value);
    config.onRowPatched(item.ym, item.kind, item.id, { [field]: value });
    markSaved(text);
  } catch (error) {
    text.textContent = original;
    if (error instanceof ApiError && error.status === 401) {
      config.onSessionExpired();
    } else {
      config.onNotice(errorMessage(error));
    }
    // Leave the cell clean: a focused cell with no edit state would ignore the
    // next blur, so the user must be able to start a fresh edit.
    text.blur();
  } finally {
    editState.delete(text);
    row.classList.remove("row-busy");
  }
}

/** Amount cells edit as full VND; names cannot be blank; comments may be empty. */
function parseField(field, text) {
  if (field === "amount") {
    const value = parseVnd(text);
    return value === null
      ? { ok: false, message: "Amount must be a whole number of dong above 0." }
      : { ok: true, value };
  }

  if (field === "name") {
    const value = text.trim();
    return value === "" ? { ok: false, message: "Add a name first." } : { ok: true, value };
  }

  return { ok: true, value: text.trim() };
}

/** `"500,000 ₫"` / `"500000"` → `500000`; fractions, negatives and text are rejected. */
function parseVnd(text) {
  const cleaned = text.replace(/[\s,₫]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function displayValue(field, value) {
  if (field === "amount") return fmtVND(value ?? 0);
  return value ?? "";
}

function focusField(row, field) {
  const text = row.querySelector(`.txt[data-field="${field}"]`);
  if (text === null) return;

  text.focus();
  selectAll(text);
}

function markSaved(text) {
  const cell = text.closest("td");
  if (cell === null) return;

  cell.classList.remove("just-saved");
  void cell.offsetWidth; // restart the animation
  cell.classList.add("just-saved");
  setTimeout(() => cell.classList.remove("just-saved"), 900);
}

function selectAll(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  if (selection === null) return;

  selection.removeAllRanges();
  selection.addRange(range);
}

// ── Drag reorder ──────────────────────────────────────────────────────────

function wireSortable(tbody) {
  let dragRow = null;

  tbody.addEventListener("dragstart", (event) => {
    if (tbody.dataset.saving === "true") {
      event.preventDefault();
      return;
    }

    const handle = event.target.closest(".handle");
    if (handle === null) return;

    const row = handle.closest("tr");
    if (row === null || row.classList.contains("draft")) return;

    const item = rowData.get(row);
    if (item === undefined || (isFixedKind(item.kind) && item.virtual)) {
      event.preventDefault();
      return;
    }

    dragRow = row;
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(item.id));
  });

  tbody.addEventListener("dragover", (event) => {
    if (dragRow === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    clearDropMarks(tbody);
    const over = event.target.closest("tr");
    if (over === null || over === dragRow || over.classList.contains("draft")) return;

    const rect = over.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    over.classList.add(after ? "drop-after" : "drop-before");
    over.dataset.dropAfter = after ? "true" : "false";
  });

  tbody.addEventListener("drop", (event) => {
    if (dragRow === null) return;
    event.preventDefault();

    const over = event.target.closest("tr");
    if (over !== null && over !== dragRow && !over.classList.contains("draft")) {
      const after = over.dataset.dropAfter === "true";
      tbody.insertBefore(dragRow, after ? over.nextSibling : over);
    } else if (over === null) {
      tbody.append(dragRow);
    }

    const row = dragRow;
    dragRow = null;
    row.classList.remove("dragging");
    clearDropMarks(tbody);
    void saveOrder(tbody);
  });

  tbody.addEventListener("dragend", () => {
    if (dragRow !== null) dragRow.classList.remove("dragging");
    dragRow = null;
    clearDropMarks(tbody);
  });
}

function clearDropMarks(tbody) {
  for (const row of tbody.children) {
    row.classList.remove("drop-before", "drop-after");
    delete row.dataset.dropAfter;
  }
}

async function saveOrder(tbody) {
  const kind = KIND_BY_TBODY[tbody.id];
  if (kind === undefined) return;

  const rows = [...tbody.querySelectorAll("tr[data-id]")];
  if (rows.length < 2) return;

  const item = rowData.get(rows[0]);
  if (item === undefined || item.ym !== activeYm) return;
  if (isFixedKind(kind) && item.virtual) return;

  const ids = rows.map((row) => Number(row.dataset.id));
  // Entries order by `position DESC` (ids arrive bottom-up); fixed sections
  // order by `position` ascending, so their ids travel top-down.
  if (!isFixedKind(kind)) ids.reverse();

  tbody.dataset.saving = "true";
  try {
    if (isFixedKind(kind)) await reorderFixed(item.ym, kind, ids);
    else await reorderEntries(item.ym, kind, ids);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      config.onSessionExpired();
    } else {
      config.onNotice("Could not save the new order. Try again.");
      config.onRefresh();
    }
  } finally {
    delete tbody.dataset.saving;
  }
}

// ── Row menu and optimistic delete ────────────────────────────────────────

function openMenu(row, anchor) {
  closeRowMenu();

  const menu = el("div", "row-menu");
  const remove = el("button", "row-menu-item danger", "Delete");
  remove.type = "button";
  remove.addEventListener("click", () => {
    closeRowMenu();
    startDelete(row);
  });
  menu.append(remove);
  document.body.append(menu);

  const rect = anchor.getBoundingClientRect();
  const width = 130;
  menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 48)}px`;
  openRowMenu = { menu, anchor };
}

function closeRowMenu() {
  if (openRowMenu === null) return;

  openRowMenu.menu.remove();
  openRowMenu = null;
}

function startDelete(row) {
  const item = rowData.get(row);
  if (item === undefined) return;

  const key = pendingKey(item);
  if (pendingDeletes.has(key)) return;

  row.hidden = true;
  row.dataset.deleting = "true";
  config.onRowDeleting(item.ym, item.kind, item.id);

  const chip = addUndoChip(key);
  const timer = setTimeout(() => void commitDelete(key), UNDO_MS);
  pendingDeletes.set(key, { row, item, chip, timer });
}

async function commitDelete(key) {
  const pending = pendingDeletes.get(key);
  if (pending === undefined) return;

  const { row, item, chip } = pending;
  try {
    if (isFixedKind(item.kind)) {
      if (item.virtual) await deleteTemplate(-item.id);
      else await deleteFixedRow(item.ym, item.id);
    } else {
      await deleteEntry(item.id);
    }

    chip.remove();
    pendingDeletes.delete(key);
    row.remove();
    config.onRowForgotten(item.ym, item.kind, item.id);
  } catch (error) {
    undoDelete(key);

    if (error instanceof ApiError && error.status === 401) {
      config.onSessionExpired();
    } else {
      config.onNotice("Could not delete that row. Try again.");
    }
  }
}

function undoDelete(key) {
  const pending = pendingDeletes.get(key);
  if (pending === undefined) return;

  clearTimeout(pending.timer);
  pendingDeletes.delete(key);
  pending.chip.remove();
  pending.row.hidden = false;
  delete pending.row.dataset.deleting;
  config.onRowRestored(pending.item.ym, pending.item.kind, pending.item.id);
}

function addUndoChip(key) {
  let stack = byId("undo-stack");
  if (stack === null) {
    stack = el("div", "undo-stack");
    stack.id = "undo-stack";
    document.body.append(stack);
  }

  const chip = el("div", "undo-chip");
  const label = el("span", "undo-text", "Deleted");
  const button = el("button", "undo-btn", "✕ Undo");
  button.type = "button";
  button.addEventListener("click", () => undoDelete(key));
  chip.append(label, button);
  stack.append(chip);

  return chip;
}

// ── Blank draft rows ──────────────────────────────────────────────────────

function addDraft(kind) {
  const tbody = byId(TBODY_BY_KIND[kind]);
  if (tbody === null || activeYm === null) return;

  const existing = tbody.querySelector("tr.draft");
  if (existing !== null) {
    const name = existing.querySelector('.txt[data-field="name"]');
    if (name !== null) name.focus();
    return;
  }

  const date = isFixedKind(kind) ? null : defaultDate(activeYm);
  const row = draftRow(kind, date);
  tbody.prepend(row);

  const section = tbody.closest(".section");
  if (section !== null) section.classList.remove("collapsed");

  draftState.set(row, {
    saving: false,
    item: { ym: activeYm, kind, date, name: "", amount: null, comment: "" },
  });

  const name = row.querySelector('.txt[data-field="name"]');
  if (name !== null) name.focus();
}

function draftRow(kind, date) {
  const row = el("tr", "draft");
  row.dataset.kind = kind;

  const handleCell = el("td");
  const handle = el("span", "handle", "⠿⠿");
  handle.draggable = false;
  handleCell.append(handle);

  const nameCell = el("td");
  const name = el("span", "cell-name");
  const nameText = editable("name", "New item");
  name.append(el("span", "page-icon", "📄"), nameText);
  nameCell.append(name);

  row.append(handleCell, nameCell);

  if (kind !== "note") {
    const amountCell = el("td");
    const debit = kind === "expense" || kind === "fixed_expense";
    const amount = el("span", `amount ${debit ? "debit" : "credit"}`);
    if (debit) amount.append("−");
    amount.append(editable("amount", "Amount (k ₫)"));
    amountCell.append(amount);
    row.append(amountCell);
  }

  // Fixed sections have no date column; their rows repeat every month.
  if (!isFixedKind(kind)) row.append(el("td", "date", prettyDate(date)));

  const commentCell = el("td");
  const comment = el("span", "comment");
  comment.append(editable("comment", "Comment"));
  commentCell.append(comment);
  row.append(commentCell);

  const actions = el("td", "row-act");
  const discard = el("span", "row-discard", "✕");
  discard.dataset.action = "discard";
  discard.title = "Discard draft";
  actions.append(discard);
  row.append(actions);

  for (const text of row.querySelectorAll(".txt[data-field]")) {
    text.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void saveDraft(row, true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        discardDraft(row);
      }
    });
    text.addEventListener("blur", () => void saveDraft(row));
  }

  // `pointerdown` blurs a focused cell before the `click` lands on ✕, and that
  // blur would otherwise POST the draft the user is discarding. Arm the discard
  // first so `saveDraft` bails, then re-arm if the pointer is released
  // elsewhere without a click actually discarding the row.
  row.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target.closest('[data-action="discard"]') === null) return;
      const state = draftState.get(row);
      if (state !== undefined) state.discarding = true;
    },
    true,
  );

  for (const release of ["pointerup", "pointercancel"]) {
    row.addEventListener(release, () => {
      const state = draftState.get(row);
      if (state !== undefined) state.discarding = false;
    });
  }

  row.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (action === null || action.dataset.action !== "discard") return;

    event.stopPropagation();
    discardDraft(row);
  });

  return row;
}

function editable(field, placeholder) {
  const text = el("span", "txt");
  text.dataset.field = field;
  text.dataset.placeholder = placeholder;
  text.setAttribute("contenteditable", "true");
  text.setAttribute("spellcheck", "false");
  if (field === "amount") text.setAttribute("inputmode", "numeric");
  return text;
}

async function saveDraft(row, focusAmount = false) {
  const state = draftState.get(row);
  if (state === undefined || state.saving || state.discarding) return;

  const item = state.item;
  item.name = textOf(row, "name").trim();
  item.comment = textOf(row, "comment").trim();

  if (item.name === "") return;

  if (item.kind !== "note") {
    const amountText = textOf(row, "amount");
    if (amountText.trim() === "") {
      if (focusAmount) {
        const amount = row.querySelector('.txt[data-field="amount"]');
        if (amount !== null) amount.focus();
      }
      return;
    }

    // A blank draft is fresh typing, so it follows the composer's k scale.
    const amount = parseK(amountText);
    if (amount === null) return;
    item.amount = amount;
  }

  state.saving = true;
  row.classList.add("row-busy");

  try {
    // Fixed rows go through the fixed-row endpoint: in the current or a future
    // month the backend also creates the backing template, so the row repeats.
    const fixed = isFixedKind(item.kind);
    const saved = fixed
      ? await createFixedRow(item.ym, {
          kind: item.kind,
          name: item.name,
          amount: item.amount / 1000,
          comment: item.comment,
        })
      : await createEntry(item.ym, {
          kind: item.kind,
          name: item.name,
          amount: item.kind === "note" ? undefined : item.amount / 1000,
          date: item.date,
          comment: item.comment,
        });

    const created = fixed
      ? {
          id: saved.id,
          kind: item.kind,
          name: item.name,
          amount: item.amount,
          comment: item.comment,
        }
      : {
          id: saved.id,
          kind: item.kind,
          name: item.name,
          amount: item.amount,
          date: item.date,
          comment: item.comment,
        };

    // The row can be discarded while the POST is in flight (the ✕ handler runs
    // after the blur that started this save, or Enter produced a slow request).
    // Remove what we just created so a discarded draft does not come back on the
    // next reload.
    if (draftState.get(row) !== state || !row.isConnected) {
      try {
        if (fixed) await deleteFixedRow(item.ym, saved.id);
        else await deleteEntry(saved.id);
      } catch {
        config.onNotice("Could not discard the new row. Try again.");
        if (fixed) config.onFixedCreated(created, item.ym);
        else config.onEntryCreated(created, item.ym);
      }
      return;
    }

    draftState.delete(row);
    row.remove();
    if (fixed) config.onFixedCreated(created, item.ym);
    else config.onEntryCreated(created, item.ym);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      config.onSessionExpired();
    } else {
      config.onNotice("Could not save the new row. Try again.");
    }
  } finally {
    state.saving = false;
    if (row.isConnected) row.classList.remove("row-busy");
  }
}

function discardDraft(row) {
  const state = draftState.get(row);
  if (state !== undefined) state.discarding = true;

  draftState.delete(row);
  row.remove();
}

function discardDrafts() {
  for (const row of document.querySelectorAll("tr.draft")) {
    const state = draftState.get(row);
    if (state !== undefined) state.discarding = true;

    draftState.delete(row);
    row.remove();
  }
}

function textOf(row, field) {
  const text = row.querySelector(`.txt[data-field="${field}"]`);
  return text === null ? "" : text.textContent;
}

/** Today when it belongs to `ym`, otherwise that month's first day. */
function defaultDate(ym) {
  const today = todayIso();
  const { min, max } = monthISOBounds(ym);
  return today >= min && today <= max ? today : min;
}

// ── Initial balance editor ────────────────────────────────────────────────

function openSettings() {
  const dialog = byId("settings-dialog");
  if (dialog === null) return;

  const initial = config.getInitial();
  byId("settings-current").textContent = fmtVND(initial);
  byId("settings-error").textContent = "";

  const input = byId("settings-k");
  input.value = initial > 0 && initial % 1000 === 0 ? String(initial / 1000) : "";

  if (!dialog.open) dialog.showModal();
  input.focus();
  input.select();
}

async function saveSettings(event) {
  event.preventDefault();

  const input = byId("settings-k");
  const errorLine = byId("settings-error");
  const value = parseInitialK(input.value);
  if (value === null) {
    errorLine.textContent = "Enter a whole number of thousands, zero or above.";
    input.focus();
    return;
  }

  const save = byId("settings-save");
  save.disabled = true;
  errorLine.textContent = "";

  try {
    await setInitialBalance(value);
    config.onInitialSaved(value);
    byId("settings-dialog").close();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      byId("settings-dialog").close();
      config.onSessionExpired();
    } else {
      errorLine.textContent = "Could not save the balance. Try again.";
    }
  } finally {
    save.disabled = false;
  }
}

/** The opening balance follows the setup card's k input, but 0 is allowed. */
export function parseInitialK(text) {
  const cleaned = String(text).trim();
  if (!/^\d+$/.test(cleaned)) return null;

  const k = Number(cleaned);
  if (!Number.isSafeInteger(k) || k < 0 || k >= 1e9) return null;

  return k * 1000;
}

// ── Small helpers ─────────────────────────────────────────────────────────

function pendingKey(item) {
  return `${item.ym}|${item.kind}|${item.id}`;
}

function isFixedKind(kind) {
  return kind === "fixed_income" || kind === "fixed_expense";
}

function errorMessage(error) {
  if (error instanceof ApiError) {
    switch (error.body?.error) {
      case "invalid_name":
        return "Add a name first.";
      case "invalid_amount":
        return "Amount must be a whole number of dong above 0.";
      case "invalid_comment":
        return "That comment could not be saved.";
      case "invalid_ids":
        return "Could not save the new order.";
      case "date_out_of_month":
        return "Pick a day inside the open month.";
      case "not_found":
        return "That row no longer exists — refresh the month.";
    }
  }

  return "Could not save. Try again.";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function byId(name) {
  return document.getElementById(name);
}
