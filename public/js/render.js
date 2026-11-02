// Month sheet rendering: the five sections, their SUM footers and the balance
// bar.
//
// `renderMonth` paints a fetched `MonthView`. `addEntry` is the composer's
// optimistic path: the API has already assigned the new row its top position,
// so the client can prepend it and adjust the visible totals without a refetch.
// Only income and expense rows touch the numbers — notes never do.
import { fmtVND, prettyDate } from "./format.js";

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

/** The sheet currently on screen; `addEntry` updates it in place. */
let sheet = null;

/**
 * Paints every section from a `MonthView`: income and expense entries, the
 * fixed snapshots/templates, the notes, each numeric SUM footer and the
 * balance bar. Section order is the order of `index.html`.
 */
export function renderMonth(view) {
  sheet = view;

  const income = view.entries.filter((entry) => entry.kind === "income");
  const expense = view.entries.filter((entry) => entry.kind === "expense");
  const notes = view.entries.filter((entry) => entry.kind === "note");

  const fixedIncome = view.fixed.filter((row) => row.kind === "fixed_income");
  const fixedExpense = view.fixed.filter((row) => row.kind === "fixed_expense");

  tbIncome.replaceChildren(...income.map(entryRow));
  tbExpense.replaceChildren(...expense.map(entryRow));
  tbNotes.replaceChildren(...notes.map(entryRow));
  tbFixedIncome.replaceChildren(...fixedIncome.map((row) => fixedRow(row, "fixed_income")));
  tbFixedExpense.replaceChildren(...fixedExpense.map((row) => fixedRow(row, "fixed_expense")));

  sumIncome.textContent = fmtVND(sumAmounts(income));
  sumExpense.textContent = expenseSum(sumAmounts(expense));
  sumFixedIncome.textContent = fmtVND(sumAmounts(fixedIncome));
  sumFixedExpense.textContent = expenseSum(sumAmounts(fixedExpense));

  renderBalance(view.summary, view.initial);
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

  const row = entryRow(entry);
  tbody.prepend(row);

  const section = tbody.closest(".section");
  if (section !== null) section.classList.remove("collapsed");

  sheet.entries = [entry, ...sheet.entries];
  applyToTotals(entry);

  if (entry.kind === "income") {
    sumIncome.textContent = fmtVND(sumAmounts(entriesOf("income")));
  } else if (entry.kind === "expense") {
    sumExpense.textContent = expenseSum(sumAmounts(entriesOf("expense")));
  }

  renderBalance(sheet.summary, sheet.initial);
  flash(row);
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
function entryRow(entry) {
  const tr = el("tr");
  tr.dataset.id = String(entry.id);

  const name = el("td");
  const cellName = el("span", "cell-name");
  cellName.append(el("span", "page-icon", "📄"), el("span", "txt", entry.name));
  name.append(cellName);

  tr.append(handleCell(), name);

  if (entry.kind !== "note") tr.append(amountCell(entry.amount, entry.kind));

  tr.append(
    el("td", "date", prettyDate(entry.date)),
    commentCell(entry.comment),
    el("td", "row-act", "⚙ ⋮"),
  );

  return tr;
}

/** A fixed-section row; virtual template rows keep their negative id marker. */
function fixedRow(row, kind) {
  const tr = el("tr");
  tr.dataset.id = String(row.id);
  if (row.id < 0) tr.dataset.virtual = "true";

  const name = el("td");
  const cellName = el("span", "cell-name");
  cellName.append(el("span", "page-icon", "📄"), el("span", "txt", row.name));
  name.append(cellName);

  tr.append(handleCell(), name, amountCell(row.amount, kind), commentCell(row.comment));

  tr.append(el("td", "row-act", "⚙ ⋮"));
  return tr;
}

function handleCell() {
  const td = el("td");
  td.append(el("span", "handle", "⠿⠿"));
  return td;
}

function commentCell(comment) {
  const td = el("td");
  td.append(el("span", "comment", comment ?? ""));
  return td;
}

/** Expense amounts carry the red `−` sign; everything else is green-positive. */
function amountCell(amount, kind) {
  const td = el("td");
  const debit = kind === "expense" || kind === "fixed_expense";
  const value = el("span", `amount ${debit ? "debit" : "credit"}`);

  if (debit) value.append("−");
  value.append(el("span", "txt", fmtVND(amount ?? 0)));
  td.append(value);

  return td;
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

function applyToTotals(entry) {
  const summary = sheet.summary;
  if (entry.kind === "income" && entry.amount !== null) {
    sheet.summary = {
      ...summary,
      income: summary.income + entry.amount,
      ending: summary.ending + entry.amount,
    };
  } else if (entry.kind === "expense" && entry.amount !== null) {
    sheet.summary = {
      ...summary,
      expense: summary.expense + entry.amount,
      ending: summary.ending - entry.amount,
    };
  }
}

function entriesOf(kind) {
  return sheet.entries.filter((entry) => entry.kind === kind);
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
