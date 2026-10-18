import { Document, Product, Party, Ledger, Movement } from "./models.js";
import { sum } from "./money.js";
export function dates(q) {
  const f = {};
  if (q.from) {
    const d = new Date(q.from + "T00:00:00+05:00");
    if (!Number.isFinite(+d)) throw Error("Invalid start date");
    f.$gte = d;
  }
  if (q.to) {
    const d = new Date(q.to + "T23:59:59.999+05:00");
    if (!Number.isFinite(+d)) throw Error("Invalid end date");
    f.$lte = d;
  }
  return Object.keys(f).length ? { date: f } : {};
}
export async function summary(tenant, q = {}) {
  const journals = await Ledger.aggregate([
    { $match: { tenant, ...dates(q) } },
    {
      $group: {
        _id: "$account",
        debit: { $sum: "$debit" },
        credit: { $sum: "$credit" },
      },
    },
  ]);
  const accounts = Object.fromEntries(journals.map((a) => [a._id, a]));
  const net = (a) => (accounts[a]?.debit || 0) - (accounts[a]?.credit || 0);
  const sales = -net("revenue"),
    cost = net("cogs"),
    expenses = net("expense") + net("stock-loss") - net("stock-gain");
  const products = await Product.find({ tenant, active: true });
  const parties = await Party.find({ tenant, active: true });
  const docs = await Document.find({ tenant, ...dates(q) })
    .sort({ date: -1 })
    .limit(20);
  const trend = await Document.aggregate([
    { $match: { tenant, kind: { $in: ["sale", "sale-return"] }, ...dates(q) } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$date",
            timezone: "Asia/Karachi",
          },
        },
        sales: {
          $sum: {
            $cond: [
              { $eq: ["$kind", "sale"] },
              "$net",
              { $multiply: ["$net", -1] },
            ],
          },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return {
    sales,
    cost,
    grossProfit: sales - cost,
    expenses,
    netProfit: sales - cost - expenses,
    purchases: sum(
      await Document.find({ tenant, kind: "purchase", ...dates(q) }),
      "total",
    ),
    products: products.length,
    stockValue: sum(products, "inventoryValue"),
    lowStock: products.filter((x) => x.stock <= x.reorder).length,
    receivables: sum(
      parties.filter((x) => x.type === "customer"),
      "balance",
    ),
    payables: sum(
      parties.filter((x) => x.type === "supplier"),
      "balance",
    ),
    cash: net("cash"),
    bank: net("bank") + net("card"),
    cashReceived: accounts.cash?.debit || 0,
    recent: docs,
    trend,
    accounts,
  };
}
export async function report(tenant, type, q) {
  const f = { tenant, ...dates(q) };
  if (q.party) f.party = q.party;
  let rows = [];
  if (
    [
      "sales",
      "purchases",
      "sales-returns",
      "purchase-returns",
      "expenses",
    ].includes(type)
  ) {
    rows = await Document.find({
      ...f,
      kind: {
        sales: "sale",
        purchases: "purchase",
        "sales-returns": "sale-return",
        "purchase-returns": "purchase-return",
        expenses: "expense",
      }[type],
    })
      .sort({ date: -1 })
      .lean();
  } else if (
    ["stock", "valuation", "low-stock", "out-of-stock"].includes(type)
  ) {
    rows = await Product.find({ tenant, active: true }).lean();
    if (type === "low-stock") rows = rows.filter((x) => x.stock <= x.reorder);
    if (type === "out-of-stock") rows = rows.filter((x) => x.stock <= 0);
    rows = rows.map((x) => ({ ...x, value: x.inventoryValue }));
  } else if (
    ["customers", "suppliers", "receivables-aging", "payables-aging"].includes(
      type,
    )
  ) {
    const customer = type === "customers" || type === "receivables-aging";
    rows = await Party.find({
      tenant,
      type: customer ? "customer" : "supplier",
      active: true,
    }).lean();
    if (type.endsWith("aging")) {
      const all = await Document.find({
        tenant,
        kind: customer ? "sale" : "purchase",
        party: { $exists: true },
      })
        .sort({ date: -1 })
        .lean();
      rows = rows.map((p) => {
        let remaining = p.balance;
        const buckets = [0, 0, 0, 0];
        for (const d of all.filter((d) => String(d.party) === String(p._id))) {
          if (remaining <= 0) break;
          const amount = Math.min(remaining, d.total - d.paid);
          const age = (Date.now() - +d.date) / 86400000;
          buckets[age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3] += amount;
          remaining -= amount;
        }
        buckets[3] += Math.max(0, remaining);
        return {
          ...p,
          current: buckets[0],
          days31to60: buckets[1],
          days61to90: buckets[2],
          over90: buckets[3],
        };
      });
    }
  } else if (type === "movements") {
    rows = await Movement.find({
      tenant,
      ...(q.product ? { product: q.product } : {}),
      ...(q.from || q.to ? { createdAt: dates(q).date } : {}),
    })
      .populate("product", "name sku")
      .sort({ createdAt: -1 })
      .lean();
  } else if (
    [
      "cash-ledger",
      "bank-ledger",
      "customer-ledger",
      "supplier-ledger",
    ].includes(type)
  ) {
    const match = {
      tenant,
      account:
        type === "cash-ledger"
          ? "cash"
          : type === "bank-ledger"
            ? { $in: ["bank", "card"] }
            : type === "customer-ledger"
              ? "receivable"
              : "payable",
      ...(q.party ? { party: q.party } : {}),
    };
    const all = await Ledger.find(match).sort({ date: 1, _id: 1 }).lean();
    let running = 0;
    const sign = type === "supplier-ledger" ? -1 : 1;
    rows = all
      .map((x) => {
        running += sign * ((x.debit || 0) - (x.credit || 0));
        return { ...x, balance: running };
      })
      .filter(
        (x) =>
          (!f.date?.$gte || x.date >= f.date.$gte) &&
          (!f.date?.$lte || x.date <= f.date.$lte),
      );
    const opening = rows.length
      ? rows[0].balance - sign * ((rows[0].debit || 0) - (rows[0].credit || 0))
      : all
          .filter((x) => f.date?.$gte && x.date < f.date.$gte)
          .reduce((s, x) => s + sign * ((x.debit || 0) - (x.credit || 0)), 0);
    return { rows, opening, closing: rows.at(-1)?.balance ?? opening };
  } else if (type === "profit-loss") {
    const s = await summary(tenant, q);
    rows = [
      { name: "Net sales (excluding sales tax)", amount: s.sales },
      { name: "Cost of goods sold", amount: s.cost },
      { name: "Gross profit", amount: s.grossProfit },
      { name: "Operating expenses and stock losses", amount: s.expenses },
      { name: "Net profit", amount: s.netProfit },
    ];
  } else if (
    [
      "product-sales",
      "category-sales",
      "customer-sales",
      "user-sales",
      "payment-methods",
      "slow-moving",
      "fast-moving",
      "profitability",
    ].includes(type)
  ) {
    const sales = await Document.find({
      ...f,
      kind: { $in: ["sale", "sale-return"] },
    }).lean();
    const grouped = {};
    for (const d of sales) {
      const sign = d.kind === "sale" ? 1 : -1;
      const lines =
        type === "payment-methods"
          ? d.payments
          : ["customer-sales", "user-sales"].includes(type)
            ? [
                {
                  name:
                    type === "customer-sales"
                      ? d.partyName
                      : String(d.createdBy),
                  total: d.net,
                  quantity: 1,
                  cost: d.cost,
                },
              ]
            : d.items;
      for (const x of lines) {
        const name =
          type === "payment-methods"
            ? x.account
            : type === "category-sales"
              ? x.category || "Uncategorized"
              : x.name;
        const a = (grouped[name] ??= { name, quantity: 0, amount: 0, cost: 0 });
        a.quantity += sign * (x.quantity || 0);
        a.amount +=
          sign * (type === "payment-methods" ? x.amount : (x.net ?? x.total));
        a.cost += sign * (x.extendedCost ?? x.cost ?? 0);
      }
    }
    rows = Object.values(grouped)
      .map((x) => ({ ...x, profit: x.amount - x.cost }))
      .sort((a, b) =>
        type === "slow-moving" ? a.quantity - b.quantity : b.amount - a.amount,
      );
  } else throw Object.assign(Error("Unknown report"), { status: 404 });
  return { rows };
}
