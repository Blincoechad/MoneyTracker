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

// The average month has 52 weeks ÷ 12 months = 4.333… weeks.
const AVERAGE_WEEKS_PER_MONTH = 52 / 12;

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
   Any amount × (times per year) ÷ 12 = the monthly equivalent.
     $40 weekly   → 40 × 52 ÷ 12 = $173.33 / month
     $100 biweekly→ 100 × 26 ÷ 12 = $216.67 / month
     $600 yearly  → 600 × 1 ÷ 12 = $50 / month
   --------------------------------------------------------------------- */
function toMonthly(amount, frequency) {
  const timesPerYear = TIMES_PER_YEAR[frequency] ?? 12;
  return (amount * timesPerYear) / 12;
}

function monthlyExpenseTotal(expenses) {
  return expenses.reduce((total, expense) => total + toMonthly(moneyOrZero(expense.amount), expense.frequency), 0);
}

// Savings is only ever weekly or monthly, so it reuses the same converter.
function monthlySavingsTotal(savings) {
  return toMonthly(moneyOrZero(savings.amount), savings.frequency);
}

/* ---------------------------------------------------------------------
   3. WHICH WEEKS BELONG TO THIS MONTH
   Two ways to count, chosen by the user:

   "average" — the month is 4.333 weeks long, like the ×52÷12 rule.
     We track 4 real weeks (days 1–7, 8–14, 15–21, 22–end) and add the
     leftover 0.333 week at your expected rate. With no actuals entered
     this gives exactly Weekly × 52 ÷ 12.

   "paydays" — count the actual paydays that fall in this calendar month
     (some months have 4 Fridays, some have 5). No leftover fraction.
   --------------------------------------------------------------------- */
function buildWeeks(year, monthIndex, mode, paydayWeekday) {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const weeks = [];

  if (mode === "paydays") {
    for (let day = 1; day <= lastDay; day++) {
      const date = new Date(year, monthIndex, day);
      if (date.getDay() === paydayWeekday) {
        weeks.push({ key: isoDate(date), startDay: day, endDay: day, isPayday: true });
      }
    }
    return { weeks, extraWeeks: 0 };
  }

  const ranges = [[1, 7], [8, 14], [15, 21], [22, lastDay]];
  ranges.forEach(([startDay, endDay], index) => {
    weeks.push({ key: `avg-${index + 1}`, startDay, endDay, isPayday: false });
  });
  return { weeks, extraWeeks: AVERAGE_WEEKS_PER_MONTH - 4 };
}

// Which week are we in today? Weeks before this one are treated as finished.
function findCurrentWeekIndex(weeks, todayDay) {
  const index = weeks.findIndex((week) => todayDay <= week.endDay);
  return index === -1 ? weeks.length : index; // weeks.length = "month is over"
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
  const { weeks, extraWeeks } = buildWeeks(today.getFullYear(), today.getMonth(), state.weekMode, Number(state.paydayWeekday));
  const autoWeekIndex = findCurrentWeekIndex(weeks, today.getDate());
  const currentWeekIndex = state.currentWeek === "auto" ? autoWeekIndex : Math.min(Number(state.currentWeek), weeks.length);
  const weeksInMonth = weeks.length + extraWeeks; // 4.333 or the payday count

  const resolvedWeeks = resolveWeeks(weeks, state.actuals, expectedWeekly, currentWeekIndex);

  // --- Baseline (the plan, ignoring actuals) ---
  const baselineMonthlyIncome = expectedWeekly * weeksInMonth;

  // --- Projection (actuals where entered, expected everywhere else) ---
  const extraWeekIncome = extraWeeks * expectedWeekly;
  const projectedIncome = resolvedWeeks.reduce((sum, week) => sum + week.amountUsed, 0) + extraWeekIncome;
  const monthlyExpenses = monthlyExpenseTotal(state.expenses);
  const monthlySavings = monthlySavingsTotal(state.savings);
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
  const expectedStillToCome = openWeekCount * expectedWeekly + extraWeekIncome;

  // How far actual weeks are from the plan. Positive = behind, negative = ahead.
  const shortfallVsPlan = resolvedWeeks
    .filter((week) => week.status === "actual")
    .reduce((sum, week) => sum + (week.expected - week.actual), 0);

  // What the open weeks must produce so the month ends at exactly $0.
  const stillRequired = Math.max(0, requiredMonthlyIncome - incomeReceived - extraWeekIncome);

  const hasOpenWeeks = openWeekCount > 0;
  const breakEvenPerOpenWeek = hasOpenWeeks ? stillRequired / openWeekCount : null;
  const onPlanPerOpenWeek = hasOpenWeeks ? expectedWeekly + shortfallVsPlan / openWeekCount : null;
  const deficit = Math.max(0, -projectedRemaining);
  const extraPerOpenWeek = hasOpenWeeks ? deficit / openWeekCount : null;

  return {
    expectedWeekly,
    weeks: resolvedWeeks,
    extraWeeks,
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
    extraWeekIncome,
    shortfallVsPlan,
    stillRequired,
    breakEvenPerOpenWeek,
    onPlanPerOpenWeek,
    deficit,
    extraPerOpenWeek,

    expenseLines: state.expenses.map((expense) => ({
      id: expense.id,
      name: expense.name.trim() || "Unnamed expense",
      monthly: toMonthly(moneyOrZero(expense.amount), expense.frequency),
    })),
  };
}

// Lets Node load this file for testing; browsers simply skip this line.
if (typeof module !== "undefined") {
  module.exports = { parseMoney, toMonthly, buildWeeks, resolveWeeks, calculateBudget, AVERAGE_WEEKS_PER_MONTH };
}
