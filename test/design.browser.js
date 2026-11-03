// Run in a local preview's DevTools; uses a temporary sheet and restores it.
export async function checkDesign() {
  const sheet = await import("/js/render.js");
  const { todayIso } = await import("/js/format.js");
  const ym = todayIso().slice(0, 7);
  const original = await fetch(`/api/month/${ym}`).then((response) => response.json());
  const view = {
    ym, initial: 20000000,
    entries: [{ id: 900001, kind: "expense", name: "Check expense", amount: 200000, date: `${ym}-02`, comment: "" }],
    fixed: [
      { id: 900002, kind: "fixed_income", name: "Check income", amount: 250000, comment: "" },
      { id: 900003, kind: "fixed_expense", name: "Check fixed", amount: 75000, comment: "" },
    ],
  };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const text = (id) => document.getElementById(id).textContent;
  const head = document.querySelector(".expense-section .sec-head");
  const collapsed = head.closest(".section").classList.contains("collapsed");
  try {
    sheet.renderMonth(view);
    assert(text("total-expense") === "−200,000 ₫", "Expense badge must show section total");
    assert(text("total-fixedinc") === "250,000 ₫", "Fixed income badge");
    assert(text("total-fixedexp") === "−75,000 ₫", "Fixed expense badge");
    assert(text("bal-ending") === "19,975,000 ₫", "Ending uses actual sheet amounts");
    sheet.patchRowModel(ym, "expense", 900001, { amount: 300000 });
    assert(text("total-expense") === "−300,000 ₫", "Badge must follow inline edits");
    sheet.markRowDeleting(ym, "expense", 900001);
    assert(text("total-expense") === "0 ₫", "Badge must exclude pending deletes");
    sheet.restoreRow(ym, "expense", 900001);
    assert(text("total-expense") === "−300,000 ₫", "Badge must follow undo");
    head.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert(head.getAttribute("aria-expanded") === String(collapsed), "Keyboard collapse state");
    head.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    assert(head.getAttribute("aria-expanded") === String(!collapsed), "Keyboard expand state");
    head.click();
    if (head.getAttribute("aria-expanded") === "true") head.click();
    sheet.addEntry({ id: 900004, kind: "expense", name: "Added", amount: 50000, date: `${ym}-03`, comment: "" }, ym);
    assert(head.getAttribute("aria-expanded") === "true", "Added entry expands its section accessibly");
    assert(text("total-expense") === "−350,000 ₫", "Badge must include added entries");
    assert(document.documentElement.scrollWidth <= innerWidth, "Page must fit viewport");
    return "Passed: live badges, balance, edit, delete, undo, keyboard collapse, added entry, viewport";
  } finally {
    sheet.renderMonth(original);
    head.closest(".section").classList.toggle("collapsed", collapsed);
    head.setAttribute("aria-expanded", String(!collapsed));
  }
}
