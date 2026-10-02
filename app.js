/* =====================================================================
   app.js — THE UI LAYER
   ---------------------------------------------------------------------
   The whole app follows one loop:

        Input  →  Calculate  →  Update UI

   1. The user types → we write the new value into `state` (plain data).
   2. We call calculateBudget(state) from calc.js → it returns every number.
   3. We paint those numbers onto the page.

   Change one value → recalculate everything that depends on it.
   We never update one number by hand; we always re-run the full
   calculation. It is cheap, and it guarantees nothing gets out of sync.
   ===================================================================== */

const STORAGE_KEY = "personal-budget-dashboard-v1";
const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const FREQUENCY_LABELS = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly", yearly: "Yearly" };

/* =====================================================================
   1. STATE — the single source of truth
   Every number on the screen comes from this object. Amounts are kept
   as the exact text you typed ("450.50", "", "$1,200") and converted
   to numbers by calc.js, so a half-typed value never gets mangled.
   ===================================================================== */

function currentMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function newId() {
  return `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function createExampleState() {
  const today = new Date();
  const firstPayday = buildWeeks(today.getFullYear(), today.getMonth(), 5)[0];
  return {
    isExample: true,
    expectedWeekly: "500",
    paydayWeekday: 5,
    currentWeek: "auto",
    actualsMonth: currentMonthKey(),
    actuals: { [firstPayday.key]: "425" },
    expenses: [
      { id: newId(), name: "Rent", amount: "700", frequency: "monthly" },
      { id: newId(), name: "Internet", amount: "20", frequency: "monthly" },
      { id: newId(), name: "Gas", amount: "40", frequency: "weekly" },
      { id: newId(), name: "Food", amount: "30", frequency: "weekly" },
      { id: newId(), name: "Insurance", amount: "55", frequency: "monthly" },
    ],
    savings: { amount: "100", frequency: "weekly" },
  };
}

function createBlankState() {
  return {
    isExample: false,
    expectedWeekly: "",
    paydayWeekday: 5,
    currentWeek: "auto",
    actualsMonth: currentMonthKey(),
    actuals: {},
    expenses: [],
    savings: { amount: "", frequency: "monthly" },
  };
}

// Declared before loadState() runs, because loadState() writes to them.
let monthNoticeText = "";
let closedMonth = null; // { key, state } of the month that just ended, waiting to be archived

// Two copies of the budget can exist:
//   baseline — your real, saved budget
//   scenario — a temporary copy for What-If mode (null when not in use)
let baseline = loadState() ?? createExampleState();
let scenario = null;

// Whichever copy is being edited right now.
function activeState() {
  return scenario ?? baseline;
}

/* =====================================================================
   2. SAVING & LOADING (browser storage)
   localStorage can fail (private browsing, blocked storage), so every
   call is wrapped in try/catch. If it fails, the app still works; it
   just won't remember between visits.
   ===================================================================== */

function saveState() {
  try {
    const json = JSON.stringify(baseline);
    // Skipping unchanged writes stops two open tabs (or two devices) echoing saves back and forth.
    if (localStorage.getItem(STORAGE_KEY) === json) return;
    localStorage.setItem(STORAGE_KEY, json);
  } catch (error) {
    return; /* storage unavailable — keep working without it */
  }
  localChanged("budget");
}

/* ---------- Cloud sync hooks ----------
   sync.js (Firebase) keeps this device and your cloud copy in step. It sets
   window.budgetCloud once you're signed in, and calls window.budgetApp to
   read or replace the data here. Signed out, or with no sync.js, the app
   simply runs from browser storage.

   Each part ("budget" and "history") carries the time it was last changed.
   Whichever side changed more recently wins; example numbers count as never changed. */

const UPDATED_KEY = "personal-budget-dashboard-updated";

function readUpdated() {
  try {
    return JSON.parse(localStorage.getItem(UPDATED_KEY)) || {};
  } catch (error) {
    return {};
  }
}

function markUpdated(part, time) {
  try {
    localStorage.setItem(UPDATED_KEY, JSON.stringify({ ...readUpdated(), [part]: time }));
  } catch (error) {
    /* storage unavailable */
  }
}

// Called whenever this device saves a change.
function localChanged(part) {
  markUpdated(part, Date.now());
  window.budgetCloud?.push(part);
}

window.budgetApp = {
  getLocal() {
    const updated = readUpdated();
    return {
      budget: JSON.stringify(baseline),
      budgetUpdatedAt: baseline.isExample ? 0 : updated.budget ?? 0,
      history: JSON.stringify(loadHistory()),
      historyUpdatedAt: updated.history ?? 0,
    };
  },

  // Replace this device's copy with the newer one from the cloud.
  applyRemote(part, json, updatedAt) {
    try {
      localStorage.setItem(part === "budget" ? STORAGE_KEY : HISTORY_KEY, json);
    } catch (error) {
      return;
    }
    markUpdated(part, updatedAt);

    if (part === "history") {
      renderHistory();
      return;
    }
    baseline = loadState() ?? baseline;
    // Store the cleaned-up copy so the next save sees no change and doesn't send it back.
    // (If the cloud copy was from last month, loadState just reset it; that IS a change, so it's left to save.)
    if (!closedMonth) localStorage.setItem(STORAGE_KEY, JSON.stringify(baseline));
    archiveClosedMonth();
    if (scenario) refresh();
    else renderInputs();
  },
};

function loadState() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (error) {
    return null;
  }
  if (!saved || typeof saved !== "object") return null;

  // Merge onto a blank budget so a missing field never becomes undefined.
  const state = { ...createBlankState(), ...saved };
  state.savings = { ...createBlankState().savings, ...(saved.savings || {}) };
  state.expenses = Array.isArray(saved.expenses) ? saved.expenses : [];
  state.actuals = saved.actuals && typeof saved.actuals === "object" ? saved.actuals : {};
  migrateAverageWeeks(state);
  closeMonthIfNeeded(state);
  return state;
}

// A new month starts with a clean set of weekly actuals.
// The finished month is copied first so it can be written to a report.
// Returns true when a month was closed.
function closeMonthIfNeeded(state) {
  if (state.actualsMonth === currentMonthKey()) return false;
  if (!state.isExample) {
    closedMonth = { key: state.actualsMonth, state: structuredClone(state) };
    monthNoticeText = "A new month started. Last month's weekly pay was saved to Monthly history and cleared. Your income, bills, and savings are unchanged.";
  }
  state.actuals = {};
  state.actualsMonth = currentMonthKey();
  state.currentWeek = "auto";
  return true;
}

// Older saves had an "Average month" mode with weeks keyed avg-1 … avg-4.
// Move each of those amounts onto the matching payday week of that month.
function migrateAverageWeeks(state) {
  if ("weekMode" in state) {
    if (state.weekMode === "average") state.currentWeek = "auto";
    delete state.weekMode;
  }
  const [year, month] = state.actualsMonth.split("-").map(Number);
  const weeks = buildWeeks(year, month - 1, Number(state.paydayWeekday));
  for (const key of Object.keys(state.actuals)) {
    const match = /^avg-(\d)$/.exec(key);
    if (!match) continue;
    const week = weeks[Number(match[1]) - 1];
    if (week && !(week.key in state.actuals)) state.actuals[week.key] = state.actuals[key];
    delete state.actuals[key];
  }
}

/* =====================================================================
   3. FORMATTING HELPERS
   Turning numbers into readable text lives in one place, so every
   dollar amount on the page looks the same.
   ===================================================================== */

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

// Treat tiny floating-point leftovers (like -0.0000001) as zero.
function clean(number) {
  return Math.abs(number) < 0.005 ? 0 : number;
}

function money(number) {
  return currency.format(clean(number));
}

// Always shows a sign: +$416.67 or −$125.00 (a real minus sign, easy to spot).
function signedMoney(number) {
  const value = clean(number);
  if (value === 0) return currency.format(0);
  return (value > 0 ? "+" : "−") + currency.format(Math.abs(value));
}

function formatWeeks(count) {
  const rounded = Math.round(count * 100) / 100;
  return `${rounded} week${rounded === 1 ? "" : "s"}`;
}

// Any text the user typed must be escaped before going into innerHTML.
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function weekLabel(week, monthIndex = new Date().getMonth()) {
  const month = MONTH_NAMES_SHORT[monthIndex];
  const weekday = WEEKDAY_SHORT[new Date(`${week.key}T12:00:00`).getDay()];
  return { name: `Week ${week.index + 1}`, dates: `Payday ${weekday}, ${month} ${week.startDay}` };
}

const $ = (id) => document.getElementById(id);

/* =====================================================================
   4. CALCULATE
   One tiny wrapper so "today" is always fresh.
   ===================================================================== */

function calculate(state) {
  return calculateBudget(state, new Date());
}

/* =====================================================================
   5. BUILD THE EDITABLE LISTS
   These rebuild the HTML for the week rows and the expense rows.
   We only rebuild them when their STRUCTURE changes (add/remove an
   expense, switch week mode). While you type, we leave the inputs alone
   and just update the numbers — rebuilding an input while you're typing
   in it would kick your cursor out.
   ===================================================================== */

function renderWeekRows() {
  const state = activeState();
  const results = calculate(state);

  $("weekList").innerHTML = results.weeks
    .map((week) => {
      const label = weekLabel(week);
      const value = state.actuals[week.key] ?? "";
      return `
        <div class="week-row" data-week-row="${week.index}">
          <div>
            <div class="week-name">${label.name}</div>
            <div class="week-dates">${label.dates}</div>
            <span class="week-status" data-role="status"></span>
          </div>
          <div class="money-input">
            <span aria-hidden="true">$</span>
            <input type="text" inputmode="decimal" autocomplete="off"
              id="actual-${week.key}" data-week-key="${week.key}"
              aria-label="${label.name} actual income" value="${escapeHtml(value)}">
          </div>
          <div class="week-bar" aria-hidden="true">
            <div class="week-bar-fill" data-role="fill"></div>
            <div class="week-bar-marker" data-role="marker"></div>
          </div>
          <div class="week-diff" data-role="diff"></div>
          <p class="field-error" id="actual-${week.key}-error" role="alert"></p>
        </div>`;
    })
    .join("");

  // The "Current week" menu depends on which weeks exist, so rebuild it too.
  const auto = results.autoWeekIndex;
  const autoName = auto >= results.weeks.length ? "month is over" : weekLabel(results.weeks[auto]).name;
  const options = [`<option value="auto">Automatic (today: ${autoName})</option>`];
  results.weeks.forEach((week) => options.push(`<option value="${week.index}">${weekLabel(week).name}</option>`));
  options.push(`<option value="${results.weeks.length}">Month is over</option>`);
  $("currentWeek").innerHTML = options.join("");
  $("currentWeek").value = String(state.currentWeek);
  if ($("currentWeek").value === "") $("currentWeek").value = "auto";
}

function renderExpenseRows() {
  const state = activeState();
  const frequencyOptions = (selected) =>
    Object.entries(FREQUENCY_LABELS)
      .map(([value, text]) => `<option value="${value}"${value === selected ? " selected" : ""}>${text}</option>`)
      .join("");

  $("expenseList").innerHTML = state.expenses
    .map(
      (expense) => `
      <div class="expense-row" data-expense-row="${expense.id}">
        <input class="expense-name" type="text" id="exp-${expense.id}-name" data-expense-id="${expense.id}" data-expense-field="name"
          value="${escapeHtml(expense.name)}" placeholder="e.g. Phone bill" aria-label="Expense name" autocomplete="off">
        <div class="money-input">
          <span aria-hidden="true">$</span>
          <input type="text" inputmode="decimal" id="exp-${expense.id}-amount" data-expense-id="${expense.id}" data-expense-field="amount"
            value="${escapeHtml(expense.amount)}" placeholder="0.00" aria-label="Amount" autocomplete="off">
        </div>
        <select id="exp-${expense.id}-frequency" data-expense-id="${expense.id}" data-expense-field="frequency" aria-label="How often">
          ${frequencyOptions(expense.frequency)}
        </select>
        <span class="expense-monthly" data-role="monthly"></span>
        <button type="button" class="remove-button" data-remove-expense="${expense.id}" aria-label="Remove ${escapeHtml(expense.name || "expense")}">×</button>
        <p class="field-error" id="exp-${expense.id}-amount-error" role="alert"></p>
      </div>`
    )
    .join("");

  $("expenseEmpty").hidden = state.expenses.length > 0;
}

// Copies the state's values into the fixed inputs (used on load, reset, and What-If switches).
function renderInputs() {
  const state = activeState();
  $("expectedWeekly").value = state.expectedWeekly;
  $("savingsAmount").value = state.savings.amount;
  $(state.savings.frequency === "weekly" ? "savingsWeekly" : "savingsMonthly").checked = true;
  $("paydayWeekday").value = String(state.paydayWeekday);
  validateAmount($("expectedWeekly"));
  validateAmount($("savingsAmount"));
  renderWeekRows();
  renderExpenseRows();
  refresh();
}

/* =====================================================================
   6. UPDATE UI — paint the results
   renderResults receives the object from calculateBudget and writes
   every number onto the page. It contains no math of its own beyond
   turning amounts into bar widths.
   ===================================================================== */

function refresh() {
  const results = calculate(activeState());
  const baselineResults = scenario ? calculate(baseline) : null;
  renderResults(results, baselineResults);
  if (!scenario) saveState(); // What-If changes are never saved
}

function renderResults(r, base) {
  const state = activeState();
  const today = new Date();
  $("monthLabel").textContent = today.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  renderHero(r, base);
  renderKpis(r, base);
  renderThisWeek(r, state);
  renderWeeks(r, state);
  renderExpenseMonthly(r);
  renderNeeds(r);
  renderSettingsSummary(r, state);
  renderFlow(r);
  renderBreakdown(r);
  renderExpenseBars(r);
  renderExplanations(r, state);
  renderBanners();
}

function renderHero(r, base) {
  const hero = $("hero");
  hero.classList.toggle("is-negative", !r.isPositive);

  for (const pill of [$("statusPill"), $("stickyStatus")]) {
    pill.textContent = r.isPositive ? "Positive" : "Negative";
    pill.classList.toggle("is-negative", !r.isPositive);
  }

  $("heroRemaining").textContent = signedMoney(r.projectedRemaining);
  $("stickyRemaining").textContent = signedMoney(r.projectedRemaining);
  $("stickyMinimum").textContent = r.breakEvenPerOpenWeek === null ? "—" : money(r.breakEvenPerOpenWeek);

  if (r.isPositive) {
    $("heroMessage").textContent = clean(r.projectedRemaining) === 0
      ? "You're projected to finish the month at exactly $0. Any dip in income will push it negative."
      : `You're projected to finish the month ${money(r.projectedRemaining)} ahead after paying bills and saving.`;
  } else {
    let message = `You need approximately ${money(r.deficit)} more income this month to reach $0.`;
    if (r.openWeekCount > 0) {
      message += ` Over your ${r.openWeekCount} remaining week${r.openWeekCount === 1 ? "" : "s"}, that's ${money(r.extraPerOpenWeek)} more per week.`;
    } else {
      message += " There are no weeks left this month to make it up.";
    }
    $("heroMessage").textContent = message;
  }

  const delta = $("heroDelta");
  delta.hidden = !base;
  if (base) {
    const change = r.projectedRemaining - base.projectedRemaining;
    delta.textContent = `Your saved budget: ${signedMoney(base.projectedRemaining)}  ·  This what-if: ${signedMoney(change)} difference`;
  }
}

// In What-If mode, show "was $X" under any number that changed.
function setKpi(id, valueText, subText, baseValue, currentValue) {
  $(id).textContent = valueText;
  const sub = $(`${id}Sub`);
  if (baseValue !== undefined && clean(baseValue - currentValue) !== 0) {
    sub.textContent = `Saved budget: ${money(baseValue)}`;
    sub.classList.add("is-was");
  } else {
    sub.textContent = subText;
    sub.classList.remove("is-was");
  }
}

function renderKpis(r, base) {
  const b = base ?? {};
  const vsPlan = r.projectedIncome - r.baselineMonthlyIncome;
  setKpi(
    "kpiIncome",
    money(r.projectedIncome),
    clean(vsPlan) === 0
      ? `${r.weeks.length} weeks × ${money(r.expectedWeekly)}`
      : `Plan was ${money(r.baselineMonthlyIncome)} (${signedMoney(vsPlan)})`,
    b.projectedIncome,
    r.projectedIncome
  );
  setKpi("kpiExpenses", money(r.monthlyExpenses), `${r.expenseLines.length} bill${r.expenseLines.length === 1 ? "" : "s"} this month`, b.monthlyExpenses, r.monthlyExpenses);
  setKpi("kpiSavings", money(r.monthlySavings), "Set aside, not spent", b.monthlySavings, r.monthlySavings);
}

function renderWeeks(r, state) {
  // One scale for every bar so the weeks compare fairly.
  const largest = Math.max(r.expectedWeekly, ...r.weeks.map((week) => week.amountUsed), 1);
  const percent = (amount) => `${Math.min(100, (amount / largest) * 100)}%`;
  const statusText = { actual: "Actual", assumed: "Past · assumed", open: "Upcoming" };

  r.weeks.forEach((week) => {
    const row = document.querySelector(`[data-week-row="${week.index}"]`);
    if (!row) return;
    row.classList.toggle("is-current", week.index === r.currentWeekIndex);

    const status = row.querySelector('[data-role="status"]');
    status.dataset.status = week.status;
    status.textContent = week.index === r.currentWeekIndex && week.status === "open" ? "This week" : statusText[week.status];

    const input = row.querySelector("input");
    input.placeholder = r.expectedWeekly.toFixed(2);

    const fill = row.querySelector('[data-role="fill"]');
    fill.style.width = percent(week.amountUsed);
    const diff = clean(week.difference);
    fill.classList.toggle("is-above", week.status === "actual" && diff > 0);
    fill.classList.toggle("is-below", week.status === "actual" && diff < 0);
    fill.classList.toggle("is-even", week.status === "actual" && diff === 0);
    row.querySelector('[data-role="marker"]').style.left = `calc(${percent(r.expectedWeekly)} - 1px)`;

    const diffCell = row.querySelector('[data-role="diff"]');
    if (week.status === "actual") {
      diffCell.innerHTML = `${signedMoney(diff)}<small>vs expected</small>`;
      diffCell.className = `week-diff ${diff > 0 ? "text-good" : diff < 0 ? "text-bad" : ""}`;
    } else {
      diffCell.innerHTML = `${money(week.amountUsed)}<small>${week.status === "assumed" ? "assumed" : "expected"}</small>`;
      diffCell.className = "week-diff";
    }
  });

  const monthName = new Date().toLocaleDateString("en-US", { month: "long" });
  const count = r.weeks.length;
  $("weeksHeading").textContent = `${count} weeks in ${monthName}`;
  $("weekCountHint").textContent = `${monthName} has ${count} ${WEEKDAY_PLURAL[Number(state.paydayWeekday)]}, so this is a ${count}-week month.`;
}

function renderExpenseMonthly(r) {
  r.expenseLines.forEach((line) => {
    const cell = document.querySelector(`[data-expense-row="${line.id}"] [data-role="monthly"]`);
    if (cell) cell.textContent = money(line.monthly);
  });
  $("expenseTotal").textContent = money(r.monthlyExpenses);
}

// The most recent payday on or before today: the paycheck you just got.
// Used by the This week card and by the Friday reminder link.
function latestPaydayWeek(weeks) {
  const today = new Date().getDate();
  return weeks.filter((week) => week.startDay <= today).pop() ?? null;
}

function renderThisWeek(r, state) {
  const latest = latestPaydayWeek(r.weeks);
  const week = latest ?? r.weeks[0]; // before this month's first payday, show the first one
  const label = weekLabel(week);
  $("thisWeekWhen").textContent = `${label.name} of ${r.weeks.length} · ${label.dates}${latest ? "" : " (upcoming)"}`;

  const input = $("thisWeekPay");
  if (input.dataset.weekKey !== week.key || document.activeElement !== input) {
    input.dataset.weekKey = week.key;
    input.value = state.actuals[week.key] ?? "";
    validateAmount(input);
  }
  input.placeholder = r.expectedWeekly.toFixed(2);

  const status = week.status === "actual"
    ? `${signedMoney(week.difference)} vs your usual week`
    : `Leave it blank and it counts as ${money(r.expectedWeekly)}`;
  $("thisWeekResult").innerHTML = `${status} · Left this month: <strong class="${r.isPositive ? "text-good" : "text-bad"}">${signedMoney(r.projectedRemaining)}</strong>`;
}

function renderNeeds(r) {
  const weekWord = (n) => `week${n === 1 ? "" : "s"}`;
  const perWeek = (amount) => (amount === null ? "—" : `${money(Math.max(0, amount))}<small>/wk</small>`);
  const breakEven = r.breakEvenPerOpenWeek;

  $("needBreakEven").innerHTML = perWeek(breakEven);
  $("needBreakEven").className = breakEven !== null && breakEven > r.expectedWeekly + 0.005 ? "text-bad" : "";
  $("needOnPlan").innerHTML = perWeek(r.onPlanPerOpenWeek);
  $("needUsual").innerHTML = perWeek(r.expectedWeekly);
  $("needWeeksLeft").textContent = r.openWeekCount > 0
    ? `For the ${r.openWeekCount} ${weekWord(r.openWeekCount)} left this month.`
    : "No weeks left this month.";

  // Meter: your usual week, with a line where break-even sits.
  $("needMeter").hidden = breakEven === null;
  if (breakEven !== null) {
    const scale = Math.max(r.expectedWeekly, breakEven, 1) * 1.15;
    $("needMeterFill").style.width = `${(r.expectedWeekly / scale) * 100}%`;
    $("needMeterFill").classList.toggle("is-bad", breakEven > r.expectedWeekly + 0.005);
    $("needMeterMarker").style.left = `calc(${(breakEven / scale) * 100}% - 1px)`;
  }

  // One plain sentence about where you stand.
  let tone = "";
  let message;
  if (r.openWeekCount === 0) {
    tone = r.isPositive ? "is-good" : "is-bad";
    message = `Every week this month is done or filled in. The month finishes at <strong>${signedMoney(r.projectedRemaining)}</strong>.`;
  } else if (clean(breakEven) === 0) {
    tone = "is-good";
    message = "Pay you've already received covers this month's bills and savings. Anything from here is extra.";
  } else if (breakEven > r.expectedWeekly + 0.005) {
    tone = "is-bad";
    message = `Your usual week isn't enough this month. You need about <strong>${money(breakEven - r.expectedWeekly)} more each week</strong> to avoid finishing negative.`;
  } else if (r.shortfallVsPlan > 0.005) {
    message = `You're <strong>${money(r.shortfallVsPlan)} behind plan</strong>, but your usual week still covers the ${money(breakEven)} you need, with ${money(r.expectedWeekly - breakEven)} to spare.`;
  } else if (r.shortfallVsPlan < -0.005) {
    tone = "is-good";
    message = `You're <strong>${money(-r.shortfallVsPlan)} ahead of plan</strong>. Your usual week covers the ${money(breakEven)} you need, with ${money(r.expectedWeekly - breakEven)} to spare.`;
  } else {
    tone = "is-good";
    message = `You're on plan. Your usual week covers the ${money(breakEven)} you need, with ${money(r.expectedWeekly - breakEven)} to spare.`;
  }
  $("needMessage").innerHTML = `<p class="callout ${tone}">${message}</p>`;

  const currentText = r.currentWeekIndex >= r.weeks.length ? "Month is over" : `${weekLabel(r.weeks[r.currentWeekIndex]).name} of ${r.weeks.length}`;
  const facts = [
    ["Current week", currentText],
    ["Completed / remaining", `${r.completedWeekCount} done · ${r.openWeekCount} left`],
    ["Income received", money(r.incomeReceived)],
    ["Expected still to come", money(r.expectedStillToCome)],
    ["Needed this month", money(r.requiredMonthlyIncome)],
    ["Still required to reach $0", money(r.stillRequired)],
  ];
  $("recoveryFacts").innerHTML = facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("");

  $("needExplain").innerHTML = r.openWeekCount === 0 ? "" : `
    <p><strong>Break even:</strong> <span class="formula">${money(r.stillRequired)} still required ÷ ${r.openWeekCount} ${weekWord(r.openWeekCount)} = ${money(breakEven)}/wk</span></p>
    <p><strong>Stay on plan:</strong> <span class="formula">${money(r.expectedWeekly)} usual ${r.shortfallVsPlan >= 0 ? "+" : "−"} ${money(Math.abs(r.shortfallVsPlan))} ${r.shortfallVsPlan >= 0 ? "behind" : "ahead"} ÷ ${r.openWeekCount} = ${money(r.onPlanPerOpenWeek)}/wk</span></p>`;
}

// One line under "Budget settings" so you can see your setup without opening it.
function renderSettingsSummary(r, state) {
  const savings = parseMoney(state.savings.amount).value ?? 0;
  const parts = [
    `${money(r.expectedWeekly)}/week`,
    `paid ${WEEKDAY_PLURAL[Number(state.paydayWeekday)]}`,
    `${r.expenseLines.length} bill${r.expenseLines.length === 1 ? "" : "s"} (${money(r.monthlyExpenses)})`,
    savings > 0 ? `saving ${money(savings)}/${state.savings.frequency === "weekly" ? "week" : "month"}` : "no savings goal",
  ];
  $("settingsSummary").textContent = parts.join(" · ");
}

function renderFlow(r) {
  const outflow = r.monthlyExpenses + r.monthlySavings;
  const scale = Math.max(r.projectedIncome, outflow);
  const track = $("flowTrack");

  if (scale <= 0) {
    track.innerHTML = `<p class="flow-empty" style="padding:10px 12px">Add income or expenses to see where your money goes.</p>`;
    $("flowScale").innerHTML = "";
    return;
  }

  const pct = (amount) => (Math.max(0, amount) / scale) * 100;
  const segments = [
    ["expenses", r.monthlyExpenses, "Expenses"],
    ["savings", r.monthlySavings, "Savings"],
  ];
  if (r.projectedRemaining > 0) segments.push(["remaining", r.projectedRemaining, "Remaining"]);

  let html = segments
    .map(([css, amount, label]) => `<div class="flow-seg ${css}" style="width:${pct(amount)}%" title="${label}: ${money(amount)}"></div>`)
    .join("");

  // When spending + saving is bigger than income, the bar runs past the income line.
  // We hatch that overhang in red: it's the shortfall.
  if (r.projectedRemaining < 0) {
    html += `<div class="flow-seg short" style="position:absolute;top:0;left:${pct(r.projectedIncome)}%;width:${pct(-r.projectedRemaining)}%" title="Shortfall: ${money(-r.projectedRemaining)}"></div>`;
  }
  html += `<div class="flow-income-line" style="left:calc(${pct(r.projectedIncome)}% - 1px)" title="Income"></div>`;
  track.innerHTML = html;

  const incomePct = pct(r.projectedIncome);
  const labels = [`<span style="left:0">$0</span>`];
  const endClass = incomePct > 85 ? "is-end" : "";
  labels.push(`<span class="${endClass}" style="left:${incomePct}%">Income ${money(r.projectedIncome)}</span>`);
  $("flowScale").innerHTML = labels.join("");
}

function renderBreakdown(r) {
  const perWeek = (amount) => (r.weeksInMonth > 0 ? amount / r.weeksInMonth : 0);
  const rows = [
    ["remaining", "Income", money(r.projectedIncome), money(perWeek(r.projectedIncome)), null],
    ["expenses", "Expenses", `−${money(r.monthlyExpenses)}`, `−${money(perWeek(r.monthlyExpenses))}`, null],
    ["savings", "Savings", `−${money(r.monthlySavings)}`, `−${money(perWeek(r.monthlySavings))}`, null],
    [null, "Remaining", signedMoney(r.projectedRemaining), signedMoney(perWeek(r.projectedRemaining)), r.isPositive ? "text-good" : "text-bad"],
  ];
  $("breakdownBody").innerHTML = rows
    .map(([swatch, label, month, week, css]) => `
      <tr${css ? ` class="${css}"` : ""}>
        <td>${swatch && label !== "Income" ? `<span class="swatch swatch-${swatch}"></span>` : ""}${label}</td>
        <td>${month}</td><td>${week}</td>
      </tr>`)
    .join("");
}

function renderExpenseBars(r) {
  const lines = [...r.expenseLines].sort((a, b) => b.monthly - a.monthly);
  const largest = Math.max(...lines.map((line) => line.monthly), 0);

  if (lines.length === 0) {
    $("expenseBars").innerHTML = `<p class="empty">Your expenses will appear here, biggest first.</p>`;
    return;
  }
  $("expenseBars").innerHTML = lines
    .map((line) => {
      const share = r.monthlyExpenses > 0 ? Math.round((line.monthly / r.monthlyExpenses) * 100) : 0;
      const width = largest > 0 ? (line.monthly / largest) * 100 : 0;
      return `
        <div class="hbar">
          <span class="hbar-name">${escapeHtml(line.name)}</span>
          <span class="hbar-value">${money(line.monthly)} <small>${share}%</small></span>
          <div class="hbar-track"><div class="hbar-fill" style="width:${width}%"></div></div>
        </div>`;
    })
    .join("");
}

// The "How is this calculated" boxes show the real formula with your real numbers.
function renderExplanations(r, state) {
  const weekly = money(r.expectedWeekly);
  const weekParts = r.weeks.map((week) => money(week.amountUsed));

  $("incomeExplain").innerHTML = `
    <p><strong>Baseline:</strong> <span class="formula">${weekly} × ${r.weeks.length} weeks = ${money(r.baselineMonthlyIncome)}</span></p>
    <p><strong>Projection:</strong> add up every week, using your actual amount where you entered one and ${weekly} where you didn't.</p>
    <p class="formula">${weekParts.join(" + ") || "$0.00"} = ${money(r.projectedIncome)}</p>
    <p>Each payday this month is one week, so 5-payday months show more income than 4-payday months. Weekly bills and savings are counted the same way.</p>`;

  const divisor = `÷ ${r.weeks.length} weeks`;
  $("minimumExplain").innerHTML = `
    <p><strong>If every week paid the same</strong> (the whole month, not just what's left):</p>
    <p class="formula">${money(r.monthlyExpenses)} expenses + ${money(r.monthlySavings)} savings = ${money(r.requiredMonthlyIncome)} needed per month</p>
    <p class="formula">${money(r.requiredMonthlyIncome)} ${divisor} = ${money(r.minimumWeeklyIncome)} per week</p>
    <p>Buffer = what you expect − what you need: <span class="formula">${weekly} − ${money(r.minimumWeeklyIncome)} = ${signedMoney(r.weeklyBuffer)}</span></p>`;

  const savingsAmount = parseMoney(state.savings.amount).value ?? 0;
  $("savingsExplain").textContent =
    state.savings.frequency === "weekly"
      ? `${money(savingsAmount)} × ${r.weeks.length} weeks = ${money(r.monthlySavings)} this month. Subtracted from what's left, but not counted as an expense.`
      : `${money(r.monthlySavings)} per month. Subtracted from what's left, but not counted as an expense.`;
}

function renderBanners() {
  $("exampleBanner").hidden = !baseline.isExample || Boolean(scenario);
  $("monthNotice").hidden = !monthNoticeText;
  $("monthNotice").textContent = monthNoticeText;
  $("whatIfBar").hidden = !scenario;
  document.body.classList.toggle("is-whatif", Boolean(scenario));
  $("whatIfToggle").textContent = scenario ? "Exit what-if" : "Try a what-if";
}

/* =====================================================================
   6b. MONTHLY HISTORY
   When a month ends, its weeks and pay are written into a plain-text
   report and kept in browser storage. Each month shows as a pill in the
   Monthly history panel; its ⋯ menu downloads the .txt or deletes it.
   ===================================================================== */

const HISTORY_KEY = "personal-budget-dashboard-history-v1";

function loadHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch (error) {
    return [];
  }
}

function saveHistory(history) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (error) {
    return; /* storage unavailable — history won't survive a reload */
  }
  localChanged("history");
}

function monthName(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// Builds the text report for one finished month from that month's saved state.
function buildMonthReport(monthKey, state) {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(year, month, 0); // last day of that month
  // Calculate as if the month is over, so every week counts as finished.
  const r = calculateBudget({ ...state, currentWeek: 99 }, lastDay);

  const enteredWeeks = r.weeks.filter((week) => week.status === "actual");
  const totalEntered = enteredWeeks.reduce((sum, week) => sum + week.actual, 0);
  const pad = (text, width) => String(text).padEnd(width);

  const lines = [
    `Personal Budget — ${monthName(monthKey)}`,
    `Saved ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
    "",
    `Expected weekly take-home: ${money(r.expectedWeekly)}`,
    `Weeks this month: ${r.weeks.length}`,
    "",
    "WEEKS",
  ];
  r.weeks.forEach((week) => {
    const label = weekLabel(week, month - 1);
    const amount = week.status === "actual" ? money(week.actual) : "—";
    const note = week.status === "actual" ? "" : `  (not entered, counted as ${money(week.expected)})`;
    lines.push(`  ${pad(label.name, 11)}${pad(label.dates, 14)}${amount}${note}`);
  });
  lines.push(
    "",
    `Total pay entered:   ${money(totalEntered)}  (${enteredWeeks.length} of ${r.weeks.length} weeks)`,
    `Month total:         ${money(r.projectedIncome)}  (entered pay + expected for blank weeks)`,
    "",
    `Bills & expenses:    ${money(r.monthlyExpenses)}`,
    `Savings:             ${money(r.monthlySavings)}`,
    `Remaining:           ${signedMoney(r.projectedRemaining)}`,
    ""
  );
  return { month: monthKey, totalEntered, monthTotal: r.projectedIncome, text: lines.join("\n") };
}

function downloadReport(report) {
  const blob = new Blob([report.text], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `budget-${report.month}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// Runs once on load: if a month just ended, add its report to the history.
function archiveClosedMonth() {
  if (!closedMonth) return;
  const report = buildMonthReport(closedMonth.key, closedMonth.state);
  closedMonth = null;
  const history = loadHistory().filter((item) => item.month !== report.month);
  history.push(report);
  history.sort((a, b) => b.month.localeCompare(a.month)); // newest first
  saveHistory(history);
}

let openMenuMonth = null; // which pill's ⋯ menu is open
let confirmDeleteMonth = null; // Delete asks once before removing

// Redrawing the list drops keyboard focus, so `focusSelector` puts it back.
function renderHistory(focusSelector) {
  const history = loadHistory();
  $("historyEmpty").hidden = history.length > 0;
  $("historyList").innerHTML = history
    .map((item) => {
      const isOpen = item.month === openMenuMonth;
      const deleteText = item.month === confirmDeleteMonth ? "Click again to delete" : "Delete month";
      return `
      <li class="history-pill${isOpen ? " is-open" : ""}">
        <span class="history-month">${monthName(item.month)}</span>
        <span class="history-total">${money(item.monthTotal)}</span>
        <button type="button" class="history-menu-button" data-menu-month="${item.month}"
          aria-label="Options for ${monthName(item.month)}" aria-haspopup="menu" aria-expanded="${isOpen}">⋯</button>
        <div class="history-menu" role="menu"${isOpen ? "" : " hidden"}>
          <button type="button" role="menuitem" data-download-month="${item.month}">Download .txt</button>
          <button type="button" role="menuitem" class="is-danger" data-delete-month="${item.month}">${deleteText}</button>
        </div>
      </li>`;
    })
    .join("");
  if (focusSelector) $("historyList").querySelector(focusSelector)?.focus();
}

function closeHistoryMenu(focusSelector) {
  if (openMenuMonth === null && confirmDeleteMonth === null) return;
  openMenuMonth = null;
  confirmDeleteMonth = null;
  renderHistory(focusSelector);
}

$("historyList").addEventListener("click", (event) => {
  const menuButton = event.target.closest("[data-menu-month]");
  const downloadButton = event.target.closest("[data-download-month]");
  const deleteButton = event.target.closest("[data-delete-month]");

  if (menuButton) {
    const month = menuButton.dataset.menuMonth;
    openMenuMonth = openMenuMonth === month ? null : month;
    confirmDeleteMonth = null;
    renderHistory(openMenuMonth ? `[data-download-month="${month}"]` : `[data-menu-month="${month}"]`);
  } else if (downloadButton) {
    const month = downloadButton.dataset.downloadMonth;
    const report = loadHistory().find((item) => item.month === month);
    if (report) downloadReport(report);
    closeHistoryMenu(`[data-menu-month="${month}"]`);
  } else if (deleteButton) {
    const month = deleteButton.dataset.deleteMonth;
    if (confirmDeleteMonth !== month) {
      confirmDeleteMonth = month;
      renderHistory(`[data-delete-month="${month}"]`);
      return;
    }
    saveHistory(loadHistory().filter((item) => item.month !== month));
    closeHistoryMenu("[data-menu-month]"); // focus moves to the next month's ⋯
  }
});

// The page may stay open past midnight on the last day of the month.
// Close out the old month before anything new is typed into it.
function checkForNewMonth() {
  if (!closeMonthIfNeeded(baseline)) return false;
  if (scenario) {
    scenario.actuals = {};
    scenario.actualsMonth = baseline.actualsMonth;
    scenario.currentWeek = "auto";
  }
  archiveClosedMonth();
  renderInputs();
  renderHistory();
  return true;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkForNewMonth();
});
window.addEventListener("focus", checkForNewMonth);

// Clicking anywhere else, or pressing Escape, closes the menu.
document.addEventListener("click", (event) => {
  if (!event.target.closest(".history-pill")) closeHistoryMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openMenuMonth) closeHistoryMenu(`[data-menu-month="${openMenuMonth}"]`);
});

/* =====================================================================
   7. INPUT — listen for changes
   Instead of attaching a listener to every single input (including ones
   that don't exist yet), we put ONE listener on the whole document and
   check what was changed. This is called "event delegation". It means
   newly added expense rows work automatically.
   ===================================================================== */

// Shows or clears the red message under an amount box.
function validateAmount(input) {
  const { error } = parseMoney(input.value);
  input.setAttribute("aria-invalid", error ? "true" : "false");
  const errorEl = document.getElementById(`${input.id}-error`) || document.getElementById(`${input.id}Error`);
  if (errorEl) errorEl.textContent = error;
}

function handleChange(event) {
  if (checkForNewMonth()) return; // the page was open across a month change
  const el = event.target;
  const state = activeState();
  let structureChanged = false;

  if (el.id === "expectedWeekly") {
    state.expectedWeekly = el.value;
    validateAmount(el);
  } else if (el.id === "savingsAmount") {
    state.savings.amount = el.value;
    validateAmount(el);
  } else if (el.name === "savingsFrequency") {
    state.savings.frequency = el.value;
  } else if (el.id === "paydayWeekday") {
    state.paydayWeekday = Number(el.value);
    state.currentWeek = "auto";
    structureChanged = true;
  } else if (el.id === "currentWeek") {
    state.currentWeek = el.value;
  } else if (el.dataset.weekKey) {
    const text = el.value.trim();
    if (text === "") delete state.actuals[el.dataset.weekKey];
    else state.actuals[el.dataset.weekKey] = el.value;
    validateAmount(el);
    // The This week card and the week's row are two boxes for the same week; keep them matching.
    document.querySelectorAll(`[data-week-key="${el.dataset.weekKey}"]`).forEach((other) => {
      if (other === el) return;
      other.value = el.value;
      validateAmount(other);
    });
  } else if (el.dataset.expenseId) {
    const expense = state.expenses.find((item) => item.id === el.dataset.expenseId);
    if (!expense) return;
    expense[el.dataset.expenseField] = el.value;
    if (el.dataset.expenseField === "amount") validateAmount(el);
  } else {
    return; // not one of our inputs
  }

  if (!scenario) baseline.isExample = false; // once you edit, the numbers are yours
  if (structureChanged) renderWeekRows();
  refresh(); // Input → Calculate → Update UI
}

document.addEventListener("input", handleChange);
document.addEventListener("change", (event) => {
  // <select> and radio buttons report through "change" in some browsers.
  if (event.target.tagName === "SELECT" || event.target.type === "radio") handleChange(event);
});

/* ---------- Buttons ---------- */

$("addExpense").addEventListener("click", () => {
  const expense = { id: newId(), name: "", amount: "", frequency: "monthly" };
  activeState().expenses.push(expense);
  if (!scenario) baseline.isExample = false;
  renderExpenseRows();
  refresh();
  $(`exp-${expense.id}-name`).focus();
});

$("expenseList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-expense]");
  if (!button) return;
  const state = activeState();
  state.expenses = state.expenses.filter((expense) => expense.id !== button.dataset.removeExpense);
  if (!scenario) baseline.isExample = false;
  renderExpenseRows();
  refresh();
});

// What-If: copy the baseline into a scenario and edit the copy instead.
$("whatIfToggle").addEventListener("click", () => {
  if (scenario) {
    scenario = null;
  } else {
    scenario = structuredClone(baseline);
    $("settingsDetails").open = true; // what-ifs are mostly changes to settings
  }
  renderInputs();
});

$("applyScenario").addEventListener("click", () => {
  baseline = scenario;
  baseline.isExample = false;
  scenario = null;
  renderInputs(); // also saves
});

$("discardScenario").addEventListener("click", () => {
  scenario = null;
  renderInputs();
});

$("startBlank").addEventListener("click", () => {
  baseline = createBlankState();
  scenario = null;
  $("settingsDetails").open = true;
  renderInputs();
  $("expectedWeekly").focus();
});

$("keepExample").addEventListener("click", () => {
  baseline.isExample = false;
  refresh();
});

// Two-step erase: the first click asks, the second click does it.
let resetTimer = null;
$("resetAll").addEventListener("click", (event) => {
  const button = event.currentTarget;
  if (!resetTimer) {
    button.textContent = "Click again to erase";
    resetTimer = setTimeout(() => {
      button.textContent = "Erase everything";
      resetTimer = null;
    }, 4000);
    return;
  }
  clearTimeout(resetTimer);
  resetTimer = null;
  button.textContent = "Erase everything";
  baseline = createBlankState();
  scenario = null;
  monthNoticeText = "";
  renderInputs();
});

// The reminder opens a new tab. If the dashboard is already open in another
// tab, pick up what that tab saved so this one doesn't overwrite it later.
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) {
    const fresh = loadState();
    if (!fresh) return;
    baseline = fresh;
    if (!scenario) renderInputs();
  } else if (event.key === HISTORY_KEY) {
    renderHistory();
  }
});

/* ---------- Backup & restore ----------
   Everything lives in Safari's storage, so clearing Safari's website data
   erases it. "Back up" saves the budget and Monthly history to a .json file
   in Downloads; "Restore backup" reads that file back in. */

const BACKUP_DATE_KEY = "personal-budget-dashboard-last-backup";

let backupMessageTimer = null;

// `tone` is "good" for the green success message; it fades back to the date after a few seconds.
function renderBackupStatus(message, tone) {
  clearTimeout(backupMessageTimer);
  $("backupStatus").classList.toggle("text-good", tone === "good");
  if (message) backupMessageTimer = setTimeout(() => renderBackupStatus(), 6000);
  let lastBackup = null;
  try {
    lastBackup = localStorage.getItem(BACKUP_DATE_KEY);
  } catch (error) {
    /* storage unavailable */
  }
  $("backupStatus").textContent = message
    ?? (lastBackup
      ? `Last backup: ${new Date(lastBackup).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
      : "No backup yet");
}

$("backupButton").addEventListener("click", () => {
  const savedAt = new Date();
  const backup = { app: "personal-budget-dashboard", version: 1, savedAt: savedAt.toISOString(), budget: baseline, history: loadHistory() };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  // The time keeps two backups made on the same day from overwriting each other.
  const time = `${String(savedAt.getHours()).padStart(2, "0")}${String(savedAt.getMinutes()).padStart(2, "0")}`;
  link.download = `budget-backup-${isoDate(savedAt)}-${time}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  try {
    localStorage.setItem(BACKUP_DATE_KEY, savedAt.toISOString());
  } catch (error) {
    /* storage unavailable */
  }
  renderBackupStatus("Your information for the month has been backed up!", "good");
});

$("restoreButton").addEventListener("click", () => $("restoreFile").click());

$("restoreFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = ""; // lets the same file be picked again later
  if (!file) return;

  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch (error) {
    backup = null;
  }
  if (!backup || backup.app !== "personal-budget-dashboard" || typeof backup.budget !== "object" || !Array.isArray(backup.history)) {
    renderBackupStatus("That file isn't a budget backup. Pick a budget-backup-….json file.");
    return;
  }

  // Months already in history stay; the backup fills in any that are missing.
  const history = loadHistory();
  for (const item of backup.history) {
    if (!history.some((existing) => existing.month === item.month)) history.push(item);
  }
  history.sort((a, b) => b.month.localeCompare(a.month));
  saveHistory(history);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(backup.budget));
    // The file just restored is a backup too; keep the newer of the two dates.
    const lastBackup = localStorage.getItem(BACKUP_DATE_KEY);
    if (!lastBackup || lastBackup < backup.savedAt) localStorage.setItem(BACKUP_DATE_KEY, backup.savedAt);
  } catch (error) {
    /* storage unavailable — the restore still shows until the page closes */
  }
  // loadState cleans the data up and closes the month if the backup is from an earlier one.
  monthNoticeText = "";
  baseline = loadState() ?? { ...createBlankState(), ...backup.budget };
  scenario = null;
  archiveClosedMonth();
  if (!monthNoticeText) {
    monthNoticeText = `Restored your backup from ${new Date(backup.savedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.`;
  }
  renderInputs(); // also saves
  localChanged("budget"); // the save above may see no change, since the file was written straight to storage
  renderHistory();
  renderBackupStatus();
});

renderBackupStatus();

// Show the slim summary bar once the big status card scrolls off screen.
if ("IntersectionObserver" in window) {
  new IntersectionObserver(([entry]) => {
    $("stickySummary").hidden = entry.isIntersecting;
  }).observe($("hero"));
}

/* ---------- Start ---------- */
// Budget settings start folded once you're set up; open while setting up or using the example.
$("settingsDetails").open = baseline.isExample || moneyOrZero(baseline.expectedWeekly) === 0;
archiveClosedMonth();
renderInputs(); // also saves, so the cleared month is stored and can't be archived twice
renderHistory();

// The Friday reminder (tools/pay-reminder.sh) opens the page as index.html?pay=275.
// Save that amount to the most recent payday week, then clean up the address.
(function fillPayFromLink() {
  const params = new URLSearchParams(location.search);
  if (!params.has("pay")) return;
  history.replaceState(null, "", location.pathname); // a reload won't enter it twice

  const { value } = parseMoney(params.get("pay"));
  const week = latestPaydayWeek(calculate(baseline).weeks);
  if (value === null || !week) {
    monthNoticeText = "The pay from your reminder couldn't be saved. Enter it in the week below.";
    renderBanners();
    return;
  }

  scenario = null;
  baseline.actuals[week.key] = String(value);
  baseline.isExample = false;
  const label = weekLabel(week);
  monthNoticeText = `Saved ${money(value)} to ${label.name} (${label.dates}).`;
  renderInputs(); // also saves
})();
