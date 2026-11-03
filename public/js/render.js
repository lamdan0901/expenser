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
import { createDateCell, wireRow } from "./editing.js";
import { setCollapsedSections } from "./api.js";

const tbIncome = byId("tb-income");
const tbExpense = byId("tb-expense");
const tbFixedIncome = byId("tb-fixedinc");
const tbFixedExpense = byId("tb-fixedexp");
const tbDebt = byId("tb-debt");
const tbNotes = byId("tb-notes");

const totalIncome = byId("total-income");
const totalExpense = byId("total-expense");
const totalFixedIncome = byId("total-fixedinc");
const totalFixedExpense = byId("total-fixedexp");

const debtInitial = byId("debt-initial");
const debtRemaining = byId("debt-remaining");

const balInitial = byId("bal-initial");
const balIncome = byId("bal-income");
const balExpense = byId("bal-expense");
const balEnding = byId("bal-ending");

export function expandSection(section) {
  if (section === null) return;
  if (section.classList.contains("collapsed")) {
    section.classList.remove("collapsed");
    const head = section.querySelector(".sec-head");
    if (head !== null) {
      head.setAttribute("aria-expanded", "true");
    }
    const collapsed = Array.from(
      document.querySelectorAll(".section.collapsed[data-section]"),
    ).map((s) => s.dataset.section);
    void setCollapsedSections(collapsed).catch(() => {});
  }
}

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
  const debt = (view.debt && view.debt.entries) || [];

  const fixedIncome = view.fixed.filter((row) => row.kind === "fixed_income");
  const fixedExpense = view.fixed.filter((row) => row.kind === "fixed_expense");

  tbIncome.replaceChildren(...income.map((entry) => entryRow(entry, view.ym)));
  tbExpense.replaceChildren(...expense.map((entry) => entryRow(entry, view.ym)));
  tbNotes.replaceChildren(...notes.map((entry) => entryRow(entry, view.ym)));
  if (tbDebt !== null) {
    tbDebt.replaceChildren(...debt.map((entry) => debtRow(entry, view.ym)));
  }
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

  expandSection(tbody.closest(".section"));

  sheet.entries = [entry, ...sheet.entries];
  paintTotals();
  flash(row);
}

/**
 * Prepends an already-saved fixed row to its section and updates the SUM footer
 * and balance bar locally. `ym` guards against painting a response for a month
 * the user has already navigated away from.
 */
export function addFixedRow(row, ym) {
  if (sheet === null) return;
  if (ym !== undefined && sheet.ym !== ym) return;

  const tbody = sectionFor(row.kind);
  if (tbody === null) return;

  const tr = fixedRow(row, row.kind, sheet.ym);
  tbody.prepend(tr);

  expandSection(tbody.closest(".section"));

  sheet.fixed = [row, ...sheet.fixed];
  paintTotals();
  flash(tr);
}

/** Prepends an already-saved debt row to its section. */
export function addDebtRow(row, ym) {
  if (sheet === null) return;
  if (ym !== undefined && sheet.ym !== ym) return;
  if (tbDebt === null) return;

  const tr = debtRow(row, sheet.ym);
  tbDebt.prepend(tr);

  expandSection(tbDebt.closest(".section"));

  if (!sheet.debt) sheet.debt = { initial: 0, remaining: 0, entries: [] };
  sheet.debt.entries = [row, ...sheet.debt.entries];
  paintTotals();
  flash(tr);
}

/** Merges an inline edit into the model and repaints every total. */
export function patchRowModel(ym, kind, id, fields) {
  if (sheet === null || sheet.ym !== ym) return;

  let list;
  if (kind === "debt") {
    list = (sheet.debt && sheet.debt.entries) || [];
  } else if (isFixedKind(kind)) {
    list = sheet.fixed;
  } else {
    list = sheet.entries;
  }

  const item = list.find((row) => (kind === "debt" ? row.id === id : row.kind === kind && row.id === id));
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

  if (kind === "debt") {
    if (sheet.debt) {
      sheet.debt.entries = sheet.debt.entries.filter((entry) => entry.id !== id);
    }
  } else if (isFixedKind(kind)) {
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

export function setDebtInitial(value) {
  if (sheet === null || !sheet.debt) return;
  sheet.debt.initial = value;
  paintTotals();
}

export function getDebtInitial() {
  return sheet === null || !sheet.debt ? 0 : sheet.debt.initial;
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
  cellName.append(nameText);
  name.append(cellName);

  tr.append(handleCell(), name);

  if (entry.kind !== "note") tr.append(amountCell(entry.amount, entry.kind));

  tr.append(createDateCell(entry.date, ym), commentCell(entry.comment), actionCell());

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
  cellName.append(nameText);
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

/** A debt-section row. */
function debtRow(entry, ym) {
  const tr = el("tr");
  tr.dataset.id = String(entry.id);
  tr.dataset.kind = "debt";

  const name = el("td");
  const cellName = el("span", "cell-name");
  const nameText = el("span", "txt", entry.name);
  nameText.dataset.field = "name";
  cellName.append(nameText);
  name.append(cellName);

  const dirTd = el("td");
  const dirBtn = el(
    "button",
    `tag-debt-type ${entry.direction === "add" ? "type-more" : "type-less"}`,
  );
  dirBtn.type = "button";
  dirBtn.dataset.action = "toggle-direction";
  dirBtn.title = "Click to toggle direction";
  dirBtn.textContent = entry.direction === "add" ? "+ More" : "− Less";
  dirTd.append(dirBtn);

  tr.append(
    handleCell(),
    name,
    dirTd,
    debtAmountCell(entry.amount, entry.direction),
    createDateCell(entry.date, ym),
    commentCell(entry.comment),
    actionCell(),
  );

  wireRow(tr, {
    ym,
    kind: "debt",
    id: entry.id,
    name: entry.name,
    direction: entry.direction,
    amount: entry.amount,
    comment: entry.comment,
    date: entry.date,
    virtual: false,
  });

  return tr;
}

function debtAmountCell(amount, direction) {
  const td = el("td");
  const isAdd = direction === "add";
  const value = el("span", `amount ${isAdd ? "debit" : "credit"}`);
  if (isAdd) value.append("+");
  else value.append("−");
  const text = el("span", "txt", fmtVND(amount ?? 0));
  text.dataset.field = "amount";
  value.append(text);
  td.append(value);
  return td;
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
  const td = el("td", "comment-cell");
  const text = el("span", "comment");
  const value = el("span", "txt", comment || "");
  value.dataset.field = "comment";
  value.dataset.placeholder = "—";
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

function actionCell() {
  const td = el("td", "row-act");

  const del = el("button", "row-del");
  del.type = "button";
  del.setAttribute("aria-label", "Delete row");
  del.dataset.action = "delete";
  del.title = "Delete row";
  del.append(iconGlyph("trash"));

  td.append(del);
  return td;
}

function iconGlyph(name, className = "glyph") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/icons.svg#${name}`);
  svg.append(use);
  return svg;
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

  // Section badges at top right of each section; the balance bar
  // is the one place fixed and this-month amounts are combined.
  totalIncome.textContent = fmtVND(sumAmounts(incomeEntries));
  totalExpense.textContent = expenseSum(sumAmounts(expenseEntries));
  totalFixedIncome.textContent = fmtVND(sumAmounts(fixedIncome));
  totalFixedExpense.textContent = expenseSum(sumAmounts(fixedExpense));

  if (sheet.debt) {
    const visibleDebt = sheet.debt.entries.filter(
      (entry) => !pendingDeletes.has(rowKey("debt", entry.id)),
    );
    let net = 0;
    for (const d of visibleDebt) {
      if (d.direction === "add") net += d.amount;
      else if (d.direction === "pay") net -= d.amount;
    }
    const rem = sheet.debt.initial + net;
    sheet.debt.remaining = rem;
    if (debtInitial !== null) debtInitial.textContent = fmtVND(sheet.debt.initial);
    if (debtRemaining !== null) debtRemaining.textContent = `Remaining: ${fmtVND(rem)}`;
  }

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
  if (kind === "fixed_income") return tbFixedIncome;
  if (kind === "fixed_expense") return tbFixedExpense;
  if (kind === "debt") return tbDebt;
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
