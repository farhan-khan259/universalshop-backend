import mongoose from "mongoose";
import Decimal from "decimal.js";
import {
  Product,
  Party,
  Document,
  Ledger,
  Movement,
  Sequence,
  Audit,
} from "./models.js";
import { cents, line, round, sum } from "./money.js";
const bad = (s) => {
  const e = Error(s);
  e.status = 422;
  throw e;
};
const positive = (x) => {
  const n = Number(x);
  if (
    !Number.isFinite(n) ||
    n <= 0 ||
    n > 1e8 ||
    new Decimal(n).decimalPlaces() > 3
  )
    bad("Quantity must be positive with up to 3 decimal places");
  return n;
};
export async function transact(req, work) {
  let result;
  await mongoose.connection.transaction(async (session) => {
    const existing = await Document.findOne({
      tenant: req.tenant._id,
      key: req.body.key,
    }).session(session);
    if (existing) {
      result = existing;
      return;
    }
    result = await work(session);
  });
  return result;
}
export async function createDoc(req, session, data, entries = []) {
  const seq = await Sequence.findOneAndUpdate(
    { tenant: req.tenant._id },
    { $inc: { value: 1 } },
    { upsert: true, new: true, session },
  );
  const [doc] = await Document.create(
    [
      {
        ...data,
        tenant: req.tenant._id,
        key: req.body.key,
        number: `${req.tenant.settings.invoicePrefix || "INV"}-${String(seq.value).padStart(6, "0")}`,
        createdBy: req.user._id,
      },
    ],
    { session },
  );
  if (
    entries.some((e) =>
      ["debit", "credit"].some(
        (k) => e[k] !== undefined && (!Number.isSafeInteger(e[k]) || e[k] < 0),
      ),
    )
  )
    bad("Financial amount out of range");
  if (sum(entries, "debit") !== sum(entries, "credit"))
    throw Error("Journal does not balance");
  if (entries.length)
    await Ledger.insertMany(
      entries.map((e) => ({
        ...e,
        tenant: req.tenant._id,
        document: doc._id,
        date: doc.date,
        description: doc.notes || `${doc.kind} ${doc.number}`,
      })),
      { session },
    );
  await Audit.create(
    [
      {
        tenant: req.tenant._id,
        user: req.user._id,
        action: doc.kind,
        entity: doc.id,
        details: { number: doc.number, total: doc.total },
      },
    ],
    { session },
  );
  return doc;
}
function pays(b, total) {
  const a = (b.payments || []).map((p) => ({
    account: p.account,
    amount: cents(p.amount),
  }));
  if (
    a.some((x) => !["cash", "bank", "card"].includes(x.account) || x.amount < 0)
  )
    bad("Invalid payment");
  if (sum(a, "amount") > total) bad("Payment exceeds total");
  return a.filter((x) => x.amount);
}
export async function postTrade(req, kind) {
  return transact(req, async (session) => {
    const b = req.body;
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 200)
      bad("Add 1–200 products");
    const seen = new Set();
    let items = [];
    for (const input of b.items) {
      if (seen.has(input.product)) bad("Combine duplicate product lines");
      seen.add(input.product);
      const p = await Product.findOne({
        _id: input.product,
        tenant: req.tenant._id,
        active: true,
      }).session(session);
      if (!p) bad("Product not found");
      const q = positive(input.quantity);
      const rate = kind === "sale" ? p.price : cents(input.rate);
      if (rate < 0) bad("Invalid rate");
      const taxRate = kind === "sale" ? p.taxRate : Number(input.taxRate || 0);
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100)
        bad("Invalid tax rate");
      const discount = cents(input.discount);
      if (discount < 0) bad("Invalid discount");
      if (kind === "sale" && !req.tenant.settings.discounts && discount)
        bad("Discounts disabled");
      items.push({
        product: p._id,
        name: p.name,
        sku: p.sku,
        category: p.category,
        quantity: q,
        rate,
        cost: p.cost,
        extendedCost:
          kind === "sale"
            ? p.stock > 0
              ? round(new Decimal(p.inventoryValue).mul(q).div(p.stock))
              : round(new Decimal(p.cost).mul(q))
            : 0,
        ...line(q, rate, discount, taxRate, kind === "sale" && p.taxInclusive),
        taxRate,
        taxInclusive: kind === "sale" && p.taxInclusive,
        fbr: {
          hsCode: p.hsCode,
          uom: p.unit,
          saleType: p.saleType,
          sroSchedule: p.sroSchedule,
          sroItem: p.sroItem,
        },
      });
    }
    const overall = cents(b.discount);
    if (overall < 0 || overall > sum(items, "net"))
      bad("Invalid invoice discount");
    if (overall) {
      if (!req.tenant.settings.discounts) bad("Discounts disabled");
      let used = 0;
      const base = sum(items, "net");
      items = items.map((x, i) => {
        const d =
          i === items.length - 1
            ? overall - used
            : round(new Decimal(overall).mul(x.net).div(base));
        used += d;
        const n = x.net - d,
          tax = round(new Decimal(n).mul(x.taxRate).div(100));
        return { ...x, net: n, tax, total: n + tax };
      });
    }
    const total = sum(items, "total"),
      net = sum(items, "net"),
      tax = sum(items, "tax");
    const payments = pays(b, total),
      paid = sum(payments, "amount");
    let party;
    if (b.party) {
      party = await Party.findOne({
        _id: b.party,
        tenant: req.tenant._id,
        type: kind === "sale" ? "customer" : "supplier",
        active: true,
      }).session(session);
      if (!party) bad("Customer/supplier not found");
    }
    if (paid < total && !party)
      bad("Select a customer/supplier for a credit transaction");
    if (kind === "sale" && paid < total && !req.tenant.settings.creditSales)
      bad("Credit sales disabled");
    if (
      kind === "sale" &&
      party?.creditLimit > 0 &&
      party.balance + total - paid > party.creditLimit
    )
      bad("Customer credit limit exceeded");
    const cost = sum(items, "extendedCost");
    let entries = [];
    if (kind === "sale") {
      entries = [
        ...payments.map((x) => ({ account: x.account, debit: x.amount })),
        { account: "receivable", party: party?._id, debit: total - paid },
        { account: "revenue", credit: net },
        { account: "tax-payable", credit: tax },
        { account: "cogs", debit: cost },
        { account: "inventory", credit: cost },
      ];
    } else {
      entries = [
        { account: "inventory", debit: net },
        { account: "input-tax", debit: tax },
        ...payments.map((x) => ({ account: x.account, credit: x.amount })),
        { account: "payable", party: party?._id, credit: total - paid },
      ];
    }
    const doc = await createDoc(
      req,
      session,
      {
        kind,
        items,
        net,
        tax,
        total,
        cost,
        paid,
        payments,
        party: party?._id,
        partyName: party?.name || "Walk-in customer",
        notes: b.notes,
        fbrStatus:
          kind === "sale" && req.tenant.settings.fbrEnabled
            ? "Pending"
            : "Not Configured",
      },
      entries,
    );
    for (const x of items) {
      const p = await Product.findOne({
        _id: x.product,
        tenant: req.tenant._id,
      }).session(session);
      const before = p.stock;
      const delta = kind === "sale" ? -x.quantity : x.quantity;
      if (
        kind === "sale" &&
        !req.tenant.settings.negativeStock &&
        p.stock < x.quantity
      )
        bad(`Insufficient stock: ${p.name}`);
      if (kind === "purchase") {
        if (p.stock < 0) bad("Resolve negative stock before purchasing");
        p.inventoryValue += x.net;
        p.cost = round(
          new Decimal(p.inventoryValue).div(
            new Decimal(p.stock).add(x.quantity),
          ),
        );
      }
      if (kind === "sale") p.inventoryValue -= x.extendedCost;
      p.stock = new Decimal(p.stock).add(delta).toNumber();
      await p.save({ session });
      await Movement.create(
        [
          {
            tenant: req.tenant._id,
            product: p._id,
            document: doc._id,
            quantity: delta,
            before,
            after: p.stock,
            cost: p.cost,
            reason: kind,
            user: req.user._id,
          },
        ],
        { session },
      );
    }
    if (party) {
      party.balance += total - paid;
      await party.save({ session });
    }
    return doc;
  });
}
export async function postPayment(req) {
  return transact(req, async (session) => {
    const party = await Party.findOne({
      _id: req.body.party,
      tenant: req.tenant._id,
      active: true,
    }).session(session);
    if (!party) bad("Select a customer or supplier");
    const amount = cents(req.body.amount);
    if (amount <= 0 || amount > party.balance)
      bad("Payment must be positive and cannot exceed outstanding balance");
    const account = req.body.account;
    if (!["cash", "bank", "card"].includes(account)) bad("Invalid account");
    const receive = party.type === "customer";
    const entries = receive
      ? [
          { account, debit: amount },
          { account: "receivable", party: party._id, credit: amount },
        ]
      : [
          { account: "payable", party: party._id, debit: amount },
          { account, credit: amount },
        ];
    party.balance -= amount;
    await party.save({ session });
    return createDoc(
      req,
      session,
      {
        kind: "payment",
        party: party._id,
        partyName: party.name,
        total: amount,
        paid: amount,
        payments: [{ account, amount }],
        notes: req.body.notes,
      },
      entries,
    );
  });
}
export async function postExpense(req) {
  return transact(req, async (session) => {
    const amount = cents(req.body.amount);
    if (amount <= 0) bad("Amount must be positive");
    if (!["cash", "bank", "card"].includes(req.body.account))
      bad("Invalid account");
    return createDoc(
      req,
      session,
      {
        kind: "expense",
        total: amount,
        net: amount,
        paid: amount,
        category: String(req.body.category || "Other"),
        notes: String(req.body.notes || ""),
        payments: [{ account: req.body.account, amount }],
      },
      [
        { account: "expense", debit: amount },
        { account: req.body.account, credit: amount },
      ],
    );
  });
}
export async function adjustment(req) {
  return transact(req, async (session) => {
    const p = await Product.findOne({
      _id: req.body.product,
      tenant: req.tenant._id,
    }).session(session);
    if (!p) bad("Product not found");
    const delta = Number(req.body.quantity);
    if (
      !Number.isFinite(delta) ||
      !delta ||
      Math.abs(delta) > 1e8 ||
      !req.body.reason?.trim()
    )
      bad("Enter a nonzero quantity and reason");
    if (p.stock + delta < 0) bad("Adjustment would create negative stock");
    const value =
      delta < 0 && p.stock > 0
        ? round(new Decimal(p.inventoryValue).mul(Math.abs(delta)).div(p.stock))
        : round(new Decimal(Math.abs(delta)).mul(p.cost));
    const doc = await createDoc(
      req,
      session,
      { kind: "adjustment", notes: req.body.reason, total: value },
      delta > 0
        ? [
            { account: "inventory", debit: value },
            { account: "stock-gain", credit: value },
          ]
        : [
            { account: "stock-loss", debit: value },
            { account: "inventory", credit: value },
          ],
    );
    const before = p.stock;
    p.inventoryValue += delta > 0 ? value : -value;
    p.stock = new Decimal(p.stock).add(delta).toNumber();
    await p.save({ session });
    await Movement.create(
      [
        {
          tenant: req.tenant._id,
          product: p._id,
          document: doc._id,
          quantity: delta,
          before,
          after: p.stock,
          reason: req.body.reason,
          user: req.user._id,
          cost: p.cost,
        },
      ],
      { session },
    );
    return doc;
  });
}
export async function returns(req) {
  return transact(req, async (session) => {
    const original = await Document.findOne({
      _id: req.body.original,
      tenant: req.tenant._id,
      kind: { $in: ["sale", "purchase"] },
    }).session(session);
    if (!original) bad("Original invoice not found");
    if (
      ["Accepted", "Submitted", "Pending", "Retry Required"].includes(
        original.fbrStatus,
      )
    )
      bad(
        "FBR-linked return requires an authorized integrator credit-note workflow",
      );
    if (!Array.isArray(req.body.items) || !req.body.items.length)
      bad("Select items to return");
    const sale = original.kind === "sale";
    const chosen = [],
      seen = new Set();
    for (const r of req.body.items) {
      if (seen.has(r.product)) bad("Duplicate return line");
      seen.add(r.product);
      const x = original.items.find((a) => String(a.product) === r.product);
      const q = positive(r.quantity);
      if (!x || q > x.quantity - x.returned)
        bad("Return exceeds remaining quantity");
      const last = q === x.quantity - x.returned;
      const previous = await Document.find({
        tenant: req.tenant._id,
        original: original._id,
      }).session(session);
      const prior = previous
        .flatMap((d) => d.items)
        .filter((a) => String(a.product) === r.product);
      const scaled = (k) =>
        last
          ? x[k] - sum(prior, k)
          : round(new Decimal(x[k]).mul(q).div(x.quantity));
      const net = scaled("net"),
        tax = scaled("tax");
      chosen.push({
        product: x.product,
        name: x.name,
        sku: x.sku,
        category: x.category,
        quantity: q,
        rate: x.rate,
        cost: x.cost,
        extendedCost: scaled("extendedCost"),
        net,
        tax,
        total: net + tax,
        restock: r.restock !== false,
      });
      x.returned += q;
    }
    const total = sum(chosen, "total"),
      net = sum(chosen, "net"),
      tax = sum(chosen, "tax");
    let party = original.party
      ? await Party.findOne({
          _id: original.party,
          tenant: req.tenant._id,
        }).session(session)
      : null;
    const credit = Math.min(total, party?.balance || 0);
    const refund = total - credit;
    const account = req.body.account || "cash";
    if (!["cash", "bank", "card"].includes(account)) bad("Invalid account");
    const cost = sum(chosen, "extendedCost");
    const inventoryValue = sale
      ? sum(
          chosen.filter((x) => x.restock),
          "extendedCost",
        )
      : net;
    const entries = sale
      ? [
          { account: "revenue", debit: net },
          { account: "tax-payable", debit: tax },
          { account: "receivable", party: party?._id, credit },
          { account, credit: refund },
          { account: "inventory", debit: inventoryValue },
          { account: "stock-loss", debit: cost - inventoryValue },
          { account: "cogs", credit: cost },
        ]
      : [
          { account: "payable", party: party?._id, debit: credit },
          { account, debit: refund },
          { account: "inventory", credit: net },
          { account: "input-tax", credit: tax },
        ];
    const doc = await createDoc(
      req,
      session,
      {
        kind: sale ? "sale-return" : "purchase-return",
        original: original._id,
        items: chosen,
        party: party?._id,
        partyName: original.partyName,
        total,
        net,
        tax,
        cost,
        paid: refund,
        payments: refund ? [{ account, amount: refund }] : [],
        notes: req.body.notes,
      },
      entries,
    );
    for (const x of chosen) {
      const p = await Product.findOne({
        _id: x.product,
        tenant: req.tenant._id,
      }).session(session);
      if (!p) bad("Product missing");
      const before = p.stock;
      const delta = sale ? (x.restock ? x.quantity : 0) : -x.quantity;
      if (!sale && p.stock < x.quantity)
        bad("Not enough stock for supplier return");
      if (sale && x.restock) {
        p.inventoryValue += x.extendedCost;
        p.cost = round(
          new Decimal(p.inventoryValue).div(
            new Decimal(p.stock).add(x.quantity),
          ),
        );
      }
      if (!sale) {
        const remaining = p.inventoryValue - x.net;
        if (remaining < 0 || (p.stock === x.quantity && remaining !== 0))
          bad("Return valuation differs from remaining stock; review costing");
        p.inventoryValue = remaining;
        p.cost =
          p.stock > x.quantity
            ? round(
                new Decimal(remaining).div(
                  new Decimal(p.stock).sub(x.quantity),
                ),
              )
            : 0;
      }
      p.stock = new Decimal(p.stock).add(delta).toNumber();
      await p.save({ session });
      await Movement.create(
        [
          {
            tenant: req.tenant._id,
            product: p._id,
            document: doc._id,
            quantity: delta,
            before,
            after: p.stock,
            cost: p.cost,
            reason: doc.kind,
            user: req.user._id,
          },
        ],
        { session },
      );
    }
    if (party) {
      party.balance -= credit;
      await party.save({ session });
    }
    await original.save({ session });
    return doc;
  });
}
export async function reverseExpense(req) {
  return transact(req, async (session) => {
    const old = await Document.findOne({
      _id: req.body.original,
      tenant: req.tenant._id,
      kind: "expense",
      reversed: false,
    }).session(session);
    if (!old) bad("Expense already reversed or missing");
    old.reversed = true;
    await old.save({ session });
    const d = await createDoc(
      req,
      session,
      {
        kind: "expense",
        original: old._id,
        total: -old.total,
        net: -old.net,
        paid: -old.paid,
        category: old.category,
        notes: `Reversal of ${old.number}: ${req.body.reason || ""}`,
      },
      [
        { account: old.payments[0].account, debit: old.total },
        { account: "expense", credit: old.total },
      ],
    );
    return d;
  });
}
