// Month sheet rendering: the five sections, their SUM footers and the balance
// bar.
//
// `renderMonth` paints a fetched `MonthView`. `addEntry` is the composer's
// optimistic path: the API has already assigned the new row its top position,
// so the client can prepend it and recompute the visible totals without a
// refetch. Only income and expense rows touch the numbers — notes never do.
//
// Rows are wired for inline editing, drag and the action menu by `editing.js`.
// This module owns the sheet model and the totals, so edits/deletes only need to
// tell it which row changed; `paintTotals` then recomputes every displayed sum.
import { fmtVND, prettyDate } from "./format.js";
import { wireRow } from "./editing.js";

const tbIncome = byId("tb-income");
const tbExpense = byId("tb-expense");
const tbFixedIncome = byId("tb-fixedinc");
const tbFixedExpense = byId("tb-fixedexp");
const tbNotes = byId("tb-notes");

const sumIncome = byId("sum-income");
const sumExpense = byId("sum-expense");
const sumFixedIncome = byId("sum-fixedinc");
const sumFixedExpense = byId("sum-fixedexp");

const balInitial = byId("bal-initial");
const balIncome = byId("bal-income");
const balExpense = byId("bal-expense");
const balEnding = byId("bal-ending");

/** The sheet currently on screen; the edit helpers update it in place. */
let sheet = null;
/** Rows hidden by the optimistic delete chip; they stop counting until undone. */
let pendingDeletes = new Set();

/**
 * Paints every section from a `MonthView`: income and expense entries, the
 * fixed snapshots/templates, the notes, each numeric SUM footer and the
 * balance bar. Section order is the order of `index.html`.
 */
export function renderMonth(view) {
  sheet = view;
  pendingDeletes = new Set();

  const income = view.entries.filter((entry) => entry.kind === "income");
  const expense = view.entries.filter((entry) => entry.kind === "expense");
  const notes = view.entries.filter((entry) => entry.kind === "note");

  const fixedIncome = view.fixed.filter((row) => row.kind === "fixed_income");
  const fixedExpense = view.fixed.filter((row) => row.kind === "fixed_expense");

  tbIncome.replaceChildren(...income.map((entry) => entryRow(entry, view.ym)));
  tbExpense.replaceChildren(...expense.map((entry) => entryRow(entry, view.ym)));
  tbNotes.replaceChildren(...notes.map((entry) => entryRow(entry, view.ym)));
  tbFixedIncome.replaceChildren(
    ...fixedIncome.map((row) => fixedRow(row, "fixed_income", view.ym)),
  );
  tbFixedExpense.replaceChildren(
    ...fixedExpense.map((row) => fixedRow(row, "fixed_expense", view.ym)),
  );

  paintTotals();
}

/**
 * Prepends an already-saved entry to its section and updates the SUM footer and
 * balance bar locally. `ym` guards against painting a response for a month the
 * user has already navigated away from.
 */
export function addEntry(entry, ym) {
  if (sheet === null) return;
  if (ym !== undefined && sheet.ym !== ym) return;

  const tbody = sectionFor(entry.kind);
  if (tbody === null) return;

  const row = entryRow(entry, sheet.ym);
  tbody.prepend(row);

  const section = tbody.closest(".section");
  if (section !== null) section.classList.remove("collapsed");

  sheet.entries = [entry, ...sheet.entries];
  paintTotals();
  flash(row);
}

/** Merges an inline edit into the model and repaints every total. */
export function patchRowModel(ym, kind, id, fields) {
  if (sheet === null || sheet.ym !== ym) return;

  const list = isFixedKind(kind) ? sheet.fixed : sheet.entries;
  const item = list.find((row) => row.kind === kind && row.id === id);
  if (item !== undefined) Object.assign(item, fields);

  paintTotals();
}

/** Starts an optimistic delete: the row stays in the model but stops counting. */
export function markRowDeleting(ym, kind, id) {
  if (sheet === null || sheet.ym !== ym) return;

  pendingDeletes.add(rowKey(kind, id));
  paintTotals();
}

/** Undo: the row counts again. */
export function restoreRow(ym, kind, id) {
  if (sheet === null || sheet.ym !== ym) return;

  pendingDeletes.delete(rowKey(kind, id));
  paintTotals();
}

/** The DELETE succeeded; drop the row from the model entirely. */
export function forgetRow(ym, kind, id) {
  if (sheet === null || sheet.ym !== ym) return;

  pendingDeletes.delete(rowKey(kind, id));

  if (isFixedKind(kind)) {
    sheet.fixed = sheet.fixed.filter((row) => !(row.kind === kind && row.id === id));
  } else {
    sheet.entries = sheet.entries.filter((entry) => !(entry.kind === kind && entry.id === id));
  }

  // The delete may have committed after a repaint (the undo chip outlived a
  // month round-trip); remove the row the new paint put back on screen.
  const stale = document.querySelector(`tr[data-kind="${kind}"][data-id="${id}"]`);
  if (stale !== null) stale.remove();

  paintTotals();
}

/** The ⚙ editor saved a new opening balance; repaint every derived number. */
export function setInitial(value) {
  if (sheet === null) return;

  sheet.initial = value;
  paintTotals();
}

/** The opening balance the ⚙ editor opens with. */
export function getInitial() {
  return sheet === null ? 0 : sheet.initial;
}

/** Paints the four balance-bar cells; `initial` is top-level on the view. */
function renderBalance(summary, initial) {
  balInitial.textContent = fmtVND(initial);
  balIncome.textContent = fmtVND(summary.income);
  balExpense.textContent = expenseSum(summary.expense);
  balEnding.textContent = fmtVND(summary.ending);
  balEnding.classList.toggle("red", summary.ending < 0);
  balEnding.classList.toggle("gold", summary.ending >= 0);
}

/** A normal entry row; notes drop the amount cell to match their table. */
function entryRow(entry, ym) {
  const tr = el("tr");
  tr.dataset.id = String(entry.id);
  tr.dataset.kind = entry.kind;

  const name = el("td");
  const cellName = el("span", "cell-name");
  const nameText = el("span", "txt", entry.name);
  nameText.dataset.field = "name";
  cellName.append(el("span", "page-icon", "📄"), nameText);
  name.append(cellName);

  tr.append(handleCell(), name);

  if (entry.kind !== "note") tr.append(amountCell(entry.amount, entry.kind));

  tr.append(el("td", "date", prettyDate(entry.date)), commentCell(entry.comment), actionCell());

  wireRow(tr, {
    ym,
    kind: entry.kind,
    id: entry.id,
    name: entry.name,
    amount: entry.amount,
    comment: entry.comment,
    date: entry.date,
    virtual: false,
  });

  return tr;
}

/** A fixed-section row; virtual template rows keep their negative id marker. */
function fixedRow(row, kind, ym) {
  const tr = el("tr");
  tr.dataset.id = String(row.id);
  tr.dataset.kind = kind;
  if (row.id < 0) tr.dataset.virtual = "true";

  const name = el("td");
  const cellName = el("span", "cell-name");
  const nameText = el("span", "txt", row.name);
  nameText.dataset.field = "name";
  cellName.append(el("span", "page-icon", "📄"), nameText);
  name.append(cellName);

  tr.append(handleCell(), name, amountCell(row.amount, kind), commentCell(row.comment), actionCell());

  wireRow(tr, {
    ym,
    kind,
    id: row.id,
    name: row.name,
    amount: row.amount,
    comment: row.comment,
    date: null,
    virtual: row.id < 0,
  });

  return tr;
}

function handleCell() {
  const td = el("td");
  const handle = el("span", "handle", "⠿⠿");
  handle.draggable = true;
  handle.title = "Drag to reorder";
  td.append(handle);
  return td;
}

function commentCell(comment) {
  const td = el("td");
  const text = el("span", "comment");
  const value = el("span", "txt", comment ?? "");
  value.dataset.field = "comment";
  text.append(value);
  td.append(text);
  return td;
}

/** Expense amounts carry the red `−` sign; everything else is green-positive. */
function amountCell(amount, kind) {
  const td = el("td");
  const debit = kind === "expense" || kind === "fixed_expense";
  const value = el("span", `amount ${debit ? "debit" : "credit"}`);

  if (debit) value.append("−");
  const text = el("span", "txt", fmtVND(amount ?? 0));
  text.dataset.field = "amount";
  value.append(text);
  td.append(value);

  return td;
}

/** `⚙` focuses the name cell; `⋮` opens the row menu (delete lives there). */
function actionCell() {
  const td = el("td", "row-act");

  const edit = el("span", "row-edit", "⚙");
  edit.dataset.action = "edit";
  edit.title = "Edit item";

  const menu = el("span", "row-more", "⋮");
  menu.dataset.action = "menu";
  menu.title = "Row actions";

  td.append(edit, menu);
  return td;
}

/**
 * Recomputes every SUM footer and the balance bar from the current model,
 * skipping rows hidden by a pending delete. One place means an edit, undo and
 * delete can never leave the totals half-updated.
 */
function paintTotals() {
  if (sheet === null) return;

  const fixedIncome = visibleFixed("fixed_income");
  const fixedExpense = visibleFixed("fixed_expense");
  const incomeEntries = visibleEntries("income");
  const expenseEntries = visibleEntries("expense");

  const incomeTotal =
    sumAmounts(fixedIncome) + sumAmounts(incomeEntries);
  const expenseTotal =
    sumAmounts(fixedExpense) + sumAmounts(expenseEntries);

  // The month sections' SUM footers total that section only; the balance bar
  // is the one place fixed and this-month amounts are combined.
  sumIncome.textContent = fmtVND(sumAmounts(incomeEntries));
  sumExpense.textContent = expenseSum(sumAmounts(expenseEntries));
  sumFixedIncome.textContent = fmtVND(sumAmounts(fixedIncome));
  sumFixedExpense.textContent = expenseSum(sumAmounts(fixedExpense));

  const summary = {
    income: incomeTotal,
    expense: expenseTotal,
    ending: sheet.initial + incomeTotal - expenseTotal,
  };
  sheet.summary = summary;
  renderBalance(summary, sheet.initial);
}

function visibleFixed(kind) {
  return sheet.fixed.filter(
    (row) => row.kind === kind && !pendingDeletes.has(rowKey(kind, row.id)),
  );
}

function visibleEntries(kind) {
  return sheet.entries.filter(
    (entry) => entry.kind === kind && !pendingDeletes.has(rowKey(kind, entry.id)),
  );
}

/** Adds `just-added` for the CSS flash, then clears it when the animation ends. */
function flash(row) {
  row.classList.add("just-added");

  const clear = () => row.classList.remove("just-added");
  row.addEventListener("animationend", clear, { once: true });
  // The animation lives on the row's cells; this timer is the reduced-motion
  // and hidden-section fallback.
  setTimeout(clear, 1800);
}

function rowKey(kind, id) {
  return `${kind}:${id}`;
}

function isFixedKind(kind) {
  return kind === "fixed_income" || kind === "fixed_expense";
}

function sectionFor(kind) {
  if (kind === "income") return tbIncome;
  if (kind === "expense") return tbExpense;
  if (kind === "note") return tbNotes;
  return null;
}

function sumAmounts(rows) {
  return rows.reduce((total, row) => (row.amount === null ? total : total + row.amount), 0);
}

/** Expense sums use the same leading `−` as their row amounts. */
function expenseSum(total) {
  return total === 0 ? fmtVND(0) : `−${fmtVND(total)}`;
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
