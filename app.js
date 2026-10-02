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
  return {
    isExample: true,
    expectedWeekly: "500",
    weekMode: "average",
    paydayWeekday: 5,
    currentWeek: "auto",
    actualsMonth: currentMonthKey(),
    actuals: { "avg-1": "425" },
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
    weekMode: "average",
    paydayWeekday: 5,
    currentWeek: "auto",
    actualsMonth: currentMonthKey(),
    actuals: {},
    expenses: [],
    savings: { amount: "", frequency: "monthly" },
  };
}

// Two copies of the budget can exist:
//   baseline — your real, saved budget
//   scenario — a temporary copy for What-If mode (null when not in use)
let baseline = loadState() ?? createExampleState();
let scenario = null;
let monthNoticeText = "";

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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(baseline));
  } catch (error) {
    /* storage unavailable — keep working without it */
  }
}

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

  // A new month starts with a clean set of weekly actuals.
  if (state.actualsMonth !== currentMonthKey()) {
    if (Object.keys(state.actuals).length > 0) {
      monthNoticeText = "A new month started, so last month's weekly actuals were cleared. Your income, bills, and savings are unchanged.";
    }
    state.actuals = {};
    state.actualsMonth = currentMonthKey();
    state.currentWeek = "auto";
  }
  return state;
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

function weekLabel(week) {
  const month = MONTH_NAMES_SHORT[new Date().getMonth()];
  if (week.isPayday) {
    const weekday = WEEKDAY_SHORT[new Date(`${week.key}T12:00:00`).getDay()];
    return { name: `Payday ${week.index + 1}`, dates: `${weekday}, ${month} ${week.startDay}` };
  }
  return { name: `Week ${week.index + 1}`, dates: `${month} ${week.startDay}–${week.endDay}` };
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
  $(state.weekMode === "paydays" ? "weekModePaydays" : "weekModeAverage").checked = true;
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
  renderWeeks(r, state);
  renderExpenseMonthly(r);
  renderRecovery(r);
  renderMinimum(r);
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
  $("stickyMinimum").textContent = money(r.minimumWeeklyIncome);
  $("heroEquation").textContent =
    `${money(r.projectedIncome)} income − ${money(r.monthlyExpenses)} expenses − ${money(r.monthlySavings)} savings`;

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
  setKpi("kpiExpectedWeekly", money(r.expectedWeekly), "Your baseline", b.expectedWeekly, r.expectedWeekly);
  setKpi(
    "kpiIncome",
    money(r.projectedIncome),
    clean(r.projectedIncome - r.baselineMonthlyIncome) === 0
      ? `${formatWeeks(r.weeksInMonth)} at expected`
      : `Plan was ${money(r.baselineMonthlyIncome)} (${signedMoney(r.projectedIncome - r.baselineMonthlyIncome)})`,
    b.projectedIncome,
    r.projectedIncome
  );
  setKpi("kpiExpenses", money(r.monthlyExpenses), `${r.expenseLines.length} item${r.expenseLines.length === 1 ? "" : "s"}, monthly equivalent`, b.monthlyExpenses, r.monthlyExpenses);
  setKpi("kpiSavings", money(r.monthlySavings), "Set aside, not spent", b.monthlySavings, r.monthlySavings);

  setKpi(
    "kpiMinimum",
    money(r.minimumWeeklyIncome),
    r.weeklyBuffer >= 0 ? `${signedMoney(r.weeklyBuffer)}/wk buffer` : `${signedMoney(r.weeklyBuffer)}/wk short`,
    b.minimumWeeklyIncome,
    r.minimumWeeklyIncome
  );
  $("kpiMinimumSub").classList.toggle("text-bad", r.weeklyBuffer < 0 && !base);

  let recoverySub;
  if (r.deficit > 0) {
    recoverySub = r.openWeekCount > 0 ? `${money(r.extraPerOpenWeek)} extra/wk over ${r.openWeekCount} wk` : "No weeks left this month";
  } else if (r.shortfallVsPlan > 0.005) {
    recoverySub = `${money(r.shortfallVsPlan)} behind plan, still positive`;
  } else {
    recoverySub = "Month stays positive";
  }
  setKpi("kpiRecovery", money(r.deficit), recoverySub, b.deficit, r.deficit);
  $("kpiRecovery").classList.toggle("text-bad", r.deficit > 0);
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

  const extra = $("extraWeekNote");
  extra.hidden = r.extraWeeks === 0;
  if (r.extraWeeks > 0) {
    extra.textContent = `+ ${r.extraWeeks.toFixed(2)} week at your expected rate = ${money(r.extraWeekIncome)}. An average month is 52 ÷ 12 = 4.33 weeks, so this covers the days beyond 4 full weeks.`;
  }

  const paydayCount = buildWeeks(new Date().getFullYear(), new Date().getMonth(), "paydays", Number(state.paydayWeekday)).weeks.length;
  $("paydayCountLabel").textContent = `${paydayCount} ${WEEKDAY_PLURAL[Number(state.paydayWeekday)]} this month`;
  $("paydayField").hidden = state.weekMode !== "paydays";
}

function renderExpenseMonthly(r) {
  r.expenseLines.forEach((line) => {
    const cell = document.querySelector(`[data-expense-row="${line.id}"] [data-role="monthly"]`);
    if (cell) cell.textContent = money(line.monthly);
  });
  $("expenseTotal").textContent = money(r.monthlyExpenses);
}

function renderRecovery(r) {
  const weekWord = (n) => `week${n === 1 ? "" : "s"}`;
  const parts = [];

  if (r.openWeekCount === 0) {
    parts.push(`<p class="callout ${r.isPositive ? "is-good" : "is-bad"}">Every week this month is done or filled in, so there's nothing left to recover. The month finishes at <strong>${signedMoney(r.projectedRemaining)}</strong>.</p>`);
  } else {
    // Part A: compared with your plan
    if (r.shortfallVsPlan > 0.005) {
      parts.push(`<p>You are currently <strong class="text-bad">${money(r.shortfallVsPlan)} below</strong> your expected income. To stay on plan, make approximately:</p>`);
      parts.push(`<p class="recovery-big">${money(r.onPlanPerOpenWeek)}<small> / week for the remaining ${r.openWeekCount} ${weekWord(r.openWeekCount)}</small></p>`);
    } else if (r.shortfallVsPlan < -0.005) {
      parts.push(`<p>You are <strong class="text-good">${money(-r.shortfallVsPlan)} above</strong> your expected income so far. To stay on plan, the remaining weeks only need:</p>`);
      parts.push(`<p class="recovery-big">${money(Math.max(0, r.onPlanPerOpenWeek))}<small> / week for ${r.openWeekCount} ${weekWord(r.openWeekCount)}</small></p>`);
    } else {
      parts.push(`<p>You're right on plan so far. Keep making your expected amount:</p>`);
      parts.push(`<p class="recovery-big">${money(r.expectedWeekly)}<small> / week for ${r.openWeekCount} ${weekWord(r.openWeekCount)}</small></p>`);
    }

    // Part B: the hard floor to avoid going negative
    const floor = r.breakEvenPerOpenWeek;
    if (clean(floor) === 0) {
      parts.push(`<p class="callout is-good">Income already received covers this month's bills and savings. Anything you make from here is extra.</p>`);
    } else if (floor > r.expectedWeekly + 0.005) {
      parts.push(`<p class="callout is-bad">To avoid finishing negative, you need at least <strong>${money(floor)}/week</strong>. That's ${money(floor - r.expectedWeekly)} more than your usual week.</p>`);
    } else {
      parts.push(`<p class="callout">To avoid finishing negative, you need at least <strong>${money(floor)}/week</strong> from here. That's ${money(r.expectedWeekly - floor)} under your usual week, so you have room.</p>`);
    }
  }
  $("recoveryHeadline").innerHTML = parts.join("");

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
}

function renderMinimum(r) {
  $("minNeeded").textContent = `${money(r.minimumWeeklyIncome)}`;
  $("minExpected").textContent = `${money(r.expectedWeekly)}`;
  $("minBuffer").textContent = `${signedMoney(r.weeklyBuffer)}`;
  $("minBuffer").className = r.weeklyBuffer >= 0 ? "text-good" : "text-bad";

  const scale = Math.max(r.expectedWeekly, r.minimumWeeklyIncome, 1) * 1.15;
  $("minMeterFill").style.width = `${(r.expectedWeekly / scale) * 100}%`;
  $("minMeterFill").classList.toggle("is-bad", r.weeklyBuffer < 0);
  $("minMeterMarker").style.left = `calc(${(r.minimumWeeklyIncome / scale) * 100}% - 1px)`;
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
  if (r.extraWeeks > 0) weekParts.push(`${money(r.extraWeekIncome)} (0.33 wk)`);

  const baselineLine =
    state.weekMode === "average"
      ? `<p><strong>Baseline:</strong> <span class="formula">${weekly} × 52 ÷ 12 = ${money(r.baselineMonthlyIncome)}</span></p>`
      : `<p><strong>Baseline:</strong> <span class="formula">${weekly} × ${r.weeks.length} paydays = ${money(r.baselineMonthlyIncome)}</span></p>`;

  $("incomeExplain").innerHTML = `
    ${baselineLine}
    <p><strong>Projection:</strong> add up every week, using your actual amount where you entered one and ${weekly} where you didn't.</p>
    <p class="formula">${weekParts.join(" + ") || "$0.00"} = ${money(r.projectedIncome)}</p>
    <p>${state.weekMode === "average"
      ? "Average month counts every month as 4.33 weeks, so your plan doesn't jump between 4- and 5-week months."
      : "Paydays counts the real paydays this month. Months with 5 paydays show more income than months with 4."}</p>`;

  const divisor = state.weekMode === "average" ? "× 12 ÷ 52" : `÷ ${r.weeks.length} paydays`;
  $("minimumExplain").innerHTML = `
    <p class="formula">${money(r.monthlyExpenses)} expenses + ${money(r.monthlySavings)} savings = ${money(r.requiredMonthlyIncome)} needed per month</p>
    <p class="formula">${money(r.requiredMonthlyIncome)} ${divisor} = ${money(r.minimumWeeklyIncome)} per week</p>
    <p>Buffer = what you expect − what you need: <span class="formula">${weekly} − ${money(r.minimumWeeklyIncome)} = ${signedMoney(r.weeklyBuffer)}</span></p>`;

  const savingsAmount = parseMoney(state.savings.amount).value ?? 0;
  $("savingsExplain").textContent =
    state.savings.frequency === "weekly"
      ? `${money(savingsAmount)} × 52 ÷ 12 = ${money(r.monthlySavings)} per month. Subtracted from what's left, but not counted as an expense.`
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
  } else if (el.name === "weekMode") {
    state.weekMode = el.value;
    state.currentWeek = "auto";
    structureChanged = true;
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

// Show the slim summary bar once the big status card scrolls off screen.
if ("IntersectionObserver" in window) {
  new IntersectionObserver(([entry]) => {
    $("stickySummary").hidden = entry.isIntersecting;
  }).observe($("hero"));
}

/* ---------- Start ---------- */
renderInputs();
