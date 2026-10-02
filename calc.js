/* =====================================================================
   calc.js — THE MATH LAYER
   ---------------------------------------------------------------------
   Every function in this file is "pure":
     - it only uses the arguments you pass in
     - it never touches the page (no document.querySelector here)
     - the same input always gives the same output
   That makes the math easy to test by itself and easy to trust.
   The UI file (app.js) calls these functions and then draws the results.
   ===================================================================== */

// How many times each frequency happens in one year.
// Converting everything through "per year" means one formula handles every frequency.
const TIMES_PER_YEAR = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  yearly: 1,
};

/* ---------------------------------------------------------------------
   1. SAFE NUMBER PARSING
   Text from an <input> is always a string. "$1,250.50" must become 1250.5,
   and garbage like "abc" must never become NaN and break every total.
   Returns { value, error }:
     value -> a usable number, or null when the box is blank
     error -> a message for the user, or "" when the input is fine
   --------------------------------------------------------------------- */
function parseMoney(rawText) {
  const text = String(rawText ?? "").replace(/[$,\s]/g, "");
  if (text === "") return { value: null, error: "" };

  const number = Number(text);
  if (!Number.isFinite(number)) return { value: null, error: "Enter a number, like 450 or 450.50" };
  if (number < 0) return { value: null, error: "Use a positive amount" };
  if (number > 10_000_000) return { value: null, error: "That amount is too large" };

  // Round to cents so floating-point leftovers (0.1 + 0.2) never show up.
  return { value: Math.round(number * 100) / 100, error: "" };
}

// Blank or invalid → 0. Used where "nothing entered" should simply count as zero.
function moneyOrZero(rawText) {
  return parseMoney(rawText).value ?? 0;
}

/* ---------------------------------------------------------------------
   2. FREQUENCY CONVERSION
   Weekly amounts follow the real number of weeks in this month, so they
   match the income side (a 5-week month pays 5 times and costs 5 times):
     $40 weekly, 5-week month → 40 × 5 = $200 / month
   Everything else uses amount × (times per year) ÷ 12:
     $100 biweekly→ 100 × 26 ÷ 12 = $216.67 / month
     $600 yearly  → 600 × 1 ÷ 12 = $50 / month
   --------------------------------------------------------------------- */
function toMonthly(amount, frequency, weeksInMonth) {
  if (frequency === "weekly") return amount * weeksInMonth;
  const timesPerYear = TIMES_PER_YEAR[frequency] ?? 12;
  return (amount * timesPerYear) / 12;
}

// What one expense costs in this particular month. Same as toMonthly, except a
// bill every 2 weeks with a due date counts its real payments this month (2 or 3);
// without a date it counts half on each payday.
function monthlyAmount(expense, year, monthIndex, weeksInMonth) {
  const amount = moneyOrZero(expense.amount);
  if (expense.frequency === "biweekly") {
    return parseIsoDate(expense.due)
      ? amount * dueDaysInMonth(expense, year, monthIndex).length
      : (amount * weeksInMonth) / 2;
  }
  return toMonthly(amount, expense.frequency, weeksInMonth);
}

function monthlyExpenseTotal(expenses, year, monthIndex, weeksInMonth) {
  return expenses.reduce((total, expense) => total + monthlyAmount(expense, year, monthIndex, weeksInMonth), 0);
}

// Savings is only ever weekly or monthly, so it reuses the same converter.
function monthlySavingsTotal(savings, weeksInMonth) {
  return toMonthly(moneyOrZero(savings.amount), savings.frequency, weeksInMonth);
}

/* ---------------------------------------------------------------------
   3. WHICH WEEKS BELONG TO THIS MONTH
   One week per payday that falls in this calendar month. A month with
   4 Fridays has 4 weeks; a month with 5 Fridays has 5 weeks.
   --------------------------------------------------------------------- */
function buildWeeks(year, monthIndex, paydayWeekday) {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const weeks = [];
  for (let day = 1; day <= lastDay; day++) {
    const date = new Date(year, monthIndex, day);
    if (date.getDay() === paydayWeekday) {
      weeks.push({ key: isoDate(date), startDay: day, endDay: day });
    }
  }
  return weeks;
}

// Which week are we in today? Weeks before this one are treated as finished.
function findCurrentWeekIndex(weeks, todayDay) {
  const index = weeks.findIndex((week) => todayDay <= week.endDay);
  return index === -1 ? weeks.length : index; // weeks.length = "month is over"
}

// "2026-10-14" → a local Date, or null for anything else.
function parseIsoDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? ""));
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function isoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/* ---------------------------------------------------------------------
   4. ACTUAL OVERRIDES EXPECTED
   For every week: if you typed an actual, use it. If not, use expected.
   Each week also gets a status:
     "actual"   — you entered what you made
     "assumed"  — the week is over but you left it blank, so we assume expected
     "open"     — still ahead of you; this is where recovery money can come from
   --------------------------------------------------------------------- */
function resolveWeeks(weeks, actuals, expectedWeekly, currentWeekIndex) {
  return weeks.map((week, index) => {
    const actual = parseMoney(actuals[week.key]).value; // null when blank
    const hasActual = actual !== null;
    const isPast = index < currentWeekIndex;

    let status = "open";
    if (hasActual) status = "actual";
    else if (isPast) status = "assumed";

    const amountUsed = hasActual ? actual : expectedWeekly;
    return {
      ...week,
      index,
      expected: expectedWeekly,
      actual,
      amountUsed,
      difference: hasActual ? actual - expectedWeekly : 0,
      status,
    };
  });
}

/* ---------------------------------------------------------------------
   5. THE MAIN CALCULATION
   Takes the whole budget state + today's date, returns every number the
   dashboard shows. The UI never does math on its own; it only reads this.

   Four separate ideas, never mixed:
     BASELINE   — expected weekly income, the plan
     ACTUAL     — what you really made in a given week
     PROJECTION — where the month ends if open weeks pay as expected
     RECOVERY   — what the open weeks must pay so the month doesn't go negative
   --------------------------------------------------------------------- */
function calculateBudget(state, today) {
  const expectedWeekly = moneyOrZero(state.expectedWeekly);

  // --- Month structure ---
  const weeks = buildWeeks(today.getFullYear(), today.getMonth(), Number(state.paydayWeekday));
  const autoWeekIndex = findCurrentWeekIndex(weeks, today.getDate());
  const currentWeekIndex = state.currentWeek === "auto" ? autoWeekIndex : Math.min(Number(state.currentWeek), weeks.length);
  const weeksInMonth = weeks.length; // 4 or 5

  const resolvedWeeks = resolveWeeks(weeks, state.actuals, expectedWeekly, currentWeekIndex);

  // --- Baseline (the plan, ignoring actuals) ---
  const baselineMonthlyIncome = expectedWeekly * weeksInMonth;

  // --- Projection (actuals where entered, expected everywhere else) ---
  const projectedIncome = resolvedWeeks.reduce((sum, week) => sum + week.amountUsed, 0);
  const year = today.getFullYear();
  const monthIndex = today.getMonth();
  const monthlyExpenses = monthlyExpenseTotal(state.expenses, year, monthIndex, weeksInMonth);
  const monthlySavings = monthlySavingsTotal(state.savings, weeksInMonth);
  const projectedRemaining = projectedIncome - monthlyExpenses - monthlySavings;

  // --- Minimum weekly income (break-even if every week paid the same) ---
  const requiredMonthlyIncome = monthlyExpenses + monthlySavings;
  const minimumWeeklyIncome = weeksInMonth > 0 ? requiredMonthlyIncome / weeksInMonth : 0;
  const weeklyBuffer = expectedWeekly - minimumWeeklyIncome;

  // --- Recovery (split only across weeks that haven't happened yet) ---
  const openWeeks = resolvedWeeks.filter((week) => week.status === "open");
  const closedWeeks = resolvedWeeks.filter((week) => week.status !== "open");
  const openWeekCount = openWeeks.length;

  const incomeReceived = closedWeeks.reduce((sum, week) => sum + week.amountUsed, 0);
  const expectedStillToCome = openWeekCount * expectedWeekly;

  // How far actual weeks are from the plan. Positive = behind, negative = ahead.
  const shortfallVsPlan = resolvedWeeks
    .filter((week) => week.status === "actual")
    .reduce((sum, week) => sum + (week.expected - week.actual), 0);

  // What the open weeks must produce so the month ends at exactly $0.
  const stillRequired = Math.max(0, requiredMonthlyIncome - incomeReceived);

  const hasOpenWeeks = openWeekCount > 0;
  const breakEvenPerOpenWeek = hasOpenWeeks ? stillRequired / openWeekCount : null;
  const onPlanPerOpenWeek = hasOpenWeeks ? expectedWeekly + shortfallVsPlan / openWeekCount : null;
  const deficit = Math.max(0, -projectedRemaining);
  const extraPerOpenWeek = hasOpenWeeks ? deficit / openWeekCount : null;

  return {
    expectedWeekly,
    weeks: resolvedWeeks,
    weeksInMonth,
    currentWeekIndex,
    autoWeekIndex,

    baselineMonthlyIncome,
    projectedIncome,
    monthlyExpenses,
    monthlySavings,
    projectedRemaining,
    isPositive: projectedRemaining >= 0,

    requiredMonthlyIncome,
    minimumWeeklyIncome,
    weeklyBuffer,

    openWeekCount,
    completedWeekCount: closedWeeks.length,
    incomeReceived,
    expectedStillToCome,
    shortfallVsPlan,
    stillRequired,
    breakEvenPerOpenWeek,
    onPlanPerOpenWeek,
    deficit,
    extraPerOpenWeek,

    expenseLines: state.expenses.map((expense) => ({
      id: expense.id,
      name: expense.name.trim() || "Unnamed expense",
      monthly: monthlyAmount(expense, year, monthIndex, weeksInMonth),
    })),

    paychecks: planPaychecks(state, resolvedWeeks, year, monthIndex),
  };
}

/* ---------------------------------------------------------------------
   6. WHICH PAYCHECK PAYS WHICH BILL
   Each bill is paid from the most recent paycheck on or before the day
   it's due. Bills without a date land where they're simplest:
     weekly                → every paycheck
     monthly, no due day   → the first paycheck
     every 2 weeks, no date→ half on every paycheck
     yearly                → 1/12 set aside from the first paycheck
     savings               → every paycheck (weekly) or the first (monthly)
   A bill due before this month's first payday is still listed on the
   first paycheck, flagged so you know it's already due.
   Everything adds up to the same totals as the summary, so the last
   paycheck's running total equals "projected remaining".
   --------------------------------------------------------------------- */

// Days of this month an expense falls due (monthly: its day; every 2 weeks: every 14 days from its date).
function dueDaysInMonth(expense, year, monthIndex) {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  if (expense.frequency === "monthly") {
    const day = Number.parseInt(expense.due, 10);
    return day >= 1 && day <= 31 ? [Math.min(day, lastDay)] : [];
  }
  if (expense.frequency === "biweekly") {
    const anchor = parseIsoDate(expense.due);
    if (!anchor) return [];
    const days = [];
    for (let day = 1; day <= lastDay; day++) {
      const daysApart = Math.round((new Date(year, monthIndex, day) - anchor) / 86_400_000);
      if (((daysApart % 14) + 14) % 14 === 0) days.push(day);
    }
    return days;
  }
  return [];
}

function planPaychecks(state, weeks, year, monthIndex) {
  const plans = weeks.map(() => []);
  if (weeks.length === 0) return [];
  const everyPaycheck = (item) => plans.forEach((items) => items.push({ ...item }));

  for (const expense of state.expenses) {
    const amount = moneyOrZero(expense.amount);
    const base = { id: expense.id, name: expense.name.trim() || "Unnamed expense" };

    if (expense.frequency === "weekly") {
      everyPaycheck({ ...base, amount, when: "every" });
    } else if (expense.frequency === "yearly") {
      plans[0].push({ ...base, amount: amount / 12, when: "yearly" });
    } else if (expense.frequency === "biweekly" && !parseIsoDate(expense.due)) {
      everyPaycheck({ ...base, amount: amount / 2, when: "half" });
    } else {
      const days = dueDaysInMonth(expense, year, monthIndex);
      if (expense.frequency === "monthly" && days.length === 0) {
        plans[0].push({ ...base, amount, when: "unset" });
      }
      for (const day of days) {
        const index = weeks.reduce((found, week, i) => (week.startDay <= day ? i : found), -1);
        plans[Math.max(index, 0)].push({ ...base, amount, when: "due", dueDay: day, beforePayday: index === -1 });
      }
    }
  }

  const savings = moneyOrZero(state.savings.amount);
  if (savings > 0) {
    const item = { id: "savings", name: "Savings", amount: savings, isSavings: true };
    if (state.savings.frequency === "weekly") everyPaycheck({ ...item, when: "every" });
    else plans[0].push({ ...item, when: "monthly" });
  }

  // Dated bills first (by due day), then every-paycheck ones, savings last.
  const order = (item) => (item.isSavings ? 100 : item.when === "due" ? item.dueDay : item.when === "unset" ? 0 : 50);
  let running = 0;
  return plans.map((items, i) => {
    items.sort((a, b) => order(a) - order(b));
    const out = items.reduce((sum, item) => sum + item.amount, 0);
    const left = weeks[i].amountUsed - out;
    running += left;
    return { key: weeks[i].key, items, out, left, running };
  });
}

// Lets Node load this file for testing; browsers simply skip this line.
if (typeof module !== "undefined") {
  module.exports = { parseMoney, toMonthly, monthlyAmount, buildWeeks, resolveWeeks, calculateBudget, planPaychecks, dueDaysInMonth };
}
